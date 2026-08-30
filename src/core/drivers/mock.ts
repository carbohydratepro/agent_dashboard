/**
 * テスト用のモックドライバ。
 * 実 CLI を起動せずに SessionManager の状態遷移を検証するために使う。
 *
 * 台本（scenario）は「このターンでどんな AgentEvent を流すか」を決める関数。
 * 実 CLI と同じ順序・同じ形のイベントを吐くよう、フェーズ 0 の実採取
 * （docs/phase0/FINDINGS.md）に合わせてある。
 */

import type { AgentDriver, StartOpts, TurnOpts } from './driver.ts';
import type { AgentEvent, AgentKind } from '../types.ts';

export interface TurnContext {
  /** このセッションで何ターン目か（1 始まり） */
  turnIndex: number;
  prompt: string;
  sessionId: string;
  allowedTools: string[];
}

export type Scenario = (ctx: TurnContext) => AgentEvent[];

export interface MockDriverOptions {
  kind?: AgentKind;
  /** codex は事前にセッション ID を指定できないので、こちらで採番する（SPEC §5.2） */
  assignsOwnSessionId?: boolean;
  model?: string;
  /** ターンごとの台本。既定は「一言返して終わる」 */
  scenario?: Scenario;
}

const DEFAULT_SCENARIO: Scenario = () => [
  { t: 'text', delta: 'はい。' },
  { t: 'turn_end', ok: true, result: 'はい。' },
];

export class MockDriver implements AgentDriver {
  readonly kind: AgentKind;

  #assignsOwnSessionId: boolean;
  #model: string;
  #scenario: Scenario;
  #turnCounts = new Map<string, number>();
  #nextSessionSeq = 0;
  #hangAfter: number | null = null;

  /** テストからの検査用。実行されたターンの記録。 */
  readonly calls: Array<{
    mode: 'start' | 'resume';
    sessionId: string;
    prompt: string;
    allowedTools: string[];
    cwd: string;
  }> = [];

  constructor(opts: MockDriverOptions = {}) {
    this.kind = opts.kind ?? 'claude';
    this.#assignsOwnSessionId = opts.assignsOwnSessionId ?? false;
    this.#model = opts.model ?? 'mock-model';
    this.#scenario = opts.scenario ?? DEFAULT_SCENARIO;
  }

  setScenario(scenario: Scenario): void {
    this.#scenario = scenario;
  }

  /**
   * n 個のイベントを流したあと、中断されるまで固まる。
   * ネットワーク切替でプロセスが応答しなくなる状況を再現する（SPEC §10.1）。
   * 0 を渡すと session_started の前に固まる = セッション未確定のまま中断される
   * codex の 1 ターン目を再現できる（SPEC §10.7）。null で解除。
   */
  setHangAfter(n: number | null): void {
    this.#hangAfter = n;
  }

