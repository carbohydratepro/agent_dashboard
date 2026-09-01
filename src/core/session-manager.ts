/**
 * セッション（＝セッション）のライフサイクルと、CLI イベントの状態への適用。
 * SPEC.md §7（状態遷移）／§8（セッション管理）／§8.4（承認待ち）に対応する。
 *
 * ここは端末に一切依存しない。すべての変化は StateStore のイベントとして出る。
 */

import type { AgentDriver } from './drivers/driver.ts';
import type {
  AgentEvent,
  AgentKind,
  ApprovalRequest,
  RateLimitInfo,
  Role,
  Session,
  SessionState,
  SessionStats,
  Subagent,
  Task,
  Workspace,
} from './types.ts';
import { ACTIVE_STATES, BUSY_STATES } from './types.ts';
import type { Clock, IdGen } from './clock.ts';
import { systemClock, systemIdGen } from './clock.ts';
import { StateStore } from './store.ts';
import { createStats } from './stats.ts';
import { colorForSlot, nextName } from './naming.ts';

/**
 * 1 タスクぶんに残す出来事の数。
 * 画面に出すのは末尾の数行だけなので、これ以上持っていても使い道が無い。
 */
export const MAX_TASK_EVENTS = 500;
import { isRateLimited } from './analytics.ts';
import type { CarriedExperience } from './sessions.ts';
import type { LockHandle, LockManager } from './locks.ts';

export interface ManagerConfig {
  /** モデルのコンテキスト窓。不明なモデルの既定値（SPEC §17.1） */
  contextWindow: number;
  /** この比率を超えたら resting に倒す（SPEC §17.1） */
  contextRestThreshold: number;
  /** タスク完了時に次やることメモを自動送信するか（既定オフ、SPEC §12.1） */
  autoSendNextMemo: boolean;
  defaultCwd: string;
  /** 承認待ち承認後に送るプロンプト。実機で動作確認済み（SPEC §5.1） */
  approvalPrompt: string;
  /** 「a」で常時承認にしたツール（SPEC §18 approvals.alwaysAllow） */
  alwaysAllowedTools: string[];
}

const DEFAULT_CONFIG: ManagerConfig = {
  contextWindow: 200_000,
  contextRestThreshold: 0.85,
  autoSendNextMemo: false,
  defaultCwd: process.cwd(),
  approvalPrompt: '承認しました。先ほどの操作をそのまま実行してください。',
  alwaysAllowedTools: [],
};

export interface SessionManagerDeps {
  store: StateStore;
  drivers: Partial<Record<AgentKind, AgentDriver>>;
  clock?: Clock;
  ids?: IdGen;
  config?: Partial<ManagerConfig>;
  /**
   * 同一ディレクトリでの同時実行を防ぐ（SPEC §9.4）。
   * worktree で隔離されていれば実質的に競合しないが、
   * 同居を選んだセッションどうしはここで直列化される。
   */
  locks?: LockManager;
  /** CLI の生出力を受け取るフック。raw.jsonl への追記に使う（SPEC §14.2） */
  onRawLine?: (sessionId: string, line: string) => void;
}

export interface CreateOpts {
  kind: AgentKind;
  cwd?: string;
  role?: Role;
  /** 指定すると自動採番せずこの名前を使う */
  name?: string;
  /** codex のみ。作成時に固定され、以後変更できない（SPEC §5.2） */
  sandbox?: string | null;
  model?: string | null;
  /** claude のみ。null なら CLI の既定に従う（SPEC §1） */
  permissionMode?: string | null;
  /**
   * WorkspaceManager が用意した作業環境（SPEC §9）。
   * 省略すると cwd をそのまま使う（隔離なし）。
   */
  workspace?: Workspace;
  /**
   * すでにある CLI のセッションを引き継ぐ（取り込み）。
   * 指定すると最初の指示から --resume で続きになる。
   */
  agentSessionId?: string;
  /** 取り込んだ会話の実績。ログから数えた実数（SPEC §8.1.1） */
  carryOver?: CarriedExperience;
}

