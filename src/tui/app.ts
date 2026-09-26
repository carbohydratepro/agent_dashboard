/**
 * アプリ本体。画面の切り替えとキーの配線（SPEC §16）。
 *
 * 端末は Terminal 抽象越しに触るので、FakeTerminal を渡せば
 * 実際の端末なしでキー操作を丸ごとテストできる。
 */

import { Screen } from './screen.ts';
import { ScreenSelection } from './selection.ts';
import type { Terminal } from './terminal.ts';
import type { Key } from './input.ts';
import { isPrintable } from './input.ts';
import type { Theme } from './theme.ts';
import { DEFAULT_THEME, STATE_LABEL_JA } from './theme.ts';
import { drawMainScreen, sessionAtRow } from './render.ts';
import { CURSOR_HIDE, CURSOR_SHOW, MOUSE_OFF, MOUSE_ON, moveTo } from './ansi.ts';
import { recentTurns } from './views/detail.ts';
import { LOCAL_COMMANDS, changeModelText, parseCommand, runLocalCommand } from '../core/local-commands.ts';
import { modelChoicesFor, readCodexModelInfo } from '../core/models.ts';
import { buildHandover } from '../core/handover.ts';
import type { CodexModelInfo } from '../core/models.ts';
import type { RecentTurn } from './views/detail.ts';
import { ResourceMonitor } from '../core/resources.ts';
import type { ResourceSample } from '../core/resources.ts';
import { drawPanel, panelMetrics } from './views/panel.ts';
import type { PanelLine } from './views/panel.ts';
import { helpLines } from './views/help.ts';
import { LogBuffer, describeEvent, logLines } from './views/log.ts';
import { layoutTextInput, TextInput } from './widgets/textinput.ts';
import { drawBox, fillRect, textCentered, textClipped, textRight, wrapText } from './paint.ts';
import { cursorPosition, dropWidth, padEnd, scrollOffsetFor } from './width.ts';
import { ROLE_LABEL, ROLES } from '../core/naming.ts';
import { analyzeSessionLog, listExistingSessions, readSessionTranscript } from '../core/sessions.ts';
import type { ExistingSession, SessionAnalysis } from '../core/sessions.ts';
import { drawImport, listHeight } from './views/import.ts';
import type { ImportPreview } from './views/import.ts';
import { createHistory, isRateLimited, currentPeriod } from '../core/analytics.ts';
import type { History } from '../core/analytics.ts';
import { drawGauge } from './paint.ts';
import { usageLines } from './views/usage.ts';
import { BUSY_STATES } from '../core/types.ts';
import { isBusy } from './animation.ts';
import type { AgentKind, Session, Role, Task } from '../core/types.ts';
import type { UsageSnapshot } from '../core/usage.ts';
import type { SessionManager } from '../core/session-manager.ts';
import type { StoreEvent } from '../core/store.ts';
import type { RecoveryCoordinator } from '../core/recovery.ts';
import type { UsageMonitor } from '../core/usage-monitor.ts';
import type { NetworkMonitor } from '../core/network.ts';
import { canSendDraft } from './views/detail.ts';
import { formatDuration, formatTokens } from './views/format.ts';
import {
  drawConversation,
  ConversationState,
  SCROLL_LINES,
  SCROLL_LINES_FAST,
} from './views/conversation.ts';
import { applyCompletion, commandPrefix, completionFor, moveSelection } from './completion.ts';
import type { CompletionState } from './completion.ts';
import { drawApproval } from './views/approval.ts';
import {
  displayActiveMs,
  displayStartedAt,
  displayStats,
  tokensPerTask,
  utilization,
} from '../core/stats.ts';

export type ScreenId =
  | 'main'
  | 'conversation'
  | 'approval'
  | 'draft'
  | 'drafts'
  | 'model'
  | 'hire'
  | 'importSession'
  | 'log'
  | 'archive'
  | 'stats'
  | 'help'
  | 'settings'
  | 'confirm';

interface ConfirmState {
  title: string;
  message: string;
  onYes: () => void;
}

interface HireField {
  key: 'mode' | 'kind' | 'role' | 'sandbox' | 'cwd';
  label: string;
}

/** 新規に雇うか、すでにある会話を引き継ぐか */
type HireMode = 'new' | 'import';

interface HireState {
  mode: HireMode;
  kind: AgentKind;
  role: Role;
  sandbox: string | null;
  cwd: TextInput;
  index: number;
}

interface ImportState {
  sessions: ExistingSession[];
  index: number;
  role: Role;
  /** 会話の中身は選んだものだけ読む。全部読むと遅い。 */
  previews: Map<string, ImportPreview>;
  /** セッション ID → 以前担当していたアーカイブ済みの名前 */
  formerBySession: Map<string, string>;
}

const SANDBOXES: Array<string | null> = [null, 'read-only', 'workspace-write', 'danger-full-access'];

export interface AppDeps {
  manager: SessionManager;
  terminal: Terminal;
  theme?: Theme;
  animate?: boolean;
  ascii?: boolean;
  now?: () => number;
  monitor?: NetworkMonitor;
  recovery?: RecoveryCoordinator;
  defaultCwd?: string;
  bell?: boolean;
  /** 保存済みのタスク履歴。復元したセッションの会話を組み立て直すのに使う（SPEC §14） */
  loadHistory?: (sessionId: string) => Task[];
  /** CLI 側の会話ログ。取り込んだセッションの全履歴を再起動後も復元する。 */
  loadAgentSession?: (kind: AgentKind, sessionId: string) => ExistingSession | null;
  /** Codex 自身が生成した会話タイトル。 */
  loadCodexThreadNames?: () => ReadonlyMap<string, string>;
  /** 起動時の警告。バナーに出す */
  warnings?: string[];
  /** 月次会計。無ければその場で作る */
  history?: History;
  monthlyBudget?: number;
  /** 使える AI 種別。CLI が見つからなかったものは外す（SPEC §19） */
  availableKinds?: AgentKind[];
  /** 使用量の取得。無ければ「取得中…」のままになる */
  usage?: UsageMonitor;
}

export class App {
  readonly manager: SessionManager;
  readonly terminal: Terminal;
  readonly theme: Theme;
  readonly log = new LogBuffer();

  screen: Screen;
  screenId: ScreenId = 'main';
  selectedRow = 0;
  frame = 0;
  expanded = false;
  running = false;
  banner: { text: string; color: number; until: number } | null = null;

  #animate: boolean;
  #ascii: boolean;
  #bellEnabled: boolean;
  #now: () => number;
  #monitor: NetworkMonitor | undefined;
  #recovery: RecoveryCoordinator | undefined;
  #defaultCwd: string;
  #loadHistory: ((sessionId: string) => Task[]) | undefined;
  #loadAgentSession: ((kind: AgentKind, sessionId: string) => ExistingSession | null) | undefined;
  #loadCodexThreadNames: (() => ReadonlyMap<string, string>) | undefined;
  #history: History;
  #monthlyBudget: number;
  #availableKinds: AgentKind[];
  #usage: UsageMonitor | undefined;
  /** ベルの連続抑制（SPEC §15.7）。3 秒以内は 1 回にまとめる。 */
  #lastBellAt = 0;
  /** false の間は端末自身にドラッグ選択を任せる（Alt+C で切り替え）。 */
  #mouseTracking = true;
  #selection: ScreenSelection | null = null;
  #copyPending = false;

