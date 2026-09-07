/**
 * アプリ本体。画面の切り替えとキーの配線（SPEC §16）。
 *
 * 端末は Terminal 抽象越しに触るので、FakeTerminal を渡せば
 * 実際の端末なしでキー操作を丸ごとテストできる。
 */

import { Screen } from './screen.ts';
import type { Terminal } from './terminal.ts';
import type { Key } from './input.ts';
import { isPrintable } from './input.ts';
import type { Theme } from './theme.ts';
import { DEFAULT_THEME, STATE_LABEL_JA } from './theme.ts';
import { drawMainScreen, sessionAtRow } from './render.ts';
import { CURSOR_HIDE, CURSOR_SHOW, moveTo } from './ansi.ts';
import { recentTurns } from './views/detail.ts';
import { LOCAL_COMMANDS, parseCommand, runLocalCommand } from '../core/local-commands.ts';
import type { RecentTurn } from './views/detail.ts';
import { ResourceMonitor } from '../core/resources.ts';
import type { ResourceSample } from '../core/resources.ts';
import { drawPanel, panelMetrics } from './views/panel.ts';
import type { PanelLine } from './views/panel.ts';
import { helpLines } from './views/help.ts';
import { LogBuffer, describeEvent, logLines } from './views/log.ts';
import { TextInput } from './widgets/textinput.ts';
import { drawBox, fillRect, textCentered, textClipped, textRight, wrapText } from './paint.ts';
import { cursorPosition, dropWidth, padEnd, scrollOffsetFor } from './width.ts';
import { ROLE_LABEL, ROLES } from '../core/naming.ts';
import { listExistingSessions, readSessionTranscript } from '../core/sessions.ts';
import type { ExistingSession } from '../core/sessions.ts';
import { drawImport, listHeight } from './views/import.ts';
import type { ImportPreview } from './views/import.ts';
import { sessionMetrics, createHistory, isRateLimited, currentPeriod } from '../core/analytics.ts';
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
import { drawConversation, ConversationState } from './views/conversation.ts';
import { applyCompletion, commandPrefix, completionFor, moveSelection } from './completion.ts';
import type { CompletionState } from './completion.ts';
import { drawApproval } from './views/approval.ts';