export interface DispatchOpts {
  allowedTools?: string[];
  /** ネットワーク復帰など、経験値計算の対象外にしたいターン */
  recoveredFrom?: string;
  /**
   * 作業中チェックを飛ばす。復帰処理が reconnecting 状態のセッションに
   * 指示を送るときだけ使う（SPEC §10.3）。ユーザーの操作からは使わない。
   */
  force?: boolean;
}

/** 取り込んだ会話の実績を集計に乗せる。ログの実数なので水増ししない。 */
function applyCarryOver(
  stats: SessionStats,
  carry: CarriedExperience | undefined,
): SessionStats {
  if (!carry) return stats;
  stats.tasksCompleted = carry.turns;
  stats.filesEdited = carry.filesEdited;
  stats.commandsRun = carry.commandsRun;
  return stats;
}

/** 中断の理由。ユーザーが止めたのか、外的要因で切れたのか（SPEC §8.3 / §10） */
export type InterruptReason = 'user' | 'network';

/** ターン内で数えた出来事。経験値の算出に使う（SPEC §17.3） */
interface TurnCounters {
  filesEdited: number;
  commandsRun: number;
  subagentsSpawned: number;
}

export class SessionManager {
  readonly store: StateStore;
  #drivers: Partial<Record<AgentKind, AgentDriver>>;
  #clock: Clock;
  #ids: IdGen;
  #config: ManagerConfig;
  #locks: LockManager | undefined;
  #onRawLine: ((sessionId: string, line: string) => void) | undefined;
  #taskSeq = 0;
  /** 実行中ターンの中断口。ユーザーの Ctrl+C とネットワーク復帰の両方で使う */
  #running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** 中断の理由。finalize で失敗と区別するために覚えておく */
  #interruptions = new Map<string, InterruptReason>();

  constructor(deps: SessionManagerDeps) {
    this.store = deps.store;
    this.#drivers = deps.drivers;
    this.#clock = deps.clock ?? systemClock;
    this.#ids = deps.ids ?? systemIdGen;
    this.#config = { ...DEFAULT_CONFIG, ...deps.config };
    this.#locks = deps.locks;
    this.#onRawLine = deps.onRawLine;
  }

  get config(): Readonly<ManagerConfig> {
    return this.#config;
  }

  // -------------------------------------------------------------------------
  // 作成・アーカイブ（SPEC §8.1 / §8.3）
  // -------------------------------------------------------------------------

  createSession(opts: CreateOpts): Session {
    const slot = this.store.firstFreeSlot();
    if (slot === null) {
      throw new Error('スロットが空いていません');
    }
    if (!this.#drivers[opts.kind]) {
      throw new Error(`${opts.kind} のドライバが登録されていません`);
    }

    const now = this.#clock.now();
    const cwd = opts.cwd ?? this.#config.defaultCwd;

    const session: Session = {
      id: this.#ids.uuid(),
      agentSessionId: opts.agentSessionId ?? null,
      kind: opts.kind,
      slot,
      model: opts.model ?? null,
      permissionMode: opts.permissionMode ?? null,
      name: opts.name ?? nextName(opts.kind, this.store.usedNames()),
      color: colorForSlot(slot),
      role: opts.role ?? 'general',
      state: 'idle',
      currentTask: null,
      subagents: [],
      pendingApprovals: [],
      workspace: opts.workspace ?? {
        requestedCwd: cwd,
        actualCwd: cwd,
        isolation: 'none',
        branch: null,
        sandbox: opts.sandbox ?? null,
      },
      recovery: {
        attempts: 0,
        lastError: null,
        interruptedTaskId: null,
        networkFingerprintAtStart: null,
      },
      nextPrompt: '',
      nextPromptUpdatedAt: 0,
      thinkingTokens: 0,
      context: {
        usedTokens: 0,
        windowTokens: this.#config.contextWindow,
        ratio: 0,
        estimated: opts.kind === 'codex',
        prevInputTokens: 0,
        prevOutputTokens: 0,
      },
      uptime: { startedAt: now, activeMs: 0, lastActiveAt: now },
      stats: applyCarryOver(createStats(), opts.carryOver),
      lastError: null,
      archived: false,
    };

    this.store.dashboard.sessions.push(session);
    this.store.emit({ t: 'session_added', session });
    return session;
  }