  async *start(opts: StartOpts): AsyncIterable<AgentEvent> {
    const sessionId = this.#assignsOwnSessionId
      ? `mock-thread-${++this.#nextSessionSeq}`
      : (opts.sessionId ?? `mock-session-${++this.#nextSessionSeq}`);

    this.calls.push({
      mode: 'start',
      sessionId,
      prompt: opts.prompt,
      allowedTools: [],
      cwd: opts.cwd,
    });

    // セッション ID が確定する前に切れる状況（SPEC §10.7）
    if (this.#hangAfter === 0) {
      await waitForAbort(opts.signal);
      return;
    }

    yield { t: 'session_started', sessionId, model: this.#model };
    yield* this.#runTurn(sessionId, opts.prompt, [], opts.signal);
  }

  async *resume(sessionId: string, opts: TurnOpts): AsyncIterable<AgentEvent> {
    const allowedTools = opts.allowedTools ?? [];
    this.calls.push({
      mode: 'resume',
      sessionId,
      prompt: opts.prompt,
      allowedTools,
      cwd: opts.cwd,
    });
    yield* this.#runTurn(sessionId, opts.prompt, allowedTools, opts.signal);
  }

  async *#runTurn(
    sessionId: string,
    prompt: string,
    allowedTools: string[],
    signal?: AbortSignal,
  ): AsyncIterable<AgentEvent> {
    const turnIndex = (this.#turnCounts.get(sessionId) ?? 0) + 1;
    this.#turnCounts.set(sessionId, turnIndex);

    const events = this.#scenario({ turnIndex, prompt, sessionId, allowedTools });

    for (const [i, ev] of events.entries()) {
      if (signal?.aborted) return;
      // マイクロタスクを挟んで、実ドライバと同じく非同期に届くようにする
      await Promise.resolve();
      yield ev;

      if (this.#hangAfter !== null && i + 1 >= this.#hangAfter) {
        await waitForAbort(signal);
        return;
      }
    }
  }
}

/** 中断されるまで待つ。実プロセスが応答しない状況の代わり。 */
function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// よく使う台本のヘルパー
// ---------------------------------------------------------------------------

/** ファイルを 1 つ編集してコマンドを 1 つ走らせる、素直な成功ターン */
export function successfulTurn(opts: {
  text?: string;
  files?: string[];
  commands?: string[];
  contextTokens?: number;
} = {}): AgentEvent[] {
  const text = opts.text ?? '完了しました。';
  const events: AgentEvent[] = [{ t: 'requesting' }, { t: 'thinking', estimatedTokens: 120 }];

  for (const path of opts.files ?? []) {
    events.push({ t: 'tool_start', name: 'Edit', detail: path, toolUseId: `tu-${path}` });
    events.push({ t: 'file_edited', path, kind: 'update' });
    events.push({ t: 'tool_end', name: 'Edit', ok: true, toolUseId: `tu-${path}` });
  }
  for (const cmd of opts.commands ?? []) {
    events.push({ t: 'tool_start', name: 'Bash', detail: cmd, toolUseId: `tu-${cmd}` });
    events.push({ t: 'command_run', cmd, exitCode: 0 });
    events.push({ t: 'tool_end', name: 'Bash', ok: true, toolUseId: `tu-${cmd}` });
  }

  events.push({ t: 'text', delta: text });
  events.push({
    t: 'usage',
    contextTokens: opts.contextTokens ?? 14_000,
    estimated: false,
    inputTokens: 1_200,
    outputTokens: 300,
  });
  events.push({ t: 'turn_end', ok: true, result: text });
  return events;
}

/** 権限拒否で終わるターン（承認待ちが発生する、SPEC §8.4） */
export function deniedTurn(opts: {
  toolName?: string;
  filePath?: string;
} = {}): AgentEvent[] {
  const toolName = opts.toolName ?? 'Edit';
  const filePath = opts.filePath ?? 'src/auth/session.ts';
  return [
    { t: 'requesting' },
    { t: 'tool_start', name: toolName, detail: filePath, toolUseId: 'tu-denied' },
    {
      t: 'permission_denied',
      toolName,
      toolUseId: 'tu-denied',
      toolInput: {
        file_path: filePath,
        old_string: 'a',
        new_string: 'b',
        replace_all: false,
      },
      message: `Claude requested permissions to write to ${filePath}, but you haven't granted it yet.`,
    },
    { t: 'text', delta: '書き込み権限が拒否されたため実行できていません。' },
    { t: 'turn_end', ok: true, result: '書き込み権限が拒否されたため実行できていません。' },
  ];
}

/** サブエージェントを使うターン（サブエージェントが登場する、SPEC §11） */
export function delegatingTurn(subagents: Array<{
  taskId: string;
  type: string;
  description: string;
}>): AgentEvent[] {
  const events: AgentEvent[] = [{ t: 'requesting' }];

  for (const s of subagents) {
    events.push({
      t: 'subagent_start',
      taskId: s.taskId,
      toolUseId: `tu-${s.taskId}`,
      agentType: s.type,
      description: s.description,
    });
  }
  for (const s of subagents) {
    events.push({
      t: 'subagent_progress',
      taskId: s.taskId,
      description: `Running ${s.description}`,
      lastToolName: 'Bash',
      totalTokens: 8_217,
      toolUses: 1,
      durationMs: 3_768,
    });
  }
  for (const s of subagents) {
    events.push({ t: 'subagent_end', taskId: s.taskId, ok: true, summary: `${s.description} 完了` });
  }

  events.push({ t: 'text', delta: 'サブエージェントの報告をまとめました。' });
  events.push({ t: 'turn_end', ok: true, result: 'サブエージェントの報告をまとめました。' });
  return events;
}

/** 失敗するターン */
export function failingTurn(message = 'API error'): AgentEvent[] {
  return [
    { t: 'requesting' },
    { t: 'error', message },
    { t: 'turn_end', ok: false, result: message },
  ];
}