export type ScreenId =
  | 'main'
  | 'conversation'
  | 'approval'
  | 'draft'
  | 'drafts'
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
  #history: History;
  #monthlyBudget: number;
  #availableKinds: AgentKind[];
  #usage: UsageMonitor | undefined;
  /** ベルの連続抑制（SPEC §15.7）。3 秒以内は 1 回にまとめる。 */
  #lastBellAt = 0;

  #scroll = 0;
  /** セッション履歴で選んでいるセッション */
  #archiveIndex = 0;
  #logFilter: string | null = null;
  #confirm: ConfirmState | null = null;
  /** editing が null なら新規、あれば その控えの書き換え */
  #draft: { sessionId: string; input: TextInput; editing: string | null } | null = null;
  /** 控えの一覧で選んでいる位置 */
  #draftIndex = 0;
  #hire: HireState | null = null;
  #importSession: ImportState | null = null;
  #approvalIndex = 0;
  #conversations = new Map<string, ConversationState>();
  #completionNote: string | null = null;
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
    this.terminal.enter();
    this.#unsubscribers.push(this.terminal.onKey((k) => this.handleKey(k)));
    this.#unsubscribers.push(
      this.terminal.onResize(() => {
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

  render(): void {
    this.#dirty = false;
    if (this.screen.width !== this.terminal.columns || this.screen.height !== this.terminal.rows) {
      this.screen.resize(this.terminal.columns, this.terminal.rows);
    }
    this.#draw();

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
          footer: '[Esc] 戻る',
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

      // 前回までの履歴を読み戻す
      for (const task of this.#loadHistory?.(sessionId) ?? []) {
        conv.pushUser(task.prompt);
        if (task.summary) conv.applyEvent({ t: 'text', delta: task.summary });
        if (task.status === 'interrupted') conv.pushSystem('ネットワーク切替により中断');
        if (task.status === 'cancelled') conv.pushSystem('中断しました');
      }
      const session = this.store.find(sessionId);
      if (session?.currentTask && session.currentTask.events.length > 0) {
        conv.seedFromTask(session.currentTask);
      }
    }
    return conv;
  }

  #openScreen(id: ScreenId): void {
    this.screenId = id;
    this.#scroll = 0;
  }

  // -------------------------------------------------------------------------
  // キー
  // -------------------------------------------------------------------------

  handleKey(k: Key): void {
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
    const h = 12;
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

    const lines = state.input.value.split('\n');
    const available = w - 5;
    const pos = cursorPosition(state.input.value, state.input.cursor);
    const offset = scrollOffsetFor(pos.column, available);

    for (let i = 0; i < Math.min(lines.length, h - 5); i += 1) {
      textClipped(this.screen, x + 2, y + 3 + i, w - 4, dropWidth(lines[i]!, offset), {
        fg: theme.text,
        bg: theme.panelBg,
      });
    }
    if (offset > 0) this.screen.set(x + 1, y + 3, '‹', { fg: theme.textDim, bg: theme.panelBg });
    this.screen.cursor = {
      x: Math.min(x + 2 + pos.column - offset, x + w - 2),
      y: y + 3 + Math.min(pos.line, h - 6),
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
      (a, b) => b.stats.tasksCompleted - a.stats.tasksCompleted,
    );
  }

  #archiveLines(): PanelLine[] {
    const theme = this.theme;
    const lines: PanelLine[] = [];
    const all = this.#archiveSessions();
    const selected = all[Math.min(this.#archiveIndex, all.length - 1)];
    const now = this.#now();

    for (const session of all) {
      const st = session.stats;
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
        text: `経過 ${formatDuration(now - session.uptime.startedAt)}  実働 ${formatDuration(session.uptime.activeMs)}  トークン ${formatTokens(st.totalTokensIn + st.totalTokensOut)}  ${session.workspace.requestedCwd}`,
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
      { text: 'セッションごと', color: theme.accent, bold: true },
    ];

    for (const session of active) {
      const m = sessionMetrics(session, this.#history, now);
      lines.push({
        text: `${padEnd(m.name, 14)} 完了 ${String(m.tasksCompleted).padStart(3)}   稼働率 ${String(Math.round(m.utilization * 100)).padStart(3)}%   トークン ${formatTokens(m.totalTokens)}   1 タスク ${m.tokensPerTask ?? '—'}`,
        color: theme.text,
        indent: 1,
      });
    }
    if (active.length === 0) {
      lines.push({ text: 'まだセッションがありません。', color: theme.textDim, indent: 1 });
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
        text: `${isRateLimited(rl.status) ? '制限中' : '通常'}   あと ${formatDuration(Math.max(0, rl.resetsAt * 1000 - now))}   枠 ${rl.rateLimitType}`,
        color: isRateLimited(rl.status) ? theme.gauge.critical : theme.text,
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
    const transcript = readSessionTranscript(source, { maxItems: 400 });

    // 前に担当していたアーカイブ済みが居るなら、新しく作らずそれを戻す。
    // 2 つの記録が同じ会話を持つと、CLI 側が「書き手が既にいる」と言って
    // 終了コード 1 になり、どちらからも会話できなくなる。
    const former = this.store.dashboard.sessions.find(
      (e) => e.archived && e.agentSessionId === source.sessionId,
    );
    if (former) {
      try {
        const back = this.manager.unarchiveSession(former.id);
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
        carryOver: transcript.experience,
      });

      // これまでのやり取りを会話画面に流し込む
      const conv = this.#conversationFor(session.id);
      conv.seedFromTranscript(transcript.items, transcript.truncated);
      conv.pushSystem(`ここから ${session.name} として続行`);

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
        if (result.model !== undefined) session.model = result.model;
        echo(result.text);
        return false;

      case 'action':
        conv.pushUser(text);
        this.#compact();
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
    const run = this.manager.dispatch(session.id, prompt);
    run.catch((err: unknown) => {
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

    // 候補を出している間は、その操作を優先する
    if (this.#completion) {
      if (k.name === 'escape') {
        this.#completion = null;
        return;
      }
      if (k.name === 'tab' || k.name === 'down') {
        this.#completion = moveSelection(this.#completion, 1);
        return;
      }
      if (k.name === 'backtab' || k.name === 'up') {
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
    if (k.name === 'pageup' || (k.ctrl && k.ch === 'u')) {
      conv.scrollBy(-Math.floor(this.screen.height / 2));
      return;
    }
    if (k.name === 'pagedown' || (k.ctrl && k.ch === 'd')) {
      conv.scrollBy(Math.floor(this.screen.height / 2));
      return;
    }
    if (k.name === 'up' && conv.input.isEmpty) {
      conv.input.historyPrev();
      return;
    }
    if (k.name === 'down' && conv.input.isEmpty) {
      conv.input.historyNext();
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