  /** 保存されていたセッションを一覧に戻す（SPEC §14.3 手順 2） */
  /**
   * 同じ CLI セッションを 2 つの記録が持っていたら、片方を切り離す。
   *
   * claude も codex も 1 つの会話に書き手は 1 人しか許さない。codex は
   * 「already has an active writer」で終了コード 1 になり、以後ずっと会話できない。
   * 生きている方を残し、アーカイブ済みの方から紐付けを外す。
   *
   * 戻り値は利用者に見せる知らせ。
   */
  static resolveDuplicateAgentSessions(sessions: Session[]): string[] {
    const byAgentId = new Map<string, Session[]>();
    for (const session of sessions) {
      const id = session.agentSessionId;
      if (id === null) continue;
      const list = byAgentId.get(id) ?? [];
      list.push(session);
      byAgentId.set(id, list);
    }

    const notes: string[] = [];
    for (const [agentId, list] of byAgentId) {
      if (list.length < 2) continue;
      // 一覧にいる方を優先し、同条件ならタスク番号が進んでいる方を残す
      const sorted = [...list].sort((a, b) => {
        if (a.archived !== b.archived) return a.archived ? 1 : -1;
        return (b.stats.tasksCompleted ?? 0) - (a.stats.tasksCompleted ?? 0);
      });
      const keep = sorted[0]!;
      for (const drop of sorted.slice(1)) {
        drop.agentSessionId = null;
        drop.lastError = null;
        notes.push(
          `${drop.name} と ${keep.name} が同じ会話を指していました。${keep.name} に残し、${drop.name} の紐付けを外しました。`,
        );
      }
      void agentId;
    }
    return notes;
  }

  loadSessions(sessions: Session[]): string[] {
    const notes = SessionManager.resolveDuplicateAgentSessions(sessions);
    for (const session of sessions) {
      if (this.store.find(session.id)) continue;
      this.store.dashboard.sessions.push(session);
      this.store.emit({ t: 'session_added', session });
    }
    // 次に採番するタスク番号を、復元した履歴の先へ進める
    for (const session of sessions) {
      const n = Number(session.currentTask?.id.replace('task-', '') ?? 0);
      if (Number.isFinite(n)) this.#taskSeq = Math.max(this.#taskSeq, n);
    }
    return notes;
  }

  /**
   * アーカイブしたセッションを一覧に戻す。
   * 集計・下書き・CLI セッションへの紐はそのまま残っている。
   */
  unarchiveSession(sessionId: string): Session {
    const session = this.store.require(sessionId);
    if (!session.archived) throw new Error(`${session.name} は一覧にあります`);

    const slot = this.store.firstFreeSlot();
    if (slot === null) throw new Error('スロットが空いていません');

    session.archived = false;
    session.slot = slot;
    session.color = colorForSlot(slot);
    session.state = 'offline';
    session.lastError = null;
    session.subagents = [];
    this.store.emit({ t: 'session_added', session });
    return session;
  }

  archiveSession(sessionId: string): void {
    const session = this.store.require(sessionId);
    if (BUSY_STATES.has(session.state)) {
      throw new Error(`${session.name} は実行中です`);
    }
    session.archived = true;
    this.#setState(session, 'offline');
    this.store.emit({ t: 'session_archived', sessionId });
  }

  // -------------------------------------------------------------------------
  // 次やることメモ（SPEC §12）
  // -------------------------------------------------------------------------

  setNextPrompt(sessionId: string, memo: string): void {
    const session = this.store.require(sessionId);
    session.nextPrompt = memo;
    session.nextPromptUpdatedAt = this.#clock.now();
    this.store.emit({ t: 'session_changed', sessionId });
  }

  /** メモの内容をそのまま指示として送り、メモをクリアする */
  async sendNextPrompt(sessionId: string): Promise<Task> {
    const session = this.store.require(sessionId);
    const draft = session.nextPrompt.trim();
    if (!draft) throw new Error('下書きが空です');
    this.setNextPrompt(sessionId, '');
    return this.dispatch(sessionId, draft);
  }

  // -------------------------------------------------------------------------
  // 承認待ち（SPEC §8.4）
  // -------------------------------------------------------------------------