  #scroll = 0;
  /** セッション履歴で選んでいるセッション */
  #archiveIndex = 0;
  /** 統計画面のターン別グラフで選んでいるセッション。 */
  #statsSessionIndex = 0;
  /** CLI ログ解析結果。ターン別グラフは永続化せず、起動時に再構築する。 */
  #analyses = new Map<string, SessionAnalysis>();
  #analysisSources = new Map<string, ExistingSession>();
  #analysisQueue: string[] = [];
  #analysisQueued = new Set<string>();
  #analysisRunning = false;
  /** stop 後に遅れて終わった解析結果を反映しないための世代番号。 */
  #analysisGeneration = 0;
  #logFilter: string | null = null;
  #confirm: ConfirmState | null = null;
  /** editing が null なら新規、あれば その控えの書き換え */
  #draft: { sessionId: string; input: TextInput; editing: string | null } | null = null;
  /** 控えの一覧で選んでいる位置 */
  #draftIndex = 0;
  /** モデル選択。stage が 'model' ならモデル、'reasoning' なら推論の深さを選んでいる。 */
  #modelPick: {
    sessionId: string;
    info: CodexModelInfo;
    stage: 'model' | 'reasoning';
    modelIndex: number;
    reasoningIndex: number;
  } | null = null;
  #hire: HireState | null = null;
  #importSession: ImportState | null = null;
  #approvalIndex = 0;
  #conversations = new Map<string, ConversationState>();
  #completionNote: string | null = null;
  /**
   * codex の config.toml の既定。指定していないセッションはこれが効く。
   * 毎フレーム読むほどのものではないので覚えておき、/model のあとだけ取り直す。
   */
  #codexDefaults: { model: string | null; effort: string | null } | null = null;
  #resourceMonitor = new ResourceMonitor();
  #resources: ResourceSample | null = null;
  #resourcesAt = 0;
  #rejectInput: TextInput | null = null;
  /** スラッシュコマンドの候補。入力に応じて作り直す。 */
  #completion: CompletionState | null = null;

  #dirty = false;
  #timer: NodeJS.Timeout | null = null;
  #unsubscribers: Array<() => void> = [];
  #exitHandlers: Array<() => void> = [];

  constructor(deps: AppDeps) {
    this.manager = deps.manager;
    this.terminal = deps.terminal;
    this.theme = deps.theme ?? DEFAULT_THEME;
    this.#animate = deps.animate ?? true;
    this.#ascii = deps.ascii ?? false;
    this.#bellEnabled = deps.bell ?? true;
    this.#now = deps.now ?? (() => Date.now());
    this.#monitor = deps.monitor;
    this.#recovery = deps.recovery;
    this.#defaultCwd = deps.defaultCwd ?? process.cwd();
    this.#loadHistory = deps.loadHistory;
    this.#loadAgentSession = deps.loadAgentSession;
    this.#loadCodexThreadNames = deps.loadCodexThreadNames;
    this.#history = deps.history ?? createHistory(this.#now());
    this.#monthlyBudget = deps.monthlyBudget ?? 20_000;
    this.#availableKinds = deps.availableKinds ?? ['claude', 'codex'];
    this.#usage = deps.usage;
    this.screen = new Screen(deps.terminal.columns, deps.terminal.rows, deps.terminal.colorMode);
    if (deps.warnings && deps.warnings.length > 0) {
      this.banner = {
        text: `! ${deps.warnings[0]}${deps.warnings.length > 1 ? ` ほか ${deps.warnings.length - 1} 件` : ''}`,
        color: this.theme.gauge.high,
        until: this.#now() + 10_000,
      };
    }
  }

  get store() {
    return this.manager.store;
  }

  get selectedSession(): Session | null {
    return sessionAtRow(this.store.dashboard, this.selectedRow);
  }

  // -------------------------------------------------------------------------

  start(): void {
    this.running = true;
    // stop → start で同じ App を再利用しても、enter() が有効にする状態と合わせる。
    this.#mouseTracking = true;
    this.#selection = null;
    this.#refreshCodexTitles();
    for (const session of this.store.dashboard.sessions) {
      // 保存済みの全期間値があれば一覧はすぐ描ける。ターン内訳は統計を開いた時に読む。
      // timedTurns がない保存データだけを再解析する。所要時間を取得できない
      // セッション（timedTurns: 0）を起動のたびに読み直さない。
      if (!session.lifetime || session.lifetime.timedTurns === undefined) {
        this.#queueSessionAnalysis(session.id);
      }
    }
    this.terminal.enter();
    this.#unsubscribers.push(this.terminal.onKey((k) => this.handleKey(k)));
    this.#unsubscribers.push(
      this.terminal.onResize(() => {
        this.#selection = null;
        this.screen.resize(this.terminal.columns, this.terminal.rows);
        this.render();
      }),
    );
    this.#unsubscribers.push(this.store.on((e) => this.#onStoreEvent(e)));

    this.#timer = setInterval(() => this.tick(), 125);
    this.#timer.unref?.();
    this.render();
  }

  stop(): void {
    this.running = false;
    this.#selection = null;
    this.#analysisGeneration += 1;
    this.#analysisQueue = [];
    this.#analysisQueued.clear();
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    for (const un of this.#unsubscribers) un();
    this.#unsubscribers = [];
    this.terminal.exit();
    for (const h of this.#exitHandlers) h();
  }

  onExit(handler: () => void): void {
    this.#exitHandlers.push(handler);
  }

  /** アニメーションの 1 コマ。タイマーから呼ばれる。 */
  tick(): void {
    // 端末で文字をドラッグ選択している間に1文字でも再描画すると、選択範囲が
    // Windows Terminal側で解除される。コピー選択モード中は状態だけ蓄え、
    // Alt+Cで戻した時にまとめて描き直す。
    if (!this.#mouseTracking || this.#selection) return;
    // 負荷は 2 秒に 1 回でいい。毎フレーム取ると自分の CPU を食う。
    const now = this.#now();
    if (this.screenId === 'main' && now - this.#resourcesAt >= 2_000) {
      this.#resourcesAt = now;
      this.#resources = this.#resourceMonitor.sample();
      this.#dirty = true;
    }
    if (this.banner && this.#now() > this.banner.until) {
      this.banner = null;
      this.#dirty = true;
    }
    if (this.#animate) {
      // 会話画面でも回す。ここで止めると、送ったあと最初の出力が来るまで
      // 画面が一切変わらず、固まったのか考えているのか分からない。
      const moving =
        this.screenId === 'main'
          ? this.store.active().some((e) => isBusy(e.state))
          : this.screenId === 'conversation' && isBusy(this.selectedSession?.state ?? 'idle');
      if (moving) {
        this.frame += 1;
        this.#dirty = true;
      }
    }
    if (this.#dirty) this.render();
  }

  #markDirty(): void {
    this.#dirty = true;
  }

  // -------------------------------------------------------------------------
  // 描画
  // -------------------------------------------------------------------------

  render(force = false): void {
    // リサイズや直接呼出しでも端末のドラッグ範囲を消さない。
    if (this.#selection || (!this.#mouseTracking && !force)) {
      this.#dirty = true;
      return;
    }
    this.#dirty = false;
    if (this.screen.width !== this.terminal.columns || this.screen.height !== this.terminal.rows) {
      this.screen.resize(this.terminal.columns, this.terminal.rows);
    }
    this.#draw();

    if (!this.#mouseTracking) {
      // 会話・詳細・ログなど、どの画面でも操作を確認できる固定フッター。
      const y = this.screen.height - 1;
      for (let x = 0; x < this.screen.width; x += 1) {
        this.screen.set(x, y, ' ', { bg: this.theme.selectionBg });
      }
      this.screen.text(1, y, 'コピー: ドラッグ → Ctrl+Shift+C   [F2 / Esc]戻る（表示停止中）', {
        fg: this.theme.text, bg: this.theme.selectionBg,
      });
      this.screen.cursor = null;
    }

    // カーソルは差分描画のあとに置く。順番を逆にすると、
    // 描画の書き出しでカーソルが動いてしまう。
    const cursor = this.screen.cursor;
    this.terminal.write(
      this.screen.render() +
        (cursor ? moveTo(cursor.x, cursor.y) + CURSOR_SHOW : CURSOR_HIDE),
    );
  }

  #draw(): void {
    const theme = this.theme;
    // 入力欄のある画面だけが置き直す。前の画面の位置を引きずらない。
    this.screen.cursor = null;
    switch (this.screenId) {
      case 'main':
        drawMainScreen(this.screen, {
          dashboard: this.store.dashboard,
          selected: this.selectedRow,
          frame: this.frame,
          now: this.#now(),
          expanded: this.expanded,
          animate: this.#animate,
          ascii: this.#ascii,
          availableKinds: this.#availableKinds,
          usage: this.#usageSnapshots(),
          theme,
          banner: this.banner,
          resources: this.#resources,
          turns: this.#turnsForSelected(),
          codexDefaults: this.#codexDefaultsOnce(),
        });
        return;

      case 'conversation': {
        const session = this.selectedSession;
        if (!session) {
          this.screenId = 'main';
          return this.#draw();
        }
        drawConversation(this.screen, {
          session,
          conversation: this.#conversationFor(session.id),
          theme,
          now: this.#now(),
          completion: this.#completion,
          completionNote: this.#completionNote,
          banner: this.banner,
          frame: this.frame,
          animate: this.#animate,
          ascii: this.#ascii,
        });
        return;
      }

      case 'approval': {
        const session = this.selectedSession;
        if (!session || session.pendingApprovals.length === 0) {
          this.screenId = 'main';
          return this.#draw();
        }
        drawApproval(this.screen, {
          session,
          index: Math.min(this.#approvalIndex, session.pendingApprovals.length - 1),
          theme,
          rejectInput: this.#rejectInput,
        });
        return;
      }

      case 'draft':
        this.#drawMainBeneath();
        this.#drawDraft();
        return;

      case 'drafts':
        this.#drawMainBeneath();
        this.#drawDrafts();
        return;

      case 'model':
        this.#drawMainBeneath();
        this.#drawModelPick();
        return;

      case 'hire':
        this.#drawMainBeneath();
        this.#drawHire();
        return;

      case 'importSession':
        this.#drawImport();
        return;

      case 'confirm':
        this.#drawMainBeneath();
        this.#drawConfirm();
        return;

      case 'help':
        drawPanel(this.screen, {
          title: 'ヘルプ',
          lines: helpLines(theme),
          scroll: this.#scroll,
          theme,
          footer: '[↑↓/PgUp/PgDn] スクロール  [Esc] 戻る',
        });
        return;

      case 'log':
        drawPanel(this.screen, {
          title: this.#logFilter
            ? `ログ — ${this.store.find(this.#logFilter)?.name ?? ''}`
            : 'ログ — すべて',
          lines: logLines(this.log.filtered(this.#logFilter), theme),
          scroll: this.#scroll,
          theme,
          footer: '[f] 絞り込み  [G] 末尾へ  [Esc] 戻る',
        });
        return;

      case 'archive': {
        const all = this.#archiveSessions();
        const selected = all[Math.min(this.#archiveIndex, all.length - 1)];
        drawPanel(this.screen, {
          title: 'セッション履歴',
          lines: this.#archiveLines(),
          scroll: this.#scroll,
          theme,
          footer: selected?.archived
            ? '[↑↓] 選ぶ  [r] 一覧に戻す  [Esc] 戻る'
            : '[↑↓] 選ぶ  [Esc] 戻る',
        });
        return;
      }

      case 'stats':
        drawPanel(this.screen, {
          title: '統計',
          lines: this.#statsLines(),
          scroll: this.#scroll,
          theme,
          footer: '[←→] セッション切替  [↑↓/PgUp/PgDn] スクロール  [Esc] 戻る',
        });
        return;

      case 'settings':
        drawPanel(this.screen, {
          title: '設定',
          lines: this.#settingsLines(),
          scroll: this.#scroll,
          theme,
          footer: '[Esc] 戻る',
        });
        return;
    }
  }

  #usageSnapshots(): Partial<Record<AgentKind, UsageSnapshot | null>> {
    return {
      claude: this.#usage?.snapshot('claude') ?? null,
      codex: this.#usage?.snapshot('codex') ?? null,
    };
  }

  #drawMainBeneath(): void {
    drawMainScreen(this.screen, {
      dashboard: this.store.dashboard,
      selected: this.selectedRow,
      frame: this.frame,
      now: this.#now(),
      expanded: this.expanded,
      animate: false,
      ascii: this.#ascii,
      availableKinds: this.#availableKinds,
      usage: this.#usageSnapshots(),
      theme: this.theme,
      banner: this.banner,
    });
  }

  /**
   * 入力に合わせて候補を作り直す。
   * 一覧は claude の system/init が返した実物だけを使い、無ければ何も出さない。
   */
  #refreshCompletion(session: Session, conv: ConversationState): void {
    this.#completionNote = null;

    // claude は本体が返してきた一覧をそのまま使う。
    // codex には本体のコマンドが無いので、ダッシュボードが答えるぶんだけ出す。
    if (session.kind === 'claude') {
      const snapshot = this.#usage?.snapshot('claude');
      const commands = snapshot?.slashCommands;
      if (!commands || commands.length === 0) {
        this.#completion = null;
        return;
      }
      this.#completion = completionFor(conv.input.value, conv.input.cursor, {
        commands,
        terminalOnly: snapshot.terminalOnlyCommands ?? [],
      });
      return;
    }

    this.#completion = completionFor(conv.input.value, conv.input.cursor, {
      commands: LOCAL_COMMANDS.map((c) => c.name),
      terminalOnly: [],
    });

    if (this.#completion && commandPrefix(conv.input.value, conv.input.cursor) !== null) {
      this.#completionNote = 'ダッシュボードが答えます（codex 本体はスラッシュコマンドを解釈しません）';
    }
  }

  /**
   * 一覧で選んでいるセッションの直近のやり取り。
   * 会話は #conversationFor が覚えているので、読み直しは初回だけ。
   */
  #codexDefaultsOnce(): { model: string | null; effort: string | null } {
    if (!this.#codexDefaults) {
      const info = readCodexModelInfo();
      this.#codexDefaults = { model: info.defaultModel, effort: info.reasoningEffort };
    }
    return this.#codexDefaults;
  }

  /** Codex の索引から生成タイトルを同期する。起動時と Codex のターン完了時だけ読む。 */
  #refreshCodexTitles(onlySessionId?: string): void {
    if (!this.#loadCodexThreadNames) return;
    let names: ReadonlyMap<string, string>;
    try {
      names = this.#loadCodexThreadNames();
    } catch {
      return;
    }
    for (const session of this.store.dashboard.sessions) {
      if (session.kind !== 'codex' || !session.agentSessionId) continue;
      if (onlySessionId && session.id !== onlySessionId) continue;
      const title = names.get(session.agentSessionId);
      if (title) this.manager.setConversationTitle(session.id, title);
    }
  }

  /**
   * ログはセッションごとに直列で読む。複数の巨大 JSONL を同時に読むと、
   * SSD とメモリを余計に使い、入力の応答も悪くなるため。
   */
  #queueSessionAnalysis(sessionId: string, source?: ExistingSession): void {
    const session = this.store.find(sessionId);
    if (!session?.agentSessionId) return;
    if (source) this.#analysisSources.set(sessionId, source);
    if (!this.#loadAgentSession && !source) return;
    if (!this.#analysisQueued.has(sessionId)) {
      this.#analysisQueued.add(sessionId);
      this.#analysisQueue.push(sessionId);
    }
    if (!this.#analysisRunning) void this.#drainAnalysisQueue(this.#analysisGeneration);
  }

  async #drainAnalysisQueue(generation: number): Promise<void> {
    if (this.#analysisRunning) return;
    this.#analysisRunning = true;
    try {
      while (this.running && generation === this.#analysisGeneration) {
        const sessionId = this.#analysisQueue.shift();
        if (!sessionId) break;
        this.#analysisQueued.delete(sessionId);
        const session = this.store.find(sessionId);
        if (!session?.agentSessionId) continue;
        try {
          const source =
            this.#analysisSources.get(sessionId) ??
            this.#loadAgentSession?.(session.kind, session.agentSessionId) ??
            null;
          if (!source) continue;
          const analysis = await analyzeSessionLog(source);
          analysis.lifetime.updatedAt = Math.max(analysis.lifetime.updatedAt, source.updatedAt);
          if (!this.running || generation !== this.#analysisGeneration || !this.store.find(sessionId)) {
            continue;
          }
          this.#analyses.set(sessionId, analysis);
          this.manager.setLifetime(sessionId, analysis.lifetime);
          this.#markDirty();
        } catch {
          // 古い・書き込み途中のログが読めなくても、従来の管理期間値で表示を続ける。
        }
        // 1 セッションごとに描画・キー入力へ制御を返す。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } finally {
      this.#analysisRunning = false;
      if (this.running && this.#analysisQueue.length > 0) {
        void this.#drainAnalysisQueue(this.#analysisGeneration);
      }
    }
  }

  #turnsForSelected(): RecentTurn[] {
    const session = this.selectedSession;
    if (!session) return [];
    return recentTurns(this.#conversationFor(session.id).entries, 6);
  }

  #conversationFor(sessionId: string): ConversationState {
    let conv = this.#conversations.get(sessionId);
    if (!conv) {
      conv = new ConversationState();
      this.#conversations.set(sessionId, conv);

      const session = this.store.find(sessionId);
      let restoredFromAgent = false;
      if (session?.agentSessionId && this.#loadAgentSession) {
        try {
          const source = this.#loadAgentSession(session.kind, session.agentSessionId);
          if (source) {
            if (!session.lifetime || source.updatedAt > session.lifetime.updatedAt) {
              this.#queueSessionAnalysis(session.id, source);
            }
            const transcript = readSessionTranscript(source, { maxItems: 1_000 });
            if (transcript.items.length > 0) {
              conv.seedFromTranscript(transcript.items, transcript.truncated);
              restoredFromAgent = true;
            }
            if (source.title && source.title !== '（内容不明）') {
              this.manager.setConversationTitle(session.id, source.title);
            }
          }
        } catch {
          // CLI ログが読めなくても、ダッシュボード自身の履歴へフォールバックする。
        }
      }

      if (!restoredFromAgent) {
        // 新規セッションや CLI ログが無い場合は、ダッシュボード側の履歴を読み戻す。
        for (const task of this.#loadHistory?.(sessionId) ?? []) {
          conv.pushUser(task.prompt);
          if (task.summary) conv.applyEvent({ t: 'text', delta: task.summary });
          if (task.status === 'interrupted') conv.pushSystem('ネットワーク切替により中断');
          if (task.status === 'cancelled') conv.pushSystem('中断しました');
        }
        if (session?.currentTask && session.currentTask.events.length > 0) {
          conv.seedFromTask(session.currentTask);
        }
      }
    }
    return conv;
  }

  /** ホイール 1 目盛りぶん送る。dir は -1 が上、+1 が下。 */
  #wheel(dir: number): void {
    const lines = SCROLL_LINES * dir;

    if (this.screenId === 'conversation') {
      const session = this.selectedSession;
      // scrollBy は「下へ送る量」を取る。上へ送るには負を渡す。
      if (session) this.#conversationFor(session.id).scrollBy(lines);
      return;
    }

    if (this.screenId === 'main') {
      // 一覧に送る行は無い。選択を動かすほうが素直。
      const seats = this.store.dashboard.slotCount;
      this.selectedRow = Math.max(0, Math.min(seats - 1, this.selectedRow + dir));
      return;
    }

    // 一覧パネル（ログ・ヘルプ・統計・履歴・設定）は共通のスクロール量を持つ
    const max = Math.max(0, this.#currentPanelLineCount() - (this.terminal.rows - 4));
    this.#scroll = Math.max(0, Math.min(max, this.#scroll + lines));
  }

  #openScreen(id: ScreenId): void {
    this.screenId = id;
    this.#scroll = 0;
    // 会話を開いたら、その結果はもう見たことにする（一覧の印を消す）
    if (id === 'conversation') {
      const session = this.selectedSession;
      if (session) this.manager.markResultSeen(session.id);
    }
  }

  // -------------------------------------------------------------------------
  // キー
  // -------------------------------------------------------------------------

  #renderSelection(): void {
    const selection = this.#selection;
    if (!selection) return;
    selection.draw(this.screen, this.theme.selectionBg, this.theme.text);
    const y = this.screen.height - 1;
    for (let x = 0; x < this.screen.width; x += 1) {
      this.screen.set(x, y, ' ', { bg: this.theme.selectionBg });
    }
    this.screen.text(1, y, `${selection.status}  [Esc]解除 / キー・ホイールで再開`, {
      fg: this.theme.text, bg: this.theme.selectionBg,
    });
    this.terminal.write(this.screen.render() + CURSOR_HIDE);
  }

  async #copySelection(selection: ScreenSelection): Promise<void> {
    const text = selection.text();
    if (!text.trim()) {
      selection.status = '空白のみのためコピーしませんでした';
      this.#renderSelection();
      return;
    }
    if (this.#copyPending) {
      selection.status = 'コピー処理中です。少し待ってCtrl+Cで再試行';
      this.#renderSelection();
      return;
    }
    this.#copyPending = true;
    selection.status = 'コピー中…';
    this.#renderSelection();
    try {
      await this.terminal.copyText(text);
      selection.status = 'コピーを送信しました（貼付けで確認できます）';
    } catch {
      selection.status = 'コピー失敗：[F2] → ドラッグ → Ctrl+Shift+C';
    } finally {
      this.#copyPending = false;
      if (this.running && this.#selection === selection) this.#renderSelection();
    }
  }

  handleKey(k: Key): void {
    // マウス報告中は通常のドラッグ選択が端末からアプリへ奪われる。
    // Shift 回避が効かない端末もあるため、どの画面からでも明示的に切り替えられるようにする。
    if (k.name === 'f2' ||
        (k.name === 'char' && k.alt && k.ch.toLowerCase() === 'c') ||
        (!this.#mouseTracking && k.name === 'escape')) {
      this.#selection = null;
      this.#mouseTracking = !this.#mouseTracking;
      this.terminal.write(this.#mouseTracking ? MOUSE_ON : MOUSE_OFF);
      if (this.#mouseTracking) {
        this.#notify('マウスホイールを有効にしました');
      } else {
        this.#setBanner(
          'コピー選択モード：ドラッグ → Ctrl+Shift+C（F2 / Esc で戻る）',
          this.theme.gauge.good,
          10_000,
        );
      }
      this.render(true);
      return;
    }

    // Ctrl+Shift+C が Ctrl+C として届いても、タスクを中断しない。
    // 貼付け・ホイール・その他キーもコピー中の画面と入力を変えない。
    if (!this.#mouseTracking) return;

    if (k.name === 'mousedown' || k.name === 'mousedrag' || k.name === 'mouseup') {
      if (k.x === undefined || k.y === undefined) return;
      if (k.name === 'mousedown') {
        if (this.#selection) {
          this.#selection = null;
          this.render();
        }
        this.#selection = new ScreenSelection(this.screen, k.x, k.y);
      } else if (this.#selection?.dragging) {
        const selection = this.#selection;
        selection.end = selection.index(k.x, k.y);
        if (k.name === 'mouseup') {
          selection.dragging = false;
          if (selection.moved) {
            void this.#copySelection(selection);
          } else {
            this.#selection = null; // 単なるクリックではコピーしない。
            this.render();
          }
        } else {
          this.#renderSelection();
        }
      }
      return;
    }

    if (this.#selection) {
      if (k.name === 'char' && k.ctrl && k.ch.toLowerCase() === 'c') {
        void this.#copySelection(this.#selection);
        return; // コピー操作をタスク中断や入力消去へ流さない。
      }
      this.#selection = null;
      if (k.name === 'escape') {
        this.render();
        return;
      }
      // 入力・スクロールはそのまま実行し、最新の会話へ戻す。
    }

    // ホイールはどの画面でも「いま見えているものを送る」。
    // 画面ごとに送り先が違うので、キーの振り分けより先にここで捌く。
    if (k.name === 'wheelup' || k.name === 'wheeldown') {
      this.#wheel(k.name === 'wheelup' ? -1 : 1);
      this.render();
      return;
    }

    switch (this.screenId) {
      case 'main':
        this.#mainKey(k);
        break;
      case 'conversation':
        this.#conversationKey(k);
        break;
      case 'approval':
        this.#approvalKey(k);
        break;
      case 'draft':
        this.#draftKey(k);
        break;
      case 'drafts':
        this.#draftsKey(k);
        break;
      case 'model':
        this.#modelKey(k);
        break;
      case 'hire':
        this.#hireKey(k);
        break;
      case 'importSession':
        this.#importKey(k);
        break;
      case 'confirm':
        this.#confirmKey(k);
        break;
      default:
        this.#panelKey(k);
        break;
    }
    this.render();
  }

  /** スクロールするだけのパネル（ヘルプ・ログ・履歴・統計・設定）の共通操作 */
  #panelKey(k: Key): void {
    const lineCount = this.#currentPanelLineCount();
    const { visibleRows, maxScroll } = panelMetrics(this.screen, lineCount);

    if (k.name === 'escape' || (k.name === 'char' && k.ch === 'q')) {
      this.#openScreen('main');
      return;
    }
    if (
      this.screenId === 'stats' &&
      (k.name === 'left' || k.name === 'right' ||
        (k.name === 'char' && (k.ch === 'h' || k.ch === 'l')))
    ) {
      const count = this.store.active().length;
      if (count > 0) {
        const direction = k.name === 'left' || (k.name === 'char' && k.ch === 'h') ? -1 : 1;
        this.#statsSessionIndex = (this.#statsSessionIndex + direction + count) % count;
        this.#scroll = 0;
        const selected = this.store.active()[this.#statsSessionIndex];
        if (selected && !this.#analyses.has(selected.id)) this.#queueSessionAnalysis(selected.id);
      }
      return;
    }
    if (k.name === 'pagedown' || (k.ctrl && k.ch === 'd')) {
      this.#scroll = Math.min(maxScroll, this.#scroll + Math.floor(visibleRows / 2));
      return;
    }
    if (k.name === 'pageup' || (k.ctrl && k.ch === 'u')) {
      this.#scroll = Math.max(0, this.#scroll - Math.floor(visibleRows / 2));
      return;
    }
    if (k.name === 'char' && k.ch === 'G') {
      this.#scroll = maxScroll;
      return;
    }
    if (k.name === 'char' && k.ch === 'g') {
      this.#scroll = 0;
      return;
    }

    // 履歴だけは行を選ぶので、上下キーを渡す
    if (this.screenId === 'archive') {
      this.#archiveKey(k);
      return;
    }

    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      this.#scroll = Math.min(maxScroll, this.#scroll + 1);
      return;
    }
    if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      this.#scroll = Math.max(0, this.#scroll - 1);
      return;
    }
    if (this.screenId === 'log' && k.name === 'char' && k.ch === 'f') {
      this.#logFilter = this.#logFilter ? null : (this.selectedSession?.id ?? null);
      this.#scroll = 0;
    }
  }

  #onStoreEvent(e: StoreEvent): void {
    this.#markDirty();

    if (e.t === 'session_added') {
      this.#conversationFor(e.session.id);
      this.#queueSessionAnalysis(e.session.id);
      return;
    }

    if (e.t === 'task_started') {
      const conv = this.#conversationFor(e.sessionId);
      if (e.task.recoveredFrom) {
        // 復帰プロンプトは長いので、そのまま出さずに区切りとして見せる
        conv.pushSystem(`再接続して続行（${new Date(e.task.startedAt).toLocaleTimeString('ja-JP')}）`);
      } else {
        conv.pushUser(e.task.prompt);
      }
      return;
    }

    if (e.t === 'task_finished') {
      // 使ったぶんが反映されるので取り直す（最短間隔は UsageMonitor 側で守る）
      const kind = this.store.find(e.sessionId)?.kind;
      if (kind) void this.#usage?.refresh(kind);
      if (kind === 'codex') this.#refreshCodexTitles(e.sessionId);
      this.#queueSessionAnalysis(e.sessionId);
      const conv = this.#conversations.get(e.sessionId);
      if (conv) {
        if (e.task.status === 'cancelled') conv.pushSystem('中断しました');
        if (e.task.status === 'interrupted') conv.pushSystem('ネットワーク切替により中断');
      }
    }

    if (e.t === 'agent_event') {
      const text = describeEvent(e.event);
      if (text) {
        this.log.push({
          at: this.#now(),
          sessionId: e.sessionId,
          sessionName: this.store.find(e.sessionId)?.name ?? '?',
          kind: 'agent',
          event: e.event,
          text,
        });
      }
      this.#conversations.get(e.sessionId)?.applyEvent(e.event);
      return;
    }

    if (e.t === 'usage_updated') {
      // codex は実際のコンテキスト窓を教えてくれる。ゲージの分母に反映する。
      const window = this.#usage?.snapshot(e.kind)?.contextWindow;
      if (window) this.manager.setContextWindow(e.kind, window);
      return;
    }

    if (e.t === 'notify') {
      this.#ring();
      if (e.reason === 'rate_limited') {
        this.#setBanner(
          'レート制限に達しました。解除されるまで新しい実行はできません。',
          this.theme.gauge.critical,
          10_000,
        );
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // ダイアログとパネルの中身
  // -------------------------------------------------------------------------

  #drawConfirm(): void {
    const c = this.#confirm;
    if (!c) {
      this.screenId = 'main';
      return;
    }
    const theme = this.theme;
    const w = Math.min(64, this.screen.width - 8);
    const lines = wrapText(c.message, w - 4);
    const h = lines.length + 6;
    const x = Math.floor((this.screen.width - w) / 2);
    const y = Math.floor((this.screen.height - h) / 2);

    drawBox(this.screen, x, y, w, h, {
      style: { fg: theme.accent, bg: theme.panelBg },
      title: c.title,
      titleStyle: { fg: theme.accent, bg: theme.panelBg, bold: true },
      fill: theme.panelBg,
    });
    for (let i = 0; i < lines.length; i += 1) {
      textClipped(this.screen, x + 2, y + 2 + i, w - 4, lines[i]!, {
        fg: theme.text,
        bg: theme.panelBg,
      });
    }
    textCentered(this.screen, x, y + h - 2, w, '[y] 実行    [n / Esc] やめる', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
  }

  /** モデルの選択画面。 */
  #drawModelPick(): void {
    const pick = this.#modelPick;
    const session = pick ? this.store.find(pick.sessionId) : null;
    if (!pick || !session) {
      this.screenId = 'conversation';
      return;
    }
    const theme = this.theme;
    const model = pick.info.choices[pick.modelIndex]!;
    const choosingModel = pick.stage === 'model';
    const rows = choosingModel ? pick.info.choices.length : model.reasoningLevels.length;

    const w = Math.min(88, this.screen.width - 8);
    const h = Math.min(this.screen.height - 4, rows + 7);
    const x = Math.floor((this.screen.width - w) / 2);
    const y = Math.floor((this.screen.height - h) / 2);

    drawBox(this.screen, x, y, w, h, {
      style: { fg: theme.accent, bg: theme.panelBg },
      title: choosingModel ? `モデル — ${session.name}` : `推論の深さ — ${model.slug}`,
      titleStyle: { fg: theme.accent, bg: theme.panelBg, bold: true },
      fill: theme.panelBg,
    });

    const current = session.modelOverride ?? session.model ?? pick.info.defaultModel;
    textClipped(
      this.screen,
      x + 2,
      y + 1,
      w - 4,
      choosingModel
        ? `いま: ${current ?? '（既定）'}   * が現在の設定`
        : `${model.description || model.displayName}`,
      { fg: theme.textDim, bg: theme.panelBg },
    );

    const nowEffort = session.reasoningOverride ?? pick.info.reasoningEffort;
    for (let i = 0; i < rows && y + 3 + i < y + h - 2; i += 1) {
      const selected = i === (choosingModel ? pick.modelIndex : pick.reasoningIndex);
      const bg = selected ? theme.rowAlt : theme.panelBg;
      const top = y + 3 + i;
      fillRect(this.screen, x + 1, top, w - 2, 1, bg);

      const slug = choosingModel ? pick.info.choices[i]!.slug : model.reasoningLevels[i]!.effort;
      const desc = choosingModel
        ? pick.info.choices[i]!.description || pick.info.choices[i]!.displayName
        : model.reasoningLevels[i]!.description;
      const isCurrent = choosingModel ? slug === current : slug === nowEffort;

      this.screen.text(x + 2, top, selected ? '▸' : ' ', { fg: theme.accent, bg, bold: true });
      this.screen.text(x + 4, top, isCurrent ? '*' : ' ', { fg: theme.gauge.good, bg, bold: true });
      this.screen.text(x + 6, top, padEnd(slug, 16), {
        fg: selected ? theme.textBright : theme.text,
        bg,
        bold: selected,
      });
      textClipped(this.screen, x + 23, top, w - 25, desc, { fg: theme.textDim, bg });
    }

    textCentered(
      this.screen,
      x + 1,
      y + h - 2,
      w - 2,
      choosingModel && model.reasoningLevels.length > 0
        ? '[↑↓] 選ぶ   [Enter] 深さも選ぶ   [Tab] これで決める   [Esc] やめる'
        : '[↑↓] 選ぶ   [Enter] 決める   [Esc] 戻る',
      { fg: theme.textDim, bg: theme.panelBg },
    );
  }

  /** 控えの一覧。選んで送る。 */
  #drawDrafts(): void {
    const session = this.selectedSession;
    if (!session || session.drafts.length === 0) {
      this.screenId = 'main';
      return;
    }
    const theme = this.theme;
    const w = Math.min(88, this.screen.width - 8);
    const rows = Math.min(session.drafts.length, 12);
    const h = rows + 6;
    const x = Math.floor((this.screen.width - w) / 2);
    const y = Math.floor((this.screen.height - h) / 2);

    drawBox(this.screen, x, y, w, h, {
      style: { fg: theme.accent, bg: theme.panelBg },
      title: `次に送るプロンプト — ${session.name}`,
      titleStyle: { fg: theme.accent, bg: theme.panelBg, bold: true },
      fill: theme.panelBg,
    });

    const busy = BUSY_STATES.has(session.state);
    textClipped(
      this.screen,
      x + 2,
      y + 1,
      w - 4,
      busy ? `${session.name} は実行中です。終わってから送れます。` : '選んだものだけを送ります。',
      { fg: busy ? theme.gauge.high : theme.textDim, bg: theme.panelBg },
    );

    // 選択が見えるように窓をずらす
    const start = Math.max(0, Math.min(this.#draftIndex - rows + 1, session.drafts.length - rows));
    for (let i = 0; i < rows; i += 1) {
      const draft = session.drafts[start + i];
      if (!draft) break;
      const selected = start + i === this.#draftIndex;
      const bg = selected ? theme.rowAlt : theme.panelBg;
      const top = y + 3 + i;

      fillRect(this.screen, x + 1, top, w - 2, 1, bg);
      this.screen.text(x + 2, top, selected ? '▸ ' : '  ', {
        fg: theme.accent,
        bg,
        bold: true,
      });
      // 1 件 1 行。全文は [e] で開けば見える。
      textClipped(this.screen, x + 4, top, w - 6, draft.text.replace(/\s+/g, ' ').trim(), {
        fg: selected ? theme.textBright : theme.text,
        bg,
      });
    }

    if (session.drafts.length > rows) {
      textRight(this.screen, x, y + h - 3, w - 2, `${this.#draftIndex + 1}/${session.drafts.length}`, {
        fg: theme.textDim,
        bg: theme.panelBg,
      });
    }

    textCentered(
      this.screen,
      x + 1,
      y + h - 2,
      w - 2,
      '[↑↓] 選ぶ   [Enter] 送る   [e] 直す   [n] 足す   [d] 消す   [Esc] 閉じる',
      { fg: theme.textDim, bg: theme.panelBg },
    );
  }

  #drawDraft(): void {
    const state = this.#draft;
    const session = state ? this.store.find(state.sessionId) : null;
    if (!state || !session) {
      this.screenId = 'main';
      return;
    }
    const theme = this.theme;
    const w = Math.min(80, this.screen.width - 8);
    const h = Math.max(8, Math.min(18, this.screen.height - 4));
    const x = Math.floor((this.screen.width - w) / 2);
    const y = Math.floor((this.screen.height - h) / 2);

    drawBox(this.screen, x, y, w, h, {
      style: { fg: theme.accent, bg: theme.panelBg },
      title: `次に送るプロンプト — ${session.name}`,
      titleStyle: { fg: theme.accent, bg: theme.panelBg, bold: true },
      fill: theme.panelBg,
    });
    textClipped(this.screen, x + 2, y + 1, w - 4, '実行が終わったら、この内容をそのまま送れます。', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });

    const visibleRows = h - 5;
    const layout = layoutTextInput(state.input.value, state.input.cursor, w - 4);
    const start = Math.max(
      0,
      Math.min(layout.cursorLine - visibleRows + 1, layout.lines.length - visibleRows),
    );
    const end = Math.min(layout.lines.length, start + visibleRows);
    if (layout.lines.length > visibleRows) {
      textRight(this.screen, x + 2, y + 2, w - 4, `入力 ${start + 1}–${end}/${layout.lines.length}`, {
        fg: theme.textDim,
        bg: theme.panelBg,
      });
    }

    for (let i = 0; i < visibleRows; i += 1) {
      const line = layout.lines[start + i];
      if (line === undefined) break;
      textClipped(this.screen, x + 2, y + 3 + i, w - 4, line, {
        fg: theme.text,
        bg: theme.panelBg,
      });
    }
    this.screen.cursor = {
      x: Math.min(x + 2 + layout.cursorColumn, x + w - 2),
      y: y + 3 + Math.max(0, layout.cursorLine - start),
    };

    textCentered(this.screen, x, y + h - 2, w, '[Enter] 保存    [Ctrl+J] 改行    [Esc] 取消', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
  }

  #hireFields(): HireField[] {
    const fields: HireField[] = [{ key: 'mode', label: '追加方法' }];
    // 取り込みでは種別も作業場所も、元の会話のほうで決まっている
    if (this.#hire?.mode === 'import') {
      fields.push({ key: 'role', label: '役割' });
      return fields;
    }
    fields.push({ key: 'kind', label: 'CLI' }, { key: 'role', label: '役割' });
    if (this.#hire?.kind === 'codex') fields.push({ key: 'sandbox', label: 'サンドボックス' });
    fields.push({ key: 'cwd', label: '作業ディレクトリ' });
    return fields;
  }

  #drawHire(): void {
    const s = this.#hire;
    if (!s) {
      this.screenId = 'main';
      return;
    }
    const theme = this.theme;
    const fields = this.#hireFields();
    const w = Math.min(80, this.screen.width - 8);
    const h = fields.length + 8;
    const x = Math.floor((this.screen.width - w) / 2);
    const y = Math.floor((this.screen.height - h) / 2);

    drawBox(this.screen, x, y, w, h, {
      style: { fg: theme.accent, bg: theme.panelBg },
      title: 'セッションを追加',
      titleStyle: { fg: theme.accent, bg: theme.panelBg, bold: true },
      fill: theme.panelBg,
    });

    const valueX = x + 21;
    const valueWidth = w - 23;

    for (let i = 0; i < fields.length; i += 1) {
      const field = fields[i]!;
      const selected = i === s.index;
      textClipped(this.screen, x + 2, y + 2 + i, 18, `${selected ? '▶ ' : '  '}${field.label}`, {
        fg: selected ? theme.accent : theme.textDim,
        bg: theme.panelBg,
        bold: selected,
      });

      if (field.key === 'cwd') {
        const pos = cursorPosition(s.cwd.value, s.cwd.cursor);
        const offset = selected ? scrollOffsetFor(pos.column, valueWidth - 1) : 0;
        textClipped(this.screen, valueX, y + 2 + i, valueWidth, dropWidth(s.cwd.value, offset), {
          fg: selected ? theme.textBright : theme.text,
          bg: theme.panelBg,
        });
        if (selected) {
          if (offset > 0) {
            this.screen.set(valueX - 1, y + 2 + i, '‹', { fg: theme.textDim, bg: theme.panelBg });
          }
          this.screen.cursor = {
            x: Math.min(valueX + pos.column - offset, valueX + valueWidth - 1),
            y: y + 2 + i,
          };
        }
        continue;
      }

      const value =
        field.key === 'mode'
          ? s.mode === 'new'
            ? '新規に作る'
            : '既存の会話を取り込む'
          : field.key === 'kind'
            ? s.kind
            : field.key === 'role'
              ? ROLE_LABEL[s.role]
              : (s.sandbox ?? 'CLI の既定に従う');
      textClipped(this.screen, valueX, y + 2 + i, valueWidth, value, {
        fg: selected ? theme.textBright : theme.text,
        bg: theme.panelBg,
      });
    }

    textClipped(
      this.screen,
      x + 2,
      y + h - 4,
      w - 4,
      s.mode === 'import'
        ? '端末で直接始めた会話も取り込めます。Enter で一覧を出します。'
        : s.kind === 'codex'
          ? 'サンドボックスは作成時に固定され、以後変更できません。'
          : 'モデルと権限モードは CLI の設定に従います。',
      { fg: theme.textDim, bg: theme.panelBg },
    );
    textCentered(this.screen, x, y + h - 2, w, '[←→] 値を変える  [↑↓] 項目  [Enter] 決定  [Esc] 取消', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
  }

  #archiveSessions(): Session[] {
    return [...this.store.dashboard.sessions].sort(
      (a, b) => displayStats(b).tasksCompleted - displayStats(a).tasksCompleted,
    );
  }

  #archiveLines(): PanelLine[] {
    const theme = this.theme;
    const lines: PanelLine[] = [];
    const all = this.#archiveSessions();
    const selected = all[Math.min(this.#archiveIndex, all.length - 1)];
    const now = this.#now();

    for (const session of all) {
      const st = displayStats(session);
      const isSelected = session === selected;
      lines.push({
        text: `${isSelected ? '▶ ' : '  '}${session.name}  ${session.kind}  ${ROLE_LABEL[session.role]}  ${session.archived ? '（アーカイブ）' : STATE_LABEL_JA[session.state]}`,
        color: isSelected ? theme.accent : session.archived ? theme.textDim : theme.textBright,
        bold: isSelected || !session.archived,
      });
      lines.push({
        text: `完了 ${st.tasksCompleted}  失敗 ${st.tasksFailed}  中断 ${st.tasksInterrupted}  編集 ${st.filesEdited}  実行 ${st.commandsRun}  サブ ${st.subagentsSpawned}  承認 ${st.approvalsGranted}/${st.approvalsRequested}  復帰 ${st.reconnects}`,
        color: theme.textDim,
        indent: 2,
      });
      lines.push({
        text: `経過 ${formatDuration(now - displayStartedAt(session))}  実働 ${formatDuration(displayActiveMs(session))}  トークン ${formatTokens(st.totalTokensIn + st.totalTokensOut)}  ${session.workspace.requestedCwd}`,
        color: theme.textDim,
        indent: 2,
      });
      lines.push({ text: '' });
    }
    if (lines.length === 0) {
      lines.push({ text: 'まだセッションがありません。', color: theme.textDim });
    }
    return lines;
  }

  #statsLines(): PanelLine[] {
    const theme = this.theme;
    const now = this.#now();
    const active = this.store.active();
    const period = currentPeriod(this.#history, this.store.dashboard.sessions);

    const lines: PanelLine[] = [
      { text: `${period.month} の集計`, color: theme.accent, bold: true },
      {
        text: `セッション ${period.sessionCount}   完了 ${period.tasksCompleted}   失敗 ${period.tasksFailed}   トークン ${formatTokens(period.tokensIn + period.tokensOut)}（in ${formatTokens(period.tokensIn)} / out ${formatTokens(period.tokensOut)}）`,
        color: theme.text,
        indent: 1,
      },
      { text: '' },
      { text: 'セッションごと（CLI セッション開始から）', color: theme.accent, bold: true },
    ];

    for (const session of active) {
      const st = displayStats(session);
      const elapsed = Math.max(1, now - displayStartedAt(session));
      const activeMs = displayActiveMs(session);
      const perTask = tokensPerTask(st);
      lines.push({
        text: `${padEnd(session.name, 14)} 完了 ${String(st.tasksCompleted).padStart(3)}   稼働率 ${String(Math.round(utilization(activeMs, elapsed) * 100)).padStart(3)}%   トークン ${formatTokens(st.totalTokensIn + st.totalTokensOut)}   1 タスク ${perTask ?? '—'}`,
        color: theme.text,
        indent: 1,
      });
    }
    if (active.length === 0) {
      lines.push({ text: 'まだセッションがありません。', color: theme.textDim, indent: 1 });
    }

    if (active.length > 0) {
      this.#statsSessionIndex = Math.max(0, Math.min(this.#statsSessionIndex, active.length - 1));
      const selected = active[this.#statsSessionIndex]!;
      const analysis = this.#analyses.get(selected.id);
      lines.push({ text: '' });
      lines.push({
        text: `会話ごとの消費トークン — ${selected.name}（${this.#statsSessionIndex + 1}/${active.length}）`,
        color: theme.accent,
        bold: true,
      });
      if (!analysis) {
        lines.push({ text: 'CLI ログを解析しています…', color: theme.textDim, indent: 1 });
      } else if (analysis.turns.length === 0) {
        lines.push({ text: 'トークン情報のある会話はありません。', color: theme.textDim, indent: 1 });
      } else {
        const max = Math.max(1, ...analysis.turns.map((turn) => turn.tokens.totalTokens));
        const barWidth = Math.max(8, Math.min(24, this.screen.width - 62));
        for (const turn of analysis.turns) {
          const filled = turn.tokens.totalTokens > 0
            ? Math.max(1, Math.round((turn.tokens.totalTokens / max) * barWidth))
            : 0;
          const bar = this.#ascii
            ? `${'#'.repeat(filled)}${'-'.repeat(barWidth - filled)}`
            : `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
          lines.push({
            text: `#${String(turn.index).padStart(2, '0')} ${bar} ${formatTokens(turn.tokens.totalTokens).padStart(7)}  ${turn.complete ? '' : '（進行中）'}${turn.label}`,
            color: turn.complete ? theme.text : theme.gauge.warn,
            indent: 1,
          });
          const cache = turn.tokens.cachedInputTokens > 0
            ? ` / cache ${turn.tokens.cachedInputTokens.toLocaleString('en-US')}`
            : '';
          const reasoning = turn.tokens.reasoningTokens > 0
            ? ` / reasoning ${turn.tokens.reasoningTokens.toLocaleString('en-US')}`
            : '';
          lines.push({
            text: `in ${turn.tokens.inputTokens.toLocaleString('en-US')} / out ${turn.tokens.outputTokens.toLocaleString('en-US')}${cache}${reasoning} / ${formatDuration(turn.durationMs)}`,
            color: theme.textDim,
            indent: 5,
          });
        }
      }
    }

    lines.push({ text: '' });
    lines.push({ text: 'AI の使用量（実測値）', color: theme.accent, bold: true });
    for (const line of usageLines({
      theme,
      now,
      snapshots: this.#usageSnapshots(),
      availableKinds: this.#availableKinds,
    })) {
      lines.push({
        text: line,
        color: line.startsWith('  ') ? theme.text : theme.textBright,
        bold: !line.startsWith('  '),
        indent: 1,
      });
    }

    const rl = this.store.dashboard.rateLimit;
    if (rl) {
      lines.push({ text: '' });
      lines.push({ text: '枠のリセット', color: theme.accent, bold: true });
      lines.push({
        text: `${isRateLimited(rl, now) ? '制限中' : '通常'}   あと ${formatDuration(Math.max(0, rl.resetsAt * 1000 - now))}   枠 ${rl.rateLimitType}`,
        color: isRateLimited(rl, now) ? theme.gauge.critical : theme.text,
        indent: 1,
      });
    }

    if (this.#history.records.length > 0) {
      lines.push({ text: '' });
      lines.push({ text: '過去の月', color: theme.accent, bold: true });
      for (const m of [...this.#history.records].reverse().slice(0, 12)) {
        lines.push({
          text: m.idle
            ? `${m.month}   起動なし`
            : `${m.month}   完了 ${String(m.tasksCompleted).padStart(3)}   トークン ${formatTokens(m.tokensIn + m.tokensOut)}   セッション ${m.sessionCount}`,
          color: m.idle ? theme.textDim : theme.text,
          indent: 1,
        });
      }
    }
    return lines;
  }

  #settingsLines(): PanelLine[] {
    const theme = this.theme;
    const c = this.manager.config;
    return [
      { text: '設定ファイル: ~/.agent-dashboard/config.json', color: theme.textDim },
      { text: '' },
      { text: `スロット数              ${this.store.dashboard.slotCount}`, color: theme.text },
      { text: `コンテキスト窓          ${c.contextWindow.toLocaleString('en-US')}`, color: theme.text },
      { text: `逼迫とみなす比率        ${Math.round(c.contextRestThreshold * 100)}%`, color: theme.text },
      { text: `常に許可するツール      ${c.alwaysAllowedTools.join(', ') || '（なし）'}`, color: theme.text },
      { text: `既定の作業ディレクトリ  ${c.defaultCwd}`, color: theme.text },
      { text: `同じディレクトリの実行  ${c.serializeByCwd ? '順番待ち' : '並行実行'}`, color: theme.text },
      { text: '' },
      { text: 'この画面は現在の値を確認するためのものです。', color: theme.textDim },
      { text: '変更は設定ファイルを編集して再起動してください。', color: theme.textDim },
    ];
  }

  /** 3 秒以内に重なったベルはまとめる */
  #ring(): void {
    if (!this.#bellEnabled) return;
    const now = this.#now();
    if (now - this.#lastBellAt < 3_000) return;
    this.#lastBellAt = now;
    this.terminal.bell();
  }

  #setBanner(text: string, color: number, ms = 5_000): void {
    this.banner = { text, color, until: this.#now() + ms };
    this.#markDirty();
  }

  #notify(text: string, color = this.theme.textDim): void {
    this.#setBanner(text, color, 3_000);
  }

  /** セッション履歴の選択と復元（SPEC §7.3） */
  #archiveKey(k: Key): void {
    const all = this.#archiveSessions();
    if (all.length === 0) return;

    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      this.#archiveIndex = Math.min(all.length - 1, this.#archiveIndex + 1);
      // 1 人あたり 4 行なので、選択が見えるようにスクロールを合わせる
      this.#scroll = Math.max(0, this.#archiveIndex * 4 - 2);
      return;
    }
    if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      this.#archiveIndex = Math.max(0, this.#archiveIndex - 1);
      this.#scroll = Math.max(0, this.#archiveIndex * 4 - 2);
      return;
    }
    if (k.name === 'char' && k.ch === 'r') {
      const session = all[Math.min(this.#archiveIndex, all.length - 1)];
      if (!session?.archived) return;
      try {
        const back = this.manager.unarchiveSession(session.id);
        this.selectedRow = back.slot;
        this.#openScreen('main');
        this.#notify(
          `${back.name} を一覧に戻しました`,
          this.theme.gauge.good,
        );
      } catch (err) {
        this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
      }
    }
  }

  #currentPanelLineCount(): number {
    switch (this.screenId) {
      case 'help':
        return helpLines(this.theme).length;
      case 'log':
        return this.log.filtered(this.#logFilter).length;
      case 'archive':
        return this.#archiveLines().length;
      case 'stats':
        return this.#statsLines().length;
      case 'settings':
        return this.#settingsLines().length;
      default:
        return 0;
    }
  }

  #mainKey(k: Key): void {
    const seats = this.store.dashboard.slotCount;

    if (k.ctrl && k.ch === 'l') {
      this.screen.invalidate();
      return;
    }
    if (k.ctrl && k.ch === 'c') {
      const session = this.selectedSession;
      if (session && this.manager.isRunning(session.id)) {
        this.manager.interrupt(session.id, 'user');
        this.#notify(`${session.name} の作業を中断しました`);
      }
      return;
    }

    if (k.name === 'left' || k.name === 'up' || (k.name === 'char' && (k.ch === 'h' || k.ch === 'k'))) {
      this.selectedRow = (this.selectedRow - 1 + seats) % seats;
      return;
    }
    if (k.name === 'right' || k.name === 'down' || (k.name === 'char' && (k.ch === 'l' || k.ch === 'j'))) {
      this.selectedRow = (this.selectedRow + 1) % seats;
      return;
    }
    if (k.name === 'tab' || k.name === 'backtab') {
      this.#cycleSession(k.name === 'tab' ? 1 : -1);
      return;
    }
    if (k.name === 'char' && /^[1-9]$/.test(k.ch)) {
      const n = Number(k.ch) - 1;
      if (n < seats) this.selectedRow = n;
      return;
    }

    if (k.name === 'enter') {
      this.#activateSeat();
      return;
    }
    if (k.name === 'char' && k.ch === ' ') {
      this.expanded = !this.expanded;
      return;
    }

    if (k.name === 'char') {
      switch (k.ch) {
        case 'e':
          this.#openDraft();
          return;
        case 'p':
          this.#openDrafts();
          return;
        case 'N':
          this.#handOver();
          return;
        case 'n':
          this.#openHire();
          return;
        case 'X':
          this.#askRetire();
          return;
        case 'c':
          this.#compact();
          return;
        case 'R':
          this.#reconnect(k.shift);
          return;
        case 'L':
          this.#openScreen('log');
          return;
        case 'a':
          this.#archiveIndex = 0;
          this.#openScreen('archive');
          return;
        case 's':
          this.#statsSessionIndex = Math.max(
            0,
            this.store.active().findIndex((session) => session.id === this.selectedSession?.id),
          );
          {
            const selected = this.store.active()[this.#statsSessionIndex];
            if (selected && !this.#analyses.has(selected.id)) this.#queueSessionAnalysis(selected.id);
          }
          this.#openScreen('stats');
          return;
        case ',':
          this.#openScreen('settings');
          return;
        case '?':
          this.#openScreen('help');
          return;
        case 'q':
          this.#askQuit();
          return;
        default:
          return;
      }
    }
  }

  #cycleSession(dir: number): void {
    const seats = this.store.dashboard.slotCount;
    // 稼働中を優先して巡回する（SPEC §16）
    const order: number[] = [];
    for (let i = 1; i <= seats; i += 1) {
      order.push((this.selectedRow + dir * i + seats * seats) % seats);
    }
    const busy = order.find((seat) => {
      const session = sessionAtRow(this.store.dashboard, seat);
      return session !== null && BUSY_STATES.has(session.state);
    });
    const occupied = order.find((seat) => sessionAtRow(this.store.dashboard, seat) !== null);
    this.selectedRow = busy ?? occupied ?? this.selectedRow;
  }

  #activateSeat(): void {
    const session = this.selectedSession;
    if (!session) {
      this.#openHire();
      return;
    }
    if (session.pendingApprovals.length > 0) {
      this.#approvalIndex = 0;
      this.#rejectInput = null;
      this.#openScreen('approval');
      return;
    }
    // 控えがあっても Enter では送らない。会話を開くだけ。
    // 作業が終わったところで別のことを頼みたくなるのが普通で、
    // 勝手に次が出て行くと取り消せない。送るのは [p] で選んだときだけ。
    this.#completion = null;
    this.#openScreen('conversation');
  }

  /** 控えを 1 件書く。editing を渡すとその中身を直す。 */
  #openDraft(editing: string | null = null): void {
    const session = this.selectedSession;
    if (!session) return;
    const input = new TextInput();
    if (editing) {
      const draft = session.drafts.find((d) => d.id === editing);
      if (!draft) return;
      input.setValue(draft.text);
    }
    this.#draft = { sessionId: session.id, input, editing };
    this.#openScreen('draft');
  }

  /** モデルの選択画面。名前を覚えていなくても選べるように。 */
  #openModelPick(session: Session): void {
    const info = readCodexModelInfo();
    if (info.choices.length === 0) {
      this.#notify(info.error ?? 'モデルの一覧が取れませんでした', this.theme.gauge.high);
      return;
    }
    const current = session.modelOverride ?? session.model ?? info.defaultModel;
    // いま使っているものがキャッシュから消えていることがある。必ず選べるようにする。
    const choices = modelChoicesFor(info, current);
    const at = choices.findIndex((c) => c.slug === current);
    this.#modelPick = {
      sessionId: session.id,
      info: { ...info, choices },
      stage: 'model',
      modelIndex: at < 0 ? 0 : at,
      reasoningIndex: 0,
    };
    this.#openScreen('model');
  }

  #modelKey(k: Key): void {
    const pick = this.#modelPick;
    const session = pick ? this.store.find(pick.sessionId) : null;
    if (!pick || !session) {
      this.#openScreen('conversation');
      return;
    }
    const model = pick.info.choices[pick.modelIndex]!;
    const levels = model.reasoningLevels;
    const list = pick.stage === 'model' ? pick.info.choices : levels;
    const indexKey = pick.stage === 'model' ? 'modelIndex' : 'reasoningIndex';

    if (k.name === 'escape') {
      // 深さを選んでいる途中なら、モデルの選択に戻る
      if (pick.stage === 'reasoning') {
        pick.stage = 'model';
        return;
      }
      this.#modelPick = null;
      this.#openScreen('conversation');
      return;
    }
    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      pick[indexKey] = Math.min(list.length - 1, pick[indexKey] + 1);
      return;
    }
    if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      pick[indexKey] = Math.max(0, pick[indexKey] - 1);
      return;
    }
    if (k.name === 'enter') {
      if (pick.stage === 'model' && levels.length > 0) {
        // 深さを選べるモデルなら、続けて選ばせる
        const now = session.reasoningOverride ?? pick.info.reasoningEffort;
        const at = levels.findIndex((r) => r.effort === now);
        pick.reasoningIndex = at < 0 ? Math.max(0, levels.findIndex((r) => r.effort === model.defaultReasoning)) : at;
        pick.stage = 'reasoning';
        return;
      }
      this.#applyModelPick(session, model.slug, levels[pick.reasoningIndex]?.effort ?? null);
      return;
    }
    // 深さは選ばずモデルだけ決めたいとき
    if (k.name === 'tab' && pick.stage === 'model') {
      this.#applyModelPick(session, model.slug, null);
      return;
    }
  }

  #applyModelPick(session: Session, slug: string, effort: string | null): void {
    session.modelOverride = slug;
    session.reasoningOverride = effort;
    this.#codexDefaults = null;
    const info = this.#modelPick?.info;
    this.#modelPick = null;

    const conv = this.#conversationFor(session.id);
    for (const line of changeModelText(slug, effort, info ?? readCodexModelInfo()).split('\n')) {
      conv.pushSystem(line);
    }
    conv.scrollToBottom();
    this.#openScreen('conversation');
  }

  /** 控えの一覧。選んで送る／直す／消す。 */
  #openDrafts(): void {
    const session = this.selectedSession;
    if (!session) return;
    if (session.drafts.length === 0) {
      this.#openDraft();
      return;
    }
    this.#draftIndex = Math.min(this.#draftIndex, session.drafts.length - 1);
    this.#openScreen('drafts');
  }

  /**
   * いまのセッションを畳んで、経緯を引き継いだ新しいセッションに移る。
   *
   * 同じスレッドを続けるほど 1 ターンで送り直す量が増える。移れば下地から
   * 始め直せる。引き継ぎ文は手元のタスク履歴から作るのでモデルを呼ばない。
   *
   * 送信まではしない。入力欄に入れて渡すので、中身を見てから送れる。
   */
  #handOver(): void {
    const session = this.selectedSession;
    if (!session) return;
    if (BUSY_STATES.has(session.state)) {
      this.#notify(`${session.name} は実行中です`, this.theme.gauge.high);
      return;
    }

    const text = buildHandover(this.#loadHistory?.(session.id) ?? [], {
      cwd: session.workspace.requestedCwd,
    });
    if (text === '') {
      this.#notify('引き継ぐやり取りがまだありません', this.theme.gauge.high);
      return;
    }

    try {
      const next = this.manager.createSession({
        kind: session.kind,
        cwd: session.workspace.requestedCwd,
        role: session.role,
        model: session.modelOverride ?? undefined,
        permissionMode: session.permissionMode ?? undefined,
      });
      next.reasoningOverride = session.reasoningOverride;

      // 先に新しいほうを作る。席が空いていなければ畳まずに済む。
      this.manager.archiveSession(session.id);
      this.#conversations.delete(session.id);

      const conv = this.#conversationFor(next.id);
      conv.pushSystem(`${session.name} から引き継ぎました`);
      conv.input.setValue(text);
      conv.input.cursor = text.length;

      this.selectedRow = next.slot;
      this.#openScreen('conversation');
      this.#notify(`${next.name} に引き継ぎました。内容を確かめて送ってください。`);
    } catch (err) {
      this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
    }
  }

  #openHire(): void {
    if (this.store.firstFreeSlot() === null) {
      this.#notify('スロットが空いていません。[X] でアーカイブしてください。', this.theme.gauge.high);
      return;
    }
    if (this.#availableKinds.length === 0) {
      this.#notify('claude も codex も見つかりません。追加できません。', this.theme.gauge.critical);
      return;
    }
    const cwd = new TextInput();
    cwd.setValue(this.#defaultCwd);
    this.#hire = {
      mode: 'new',
      kind: this.#availableKinds[0]!,
      role: 'general',
      sandbox: null,
      cwd,
      index: 0,
    };
    this.#openScreen('hire');
  }

  /** すでにある会話を一覧して選ばせる */
  #openImport(role: Role): void {
    // 除外するのは「いまスロットにいるセッション」が握っているものだけ。
    // アーカイブさせた会話は、また雇えなければ二度と手が出せなくなる。
    const taken = new Set(
      this.store
        .active()
        .map((e) => e.agentSessionId)
        .filter((id): id is string => id !== null),
    );
    const sessions = listExistingSessions({ limit: 60 }).filter(
      (session) => this.#availableKinds.includes(session.kind) && !taken.has(session.sessionId),
    );

    if (sessions.length === 0) {
      this.#hire = null;
      this.#openScreen('main');
      this.#notify('取り込める会話が見つかりませんでした', this.theme.gauge.high);
      return;
    }
    // 前に担当していたアーカイブ済みが居れば、その名前を出す
    const formerBySession = new Map<string, string>();
    for (const session of this.store.dashboard.sessions) {
      if (session.archived && session.agentSessionId) formerBySession.set(session.agentSessionId, session.name);
    }

    this.#importSession = { sessions, index: 0, role, previews: new Map(), formerBySession };
    this.#loadPreview();
    this.#openScreen('importSession');
  }

  /** 選択中の会話だけ中身を読む。読んだものは覚えておく。 */
  #loadPreview(): void {
    const state = this.#importSession;
    const session = state?.sessions[state.index];
    if (!state || !session) return;
    if (state.previews.has(session.sessionId)) return;

    const { items, experience, truncated } = readSessionTranscript(session, { maxItems: 60 });
    state.previews.set(session.sessionId, { items, experience, truncated });
  }

  #drawImport(): void {
    const state = this.#importSession;
    if (!state) {
      this.#openScreen('main');
      return;
    }
    const session = state.sessions[state.index];
    drawImport(this.screen, {
      sessions: state.sessions,
      index: state.index,
      scroll: this.#scroll,
      theme: this.theme,
      preview: session ? (state.previews.get(session.sessionId) ?? null) : null,
      formerBySession: state.formerBySession,
    });
  }

  #importKey(k: Key): void {
    const state = this.#importSession;
    if (!state) {
      this.#openScreen('main');
      return;
    }
    const visible = listHeight(this.screen.height);

    if (k.name === 'escape') {
      this.#importSession = null;
      this.#openScreen('hire');
      return;
    }
    if (k.name === 'enter') {
      this.#doImport(state);
      return;
    }
    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      state.index = Math.min(state.sessions.length - 1, state.index + 1);
    } else if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      state.index = Math.max(0, state.index - 1);
    } else if (k.name === 'pagedown' || (k.ctrl && k.ch === 'd')) {
      state.index = Math.min(state.sessions.length - 1, state.index + visible);
    } else if (k.name === 'pageup' || (k.ctrl && k.ch === 'u')) {
      state.index = Math.max(0, state.index - visible);
    } else {
      return;
    }
    // 選択が画面から出ないようにスクロールを合わせる
    if (state.index < this.#scroll) this.#scroll = state.index;
    if (state.index >= this.#scroll + visible) this.#scroll = state.index - visible + 1;
    this.#loadPreview();
  }

  #doImport(state: ImportState): void {
    const source = state.sessions[state.index];
    if (!source) return;

    // 一覧に出すぶんより多く読み直す。画面に出す履歴なので長めに。
    const transcript = readSessionTranscript(source, { maxItems: 1_000 });

    // 前に担当していたアーカイブ済みが居るなら、新しく作らずそれを戻す。
    // 2 つの記録が同じ会話を持つと、CLI 側が「書き手が既にいる」と言って
    // 終了コード 1 になり、どちらからも会話できなくなる。
    const former = this.store.dashboard.sessions.find(
      (e) => e.archived && e.agentSessionId === source.sessionId,
    );
    if (former) {
      try {
        if (source.title !== '（内容不明）') {
          this.manager.setConversationTitle(former.id, source.title);
        }
        const conv = new ConversationState();
        conv.seedFromTranscript(transcript.items, transcript.truncated);
        conv.pushSystem(`ここから ${former.name} として続行`);
        this.#conversations.set(former.id, conv);
        const back = this.manager.unarchiveSession(former.id);
        this.#queueSessionAnalysis(former.id, source);
        this.selectedRow = back.slot;
        this.#importSession = null;
        this.#hire = null;
        this.#openScreen('conversation');
        this.#notify(`${back.name} を一覧に戻しました`, this.theme.gauge.good);
      } catch (err) {
        this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
      }
      return;
    }

    try {
      const session = this.manager.createSession({
        kind: source.kind,
        role: state.role,
        // 会話は始まった場所に紐づいている。別の場所から再開すると見つからない。
        cwd: source.cwd || this.#defaultCwd,
        agentSessionId: source.sessionId,
        conversationTitle: source.title === '（内容不明）' ? null : source.title,
        carryOver: transcript.experience,
      });
      this.#queueSessionAnalysis(session.id, source);

      // これまでのやり取りを会話画面に流し込む
      const conv = new ConversationState();
      conv.seedFromTranscript(transcript.items, transcript.truncated);
      conv.pushSystem(`ここから ${session.name} として続行`);
      this.#conversations.set(session.id, conv);

      // 取り込んだぶんは今月の実績ではないので、月初の基準に含めておく
      this.#history.baseline[session.id] = {
        tasksCompleted: session.stats.tasksCompleted,
        tasksFailed: session.stats.tasksFailed,
        tokensIn: session.stats.totalTokensIn,
        tokensOut: session.stats.totalTokensOut,
      };

      this.selectedRow = session.slot;
      this.#importSession = null;
      this.#hire = null;
      this.#openScreen('conversation');
      this.#notify(
        `${session.name} として取り込みました（やり取り ${session.stats.tasksCompleted} 件）`,
        this.theme.gauge.good,
      );
    } catch (err) {
      this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
    }
  }

  #askRetire(): void {
    const session = this.selectedSession;
    if (!session) return;
    this.#confirm = {
      title: 'アーカイブ',
      message: `${session.name} をアーカイブさせますか？ 会話とスタッツはセッション履歴に残ります。`,
      onYes: () => {
        try {
          this.manager.archiveSession(session.id);
          // 会話は開いたときに履歴から組み直せる。抱えたままにしない。
          this.#conversations.delete(session.id);
          this.#notify(`${session.name} をアーカイブしました`);
        } catch (err) {
          this.#notify(String(err instanceof Error ? err.message : err), this.theme.gauge.critical);
        }
      },
    };
    this.#openScreen('confirm');
  }

  #askQuit(): void {
    const busy = this.store.active().filter((e) => BUSY_STATES.has(e.state));
    if (busy.length === 0) {
      this.stop();
      return;
    }
    this.#confirm = {
      title: '終了',
      message: `${busy.length} 名が作業中です。終了しますか？ 会話は CLI 側に残るので、次回そのまま続けられます。`,
      onYes: () => this.stop(),
    };
    this.#openScreen('confirm');
  }

  /**
   * ダッシュボード側で答えられるスラッシュコマンドを処理する。
   *
   * codex 本体はスラッシュコマンドを解釈しないので（FINDINGS §9）、
   * 状態や設定のようにこちらが持っている情報は、ここで返してしまう。
   * CLI に投げる必要が無いぶん、実行の枠も消費しない。
   *
   * 戻り値が false なら、この入力はもう処理し終えている。
   */
  #handleLocalCommand(session: Session, conv: ConversationState, text: string): boolean {
    const result = runLocalCommand(text, {
      session,
      usageLine: this.#usageLineFor(session.kind),
    });

    const echo = (body: string): void => {
      conv.pushUser(text);
      // 詳細パネルと同じで、1 行ずつのほうが読める
      for (const line of body.split('\n')) conv.pushSystem(line);
      conv.scrollToBottom();
      this.#completion = null;
      this.#completionNote = null;
    };

    switch (result.kind) {
      case 'answer':
        echo(result.text);
        return false;

      case 'changed':
        if (result.model !== undefined) session.modelOverride = result.model;
        if (result.reasoning !== undefined) session.reasoningOverride = result.reasoning;
        echo(result.text);
        return false;

      case 'action':
        conv.pushUser(text);
        if (result.action === 'compact') this.#compact();
        else this.#openModelPick(session);
        return false;

      case 'passthrough':
        if (session.kind === 'codex' && text.startsWith('/')) {
          // 知らないコマンドを黙って送ると、ただの指示文になって枠を消費する
          conv.input.setValue(text);
          this.#notify(
            `codex は /${parseCommand(text)?.name ?? ''} を解釈しません。/help で使えるものを出せます。`,
            this.theme.gauge.high,
          );
          return false;
        }
        // 実行中なら途中送信へ回る。控えに残るので、ここで止めない。
        if (!this.manager.isRunning(session.id)) {
          try {
            this.manager.assertCanDispatch(session.id);
          } catch (err) {
            // 送れないときは書いた指示を入力欄に戻す
            conv.input.setValue(text);
            this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
            return false;
          }
        }
        this.#send(session, text);
        return true;
    }
  }

  /** 使用量を 1 行にしたもの。まだ取れていなければ null。 */
  #usageLineFor(kind: AgentKind): string | null {
    const snapshot = this.#usage?.snapshot(kind);
    if (!snapshot || snapshot.windows.length === 0) return null;
    return snapshot.windows
      .map((w) => `${w.label} ${Math.round(100 - w.usedPercent)}% 残`)
      .join('  ');
  }

  #compact(): void {
    const session = this.selectedSession;
    if (!session) return;
    this.#send(session, 'ここまでの作業内容を要約して、文脈を整理してください。');
  }

  #reconnect(all: boolean): void {
    if (!this.#recovery) {
      this.#notify('ネットワーク監視が無効です', this.theme.gauge.high);
      return;
    }
    this.#monitor?.refresh();
    void this.#recovery.recover();
    this.#notify(all ? '全員の再接続を試みます' : '再接続を試みます');
  }

  #send(session: Session, prompt: string): void {
    if (this.manager.isRunning(session.id)) {
      // 受付確認までは永続化される控えに保持。失敗時も文章を失わない。
      const draft = this.manager.addDraft(session.id, prompt);
      const conv = this.#conversationFor(session.id);
      conv.pushSystem('実行中の会話へ追加指示を送信中…');
      void this.manager.steer(session.id, prompt).then(() => {
        if (draft && session.drafts.some((d) => d.id === draft.id && d.text === prompt.trim())) {
          this.manager.removeDraft(session.id, draft.id);
        }
        conv.pushSystem('追加指示を受け付けました');
        this.#markDirty();
      }).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        conv.pushSystem(`追加指示の受付を確認できませんでした: ${reason}（文章は控えに保存）`);
        this.#markDirty();
      });
      this.#markDirty();
      return;
    }
    const run = this.manager.dispatch(session.id, prompt);
    run.catch((err: unknown) => {
      this.manager.addDraft(session.id, prompt);
      this.#conversationFor(session.id).pushSystem('送信できなかった文章を控えに保存しました');
      this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
    });
    this.#markDirty();
  }

  #confirmKey(k: Key): void {
    if (k.name === 'char' && (k.ch === 'y' || k.ch === 'Y')) {
      const c = this.#confirm;
      this.#confirm = null;
      this.#openScreen('main');
      c?.onYes();
      return;
    }
    if (k.name === 'escape' || (k.name === 'char' && (k.ch === 'n' || k.ch === 'N'))) {
      this.#confirm = null;
      this.#openScreen('main');
    }
  }

  #draftKey(k: Key): void {
    const state = this.#draft;
    if (!state) return;

    if (k.name === 'escape') {
      this.#draft = null;
      this.#openScreen('main');
      return;
    }
    if (k.name === 'enter') {
      const text = state.input.value.trim();
      if (state.editing) {
        this.manager.updateDraft(state.sessionId, state.editing, text);
        this.#notify(text === '' ? '控えを消しました' : '控えを直しました');
      } else if (text !== '') {
        this.manager.addDraft(state.sessionId, text);
        this.#notify('控えに足しました');
      }
      const back = state.editing ? 'drafts' : 'main';
      this.#draft = null;
      const session = this.store.find(state.sessionId);
      this.#openScreen(back === 'drafts' && (session?.drafts.length ?? 0) > 0 ? 'drafts' : 'main');
      return;
    }
    if (k.name === 'up' || k.name === 'down') {
      const width = Math.min(80, this.screen.width - 8) - 4;
      state.input.moveVertical(k.name === 'up' ? -1 : 1, width);
      return;
    }
    state.input.handleKey(k);
  }

  /** 控えの一覧のキー操作 */
  #draftsKey(k: Key): void {
    const session = this.selectedSession;
    const drafts = session?.drafts ?? [];
    if (!session || drafts.length === 0) {
      this.#openScreen('main');
      return;
    }
    this.#draftIndex = Math.min(this.#draftIndex, drafts.length - 1);
    const current = drafts[this.#draftIndex]!;

    if (k.name === 'escape') {
      this.#openScreen('main');
      return;
    }
    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      this.#draftIndex = Math.min(drafts.length - 1, this.#draftIndex + 1);
      return;
    }
    if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      this.#draftIndex = Math.max(0, this.#draftIndex - 1);
      return;
    }
    if (k.name === 'enter') {
      if (BUSY_STATES.has(session.state)) {
        this.#notify(`${session.name} は実行中です`, this.theme.gauge.high);
        return;
      }
      this.manager.sendDraft(session.id, current.id).catch((err: unknown) => {
        this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
      });
      this.#openScreen('conversation');
      return;
    }
    if (k.name === 'char' && k.ch === 'e') {
      this.#openDraft(current.id);
      return;
    }
    if (k.name === 'char' && k.ch === 'n') {
      this.#openDraft();
      return;
    }
    if (k.name === 'char' && (k.ch === 'd' || k.ch === 'x')) {
      this.manager.removeDraft(session.id, current.id);
      this.#draftIndex = Math.max(0, Math.min(this.#draftIndex, session.drafts.length - 1));
      if (session.drafts.length === 0) this.#openScreen('main');
      return;
    }
  }

  #hireKey(k: Key): void {
    const s = this.#hire;
    if (!s) return;
    const fields = this.#hireFields();
    const field = fields[Math.min(s.index, fields.length - 1)]!;

    if (k.name === 'escape') {
      this.#hire = null;
      this.#openScreen('main');
      return;
    }
    if (k.name === 'enter') {
      if (s.mode === 'import') this.#openImport(s.role);
      else this.#doHire(s);
      return;
    }
    if (k.name === 'up' || (field.key !== 'cwd' && k.name === 'char' && k.ch === 'k')) {
      s.index = (s.index - 1 + fields.length) % fields.length;
      return;
    }
    if (k.name === 'down' || (field.key !== 'cwd' && k.name === 'char' && k.ch === 'j')) {
      s.index = (s.index + 1) % fields.length;
      return;
    }

    if (field.key === 'cwd') {
      if (k.name === 'left' || k.name === 'right') {
        s.cwd.handleKey(k);
        return;
      }
      if (s.cwd.handleKey(k)) return;
      return;
    }

    const dir = k.name === 'left' || (k.name === 'char' && k.ch === 'h') ? -1
      : k.name === 'right' || (k.name === 'char' && k.ch === 'l') ? 1
        : 0;
    if (dir === 0) return;

    if (field.key === 'mode') {
      s.mode = s.mode === 'new' ? 'import' : 'new';
      s.index = 0;
    } else if (field.key === 'kind') {
      // 使える種別だけを巡回する
      const kinds = this.#availableKinds;
      const i = kinds.indexOf(s.kind);
      s.kind = kinds[(i + dir + kinds.length) % kinds.length] ?? s.kind;
      if (s.kind === 'claude') s.sandbox = null;
    } else if (field.key === 'role') {
      const i = ROLES.indexOf(s.role);
      s.role = ROLES[(i + dir + ROLES.length) % ROLES.length]!;
    } else if (field.key === 'sandbox') {
      const i = SANDBOXES.indexOf(s.sandbox);
      s.sandbox = SANDBOXES[(i + dir + SANDBOXES.length) % SANDBOXES.length]!;
    }
  }

  #doHire(s: HireState): void {
    try {
      const session = this.manager.createSession({
        kind: s.kind,
        role: s.role,
        cwd: s.cwd.value.trim() || this.#defaultCwd,
        sandbox: s.sandbox,
      });
      this.selectedRow = session.slot;
      this.#hire = null;
      this.#openScreen('main');
      this.#notify(`${session.name} が入社しました`, this.theme.gauge.good);
    } catch (err) {
      this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
    }
  }

  #conversationKey(k: Key): void {
    const session = this.selectedSession;
    if (!session) {
      this.#openScreen('main');
      return;
    }
    const conv = this.#conversationFor(session.id);

    // 候補は Tab で選ぶ。↑/↓ は入力内を動き、端を越えたら送信履歴へ移る。
    if (this.#completion) {
      if (k.name === 'escape') {
        this.#completion = null;
        return;
      }
      if (k.name === 'tab') {
        this.#completion = moveSelection(this.#completion, 1);
        return;
      }
      if (k.name === 'backtab') {
        this.#completion = moveSelection(this.#completion, -1);
        return;
      }
      if (k.name === 'enter') {
        conv.input.setValue(applyCompletion(this.#completion));
        this.#completion = null;
        return;
      }
    }

    if (k.name === 'escape') {
      this.#openScreen('main');
      return;
    }
    if (k.ctrl && k.ch === 'c') {
      if (!conv.input.isEmpty) {
        conv.input.clear();
        return;
      }
      if (this.manager.isRunning(session.id)) {
        this.manager.interrupt(session.id, 'user');
        this.#notify('中断しました');
      }
      return;
    }
    if (k.name === 'enter') {
      // 空のまま Enter を押しても何も送らない。控えは選んだときだけ出て行く。
      const text = conv.input.submit();
      if (text !== null) {
        if (!this.#handleLocalCommand(session, conv, text)) return;
      }
      this.#completion = null;
      conv.scrollToBottom();
      return;
    }
    if (k.name === 'tab') {
      conv.showSubordinates = !conv.showSubordinates;
      return;
    }
    // 会話は Ctrl+U / Ctrl+D だけ。PgUp / PgDn は端末側で拾われることがあり、
    // 効いたり効かなかったりするので受けない。
    //
    // Shift を足すと速い。ただし Ctrl+Shift+U は、端末が修飾を報告しない限り
    // Ctrl+U と同じバイトで届く。届かない環境のために Alt+u / Alt+d も同じ動きにする。
    if ((k.ctrl || k.alt) && (k.ch === 'u' || k.ch === 'd')) {
      const fast = k.shift || k.alt;
      const lines = fast ? SCROLL_LINES_FAST : SCROLL_LINES;
      conv.scrollBy(k.ch === 'u' ? -lines : lines);
      return;
    }
    if (k.name === 'up') {
      if (!conv.input.moveVertical(-1, this.screen.width - 6)) conv.input.historyPrev();
      this.#completion = null;
      this.#completionNote = null;
      return;
    }
    if (k.name === 'down') {
      if (!conv.input.moveVertical(1, this.screen.width - 6)) conv.input.historyNext();
      this.#completion = null;
      this.#completionNote = null;
      return;
    }
    // 入力欄では文字を奪わない。日本語を打っている最中に画面が飛ばないように。
    // 会話中でも控えを選んで送れる
    if (k.name === 'char' && k.ch === 'p' && k.alt) {
      this.#openDrafts();
      return;
    }
    if (k.name === 'char' && k.ch === 'e' && k.alt) {
      this.#openDraft();
      return;
    }
    conv.input.handleKey(k);
    this.#refreshCompletion(session, conv);
  }

  #approvalKey(k: Key): void {
    const session = this.selectedSession;
    if (!session || session.pendingApprovals.length === 0) {
      this.#openScreen('main');
      return;
    }
    const index = Math.min(this.#approvalIndex, session.pendingApprovals.length - 1);
    const approval = session.pendingApprovals[index]!;

    // 却下理由の入力中
    if (this.#rejectInput) {
      if (k.name === 'escape') {
        this.#rejectInput = null;
        return;
      }
      if (k.name === 'enter') {
        const reason = this.#rejectInput.value.trim();
        this.#rejectInput = null;
        this.#openScreen('main');
        void this.manager.reject(session.id, approval.id, reason || undefined).catch(() => {});
        return;
      }
      this.#rejectInput.handleKey(k);
      return;
    }

    if (k.name === 'escape') {
      this.#openScreen('main');
      return;
    }
    if (k.name === 'char' && k.ch === 'y') {
      this.#openScreen('main');
      this.manager.approve(session.id, approval.id).catch((err: unknown) => {
        this.#notify(err instanceof Error ? err.message : String(err), this.theme.gauge.critical);
      });
      return;
    }
    if (k.name === 'char' && k.ch === 'n') {
      this.#rejectInput = new TextInput();
      return;
    }
    if (k.name === 'char' && k.ch === 'a') {
      this.manager.alwaysAllow(approval.toolName);
      this.#openScreen('main');
      this.manager.approve(session.id, approval.id).catch(() => {});
      this.#notify(`${approval.toolName} を今後は常に承認します`);
      return;
    }
    if (k.name === 'down' || (k.name === 'char' && k.ch === 'j')) {
      this.#approvalIndex = Math.min(session.pendingApprovals.length - 1, index + 1);
      return;
    }
    if (k.name === 'up' || (k.name === 'char' && k.ch === 'k')) {
      this.#approvalIndex = Math.max(0, index - 1);
    }
  }
}