  /** 承認して再実行する。--allowedTools を付けた resume が走る。 */
  async approve(sessionId: string, approvalId: string): Promise<Task> {
    const session = this.store.require(sessionId);
    const idx = session.pendingApprovals.findIndex((a) => a.id === approvalId);
    if (idx < 0) throw new Error(`承認待ちが見つかりません: ${approvalId}`);

    const approval = session.pendingApprovals[idx]!;
    session.stats.approvalsGranted += 1;
    this.store.emit({ t: 'approval_resolved', sessionId, approvalId, granted: true });

    return this.dispatch(sessionId, this.#config.approvalPrompt, {
      allowedTools: [approval.toolName],
    });
  }

  /** 却下する。理由を渡すとそのまま次の指示として送る。 */
  async reject(sessionId: string, approvalId: string, reason?: string): Promise<Task | null> {
    const session = this.store.require(sessionId);
    const idx = session.pendingApprovals.findIndex((a) => a.id === approvalId);
    if (idx < 0) throw new Error(`承認待ちが見つかりません: ${approvalId}`);

    session.pendingApprovals.splice(idx, 1);
    this.store.emit({ t: 'approval_resolved', sessionId, approvalId, granted: false });

    if (session.pendingApprovals.length === 0 && session.state === 'blocked') {
      this.#setState(session, 'idle');
    }
    return reason ? this.dispatch(sessionId, reason) : null;
  }

  // -------------------------------------------------------------------------
  // 中断（SPEC §8.3 / §10.3）
  // -------------------------------------------------------------------------

  #rawHook(sessionId: string): ((line: string) => void) | undefined {
    const hook = this.#onRawLine;
    return hook ? (line) => hook(sessionId, line) : undefined;
  }

  /** 実行中かどうか */
  isRunning(sessionId: string): boolean {
    return this.#running.has(sessionId);
  }

  /**
   * 実行中のターンを中断する。
   * reason が 'user' なら cancelled、'network' なら interrupted として閉じる。
   * 呼び出し側は dispatch の Promise を await して完了を待つ。
   */
  interrupt(sessionId: string, reason: InterruptReason): boolean {
    const entry = this.#running.get(sessionId);
    if (!entry) return false;
    this.#interruptions.set(sessionId, reason);
    entry.controller.abort();
    return true;
  }

  /** 実行中ターンが閉じるまで待つ。動いていなければ即座に返る。 */
  async awaitTurn(sessionId: string): Promise<void> {
    await this.#running.get(sessionId)?.done;
  }

  /**
   * 状態を直接書き換える。復帰処理が試行の合間にセッションを戻すために使う。
   * 稼働時間の計上は通常の遷移と同じ扱いになる。
   */
  forceState(sessionId: string, state: SessionState): void {
    this.#setState(this.store.require(sessionId), state);
  }

  /**
   * その AI 種別のセッションのコンテキスト窓を実測値に合わせる。
   * codex はセッション記録に model_context_window を書いており、
   * 既定の 200,000 より広い（実測 258,400）。ゲージの分母が正しくなる。
   */
  setContextWindow(kind: AgentKind, windowTokens: number): void {
    if (!Number.isFinite(windowTokens) || windowTokens <= 0) return;
    for (const session of this.store.dashboard.sessions) {
      if (session.kind !== kind || session.context.windowTokens === windowTokens) continue;
      session.context.windowTokens = windowTokens;
      session.context.ratio = Math.min(1, session.context.usedTokens / windowTokens);
      this.store.emit({ t: 'session_changed', sessionId: session.id });
    }
  }

  /** 以降このツールは常に承認する（SPEC §8.4 の「a」） */
  alwaysAllow(toolName: string): void {
    if (!this.#config.alwaysAllowedTools.includes(toolName)) {
      this.#config.alwaysAllowedTools.push(toolName);
    }
  }

  // -------------------------------------------------------------------------
  // 指示の実行
  // -------------------------------------------------------------------------

  /**
   * 1 ターンを実行する。
   * autoSendNextMemo が有効なら、完了後にメモが残っている限り続けて実行する。
   */
  async dispatch(sessionId: string, prompt: string, opts: DispatchOpts = {}): Promise<Task> {
    let task = await this.#runTurn(sessionId, prompt, opts);

    while (this.#config.autoSendNextMemo && task.status === 'done') {
      const session = this.store.require(sessionId);
      const draft = session.nextPrompt.trim();
      if (!draft) break;
      this.setNextPrompt(sessionId, '');
      task = await this.#runTurn(sessionId, draft, {});
    }
    return task;
  }

  async #runTurn(sessionId: string, prompt: string, opts: DispatchOpts): Promise<Task> {
    const session = this.store.require(sessionId);
    if (session.archived) throw new Error(`${session.name} はアーカイブしています`);
    if (!opts.force && BUSY_STATES.has(session.state)) {
      throw new Error(`${session.name} は実行中です`);
    }
    // レート制限に当たっている間は送っても失敗するだけ（SPEC §19）
    if (isRateLimited(this.store.dashboard.rateLimit?.status)) {
      throw new Error('営業時間外です。レート制限が解除されるまで待ってください。');
    }

    const driver = this.#drivers[session.kind];
    if (!driver) throw new Error(`${session.kind} のドライバが登録されていません`);

    const startedAt = this.#clock.now();
    this.#taskSeq += 1;
    const task: Task = {
      id: `task-${this.#taskSeq}`,
      sessionId,
      prompt,
      startedAt,
      endedAt: null,
      status: 'running',
      events: [],
      summary: null,
      recoveredFrom: opts.recoveredFrom ?? null,
    };

    // 承認待ち・サブエージェントは前ターンの遺物なので、新しいターンの開始時に消す
    session.pendingApprovals = [];
    session.subagents = [];
    session.thinkingTokens = 0;
    session.currentTask = task;
    session.lastError = null;
    this.#setState(session, 'thinking');
    this.store.emit({ t: 'task_started', sessionId, task });

    const counters: TurnCounters = { filesEdited: 0, commandsRun: 0, subagentsSpawned: 0 };
    const allowedTools = [...this.#config.alwaysAllowedTools, ...(opts.allowedTools ?? [])];

    let turnOk = true;
    let sawTurnEnd = false;
    let result = '';
    let errorMessage: string | null = null;
    let lock: LockHandle | null = null;

    const controller = new AbortController();
    let markDone!: () => void;
    const done = new Promise<void>((resolve) => {
      markDone = resolve;
    });
    this.#running.set(sessionId, { controller, done });
    this.#interruptions.delete(sessionId);

    try {
      // 同じ場所を触るセッションがいれば、ここで順番を待つ
      if (this.#locks) lock = await this.#locks.acquire(session.workspace.actualCwd, session.id);

      const stream = session.agentSessionId
        ? driver.resume(session.agentSessionId, {
            prompt,
            cwd: session.workspace.actualCwd,
            allowedTools,
            permissionMode: session.permissionMode,
            prevInputTokens: session.context.prevInputTokens,
            prevOutputTokens: session.context.prevOutputTokens,
            signal: controller.signal,
            onRawLine: this.#rawHook(sessionId),
          })
        : driver.start({
            prompt,
            cwd: session.workspace.actualCwd,
            // claude は UUID をこちらで採番できる。codex は無視され thread_id が返る
            sessionId: session.kind === 'claude' ? session.id : undefined,
            model: session.model,
            permissionMode: session.permissionMode,
            sandbox: session.workspace.sandbox,
            prevInputTokens: session.context.prevInputTokens,
            prevOutputTokens: session.context.prevOutputTokens,
            signal: controller.signal,
            onRawLine: this.#rawHook(sessionId),
          });

      for await (const event of stream) {
        task.events.push(event);
        // 長いターンでは際限なく増える。画面は末尾しか使わないので古いものは捨てる。
        if (task.events.length > MAX_TASK_EVENTS) {
          task.events.splice(0, task.events.length - MAX_TASK_EVENTS);
        }
        // 先に状態へ反映してから通知する。購読側が古い状態を見ないように。
        this.#applyAgentEvent(session, task, event, counters);
        this.store.emit({ t: 'agent_event', sessionId, event });

        if (event.t === 'error') errorMessage = event.message;
        if (event.t === 'turn_end') {
          sawTurnEnd = true;
          turnOk = event.ok;
          result = event.result;
        }
      }
    } catch (err) {
      turnOk = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      await lock?.release();
      this.#running.delete(sessionId);
    }

    const interrupted = this.#interruptions.get(sessionId) ?? null;
    this.#interruptions.delete(sessionId);

    // ストリームが turn_end を出さずに終わったら異常終了。
    // 中断させた場合は想定内なので、そちらの扱いを優先する。
    if (!sawTurnEnd && !interrupted && !errorMessage) {
      turnOk = false;
      errorMessage = '応答が途中で終わりました';
    }

    this.#finalizeTurn(session, task, { turnOk, result, errorMessage, counters, interrupted });
    markDone();
    return task;
  }

  // -------------------------------------------------------------------------
  // イベントの適用（SPEC §7 の状態遷移）
  // -------------------------------------------------------------------------

  #applyAgentEvent(
    session: Session,
    task: Task,
    ev: AgentEvent,
    counters: TurnCounters,
  ): void {
    switch (ev.t) {
      case 'session_started':
        session.agentSessionId = ev.sessionId;
        session.model = ev.model;
        break;

      case 'requesting':
        if (session.state !== 'delegating') this.#setState(session, 'thinking');
        break;

      case 'thinking':
        session.thinkingTokens = ev.estimatedTokens;
        if (session.state !== 'delegating') this.#setState(session, 'thinking');
        break;

      case 'text':
        if (ev.parentToolUseId) {
          const sub = session.subagents.find((s) => s.toolUseId === ev.parentToolUseId);
          if (sub) sub.lastText = ev.delta;
        }
        break;

      case 'tool_start':
        if (session.state !== 'delegating') this.#setState(session, 'working');
        break;

      case 'tool_end':
        break;

      case 'subagent_start': {
        const sub: Subagent = {
          taskId: ev.taskId,
          toolUseId: ev.toolUseId,
          agentType: ev.agentType,
          name: `${session.name}/${session.subagents.length + 1}`,
          description: ev.description,
          currentAction: ev.description,
          lastToolName: '',
          totalTokens: 0,
          toolUses: 0,
          durationMs: 0,
          startedAt: this.#clock.now(),
          status: 'running',
          summary: null,
          lastText: '',
        };
        session.subagents.push(sub);
        session.stats.subagentsSpawned += 1;
        counters.subagentsSpawned += 1;
        this.#setState(session, 'delegating');
        break;
      }

      case 'subagent_progress': {
        const sub = session.subagents.find((s) => s.taskId === ev.taskId);
        if (sub) {
          sub.currentAction = ev.description;
          sub.lastToolName = ev.lastToolName;
          sub.totalTokens = ev.totalTokens;
          sub.toolUses = ev.toolUses;
          sub.durationMs = ev.durationMs;
        }
        break;
      }

      case 'subagent_end': {
        const sub = session.subagents.find((s) => s.taskId === ev.taskId);
        if (sub) {
          sub.status = ev.ok ? 'completed' : 'failed';
          sub.summary = ev.summary;
        }
        if (!session.subagents.some((s) => s.status === 'running')) {
          this.#setState(session, 'working');
        }
        break;
      }

      case 'file_edited':
        session.stats.filesEdited += 1;
        counters.filesEdited += 1;
        break;

      case 'command_run':
        session.stats.commandsRun += 1;
        counters.commandsRun += 1;
        break;

      case 'permission_denied': {
        const approval: ApprovalRequest = {
          id: this.#ids.uuid(),
          toolName: ev.toolName,
          toolUseId: ev.toolUseId,
          toolInput: ev.toolInput,
          message: ev.message,
          requestedAt: this.#clock.now(),
          taskId: task.id,
        };
        session.pendingApprovals.push(approval);
        session.stats.approvalsRequested += 1;
        this.store.emit({ t: 'approval_requested', sessionId: session.id, approvalId: approval.id });
        this.store.emit({ t: 'notify', reason: 'approval_requested', sessionId: session.id });
        break;
      }

      case 'usage':
        session.context.usedTokens = ev.contextTokens;
        session.context.estimated = ev.estimated;
        session.context.ratio = Math.min(1, ev.contextTokens / session.context.windowTokens);
        session.stats.totalTokensIn += ev.inputTokens;
        session.stats.totalTokensOut += ev.outputTokens;
        // codex は累計値で返るので、次ターンの差分計算のために覚えておく
        if (ev.cumulativeInputTokens !== undefined) {
          session.context.prevInputTokens = ev.cumulativeInputTokens;
        }
        if (ev.cumulativeOutputTokens !== undefined) {
          session.context.prevOutputTokens = ev.cumulativeOutputTokens;
        }
        break;

      case 'rate_limit': {
        const info: RateLimitInfo = {
          status: ev.status,
          resetsAt: ev.resetsAt,
          rateLimitType: ev.rateLimitType,
          isUsingOverage: ev.isUsingOverage,
        };
        if (ev.overageStatus !== undefined) info.overageStatus = ev.overageStatus;
        if (ev.overageResetsAt !== undefined) info.overageResetsAt = ev.overageResetsAt;
        this.store.dashboard.rateLimit = info;
        this.store.emit({ t: 'rate_limit', info });
        if (isRateLimited(info.status)) {
          for (const other of this.store.active()) {
            if (!BUSY_STATES.has(other.state)) this.#setState(other, 'resting');
          }
          this.store.emit({ t: 'notify', reason: 'rate_limited', sessionId: null });
        }
        break;
      }

      case 'turn_end':
      case 'error':
        // 終了処理は #finalizeTurn でまとめて行う
        break;
    }
  }

  #finalizeTurn(
    session: Session,
    task: Task,
    o: {
      turnOk: boolean;
      result: string;
      errorMessage: string | null;
      counters: TurnCounters;
      interrupted: InterruptReason | null;
    },
  ): void {
    const now = this.#clock.now();
    task.endedAt = now;

    // サブエージェントはターン終了で全員退場する（使い捨て、SPEC §11.3）
    session.subagents = [];

    if (o.interrupted) {
      // セッションの失敗ではないので経験値は動かさない（SPEC §17.3）
      const byNetwork = o.interrupted === 'network';
      task.status = byNetwork ? 'interrupted' : 'cancelled';
      task.summary = o.result || null;
      if (byNetwork) {
        session.stats.tasksInterrupted += 1;
        session.recovery.interruptedTaskId = task.id;
        this.#setState(session, 'reconnecting');
      } else {
        this.#setState(session, 'idle');
      }
      this.store.emit({ t: 'task_finished', sessionId: session.id, task });
      return;
    }

    if (!o.turnOk || o.errorMessage) {
      task.status = 'failed';
      task.summary = o.errorMessage ?? o.result;
      session.lastError = o.errorMessage ?? o.result;
      session.stats.tasksFailed += 1;
      this.#setState(session, 'error');
      this.store.emit({ t: 'notify', reason: 'task_failed', sessionId: session.id });
    } else if (session.pendingApprovals.length > 0) {
      // 承認待ち。失敗とは区別する。
      task.status = 'blocked';
      task.summary = o.result;
      this.#setState(session, 'blocked');
    } else {
      task.status = 'done';
      task.summary = o.result;
      session.stats.tasksCompleted += 1;

      const exhausted = session.context.ratio >= this.#config.contextRestThreshold;
      this.#setState(session, exhausted ? 'resting' : 'idle');
      this.store.emit({ t: 'notify', reason: 'task_done', sessionId: session.id });
    }

    this.store.emit({ t: 'task_finished', sessionId: session.id, task });
  }

  // -------------------------------------------------------------------------

  /**
   * 状態を変え、稼働時間を積む（SPEC §17.2）。
   * タイマーを使わず遷移時の差分で積むのでドリフトしない。
   */
  #setState(session: Session, next: SessionState): void {
    const now = this.#clock.now();
    if (ACTIVE_STATES.has(session.state)) {
      session.uptime.activeMs += now - session.uptime.lastActiveAt;
    }
    session.uptime.lastActiveAt = now;

    if (session.state === next) return;
    const from = session.state;
    session.state = next;
    this.store.emit({ t: 'state_changed', sessionId: session.id, from, to: next });
  }
}
