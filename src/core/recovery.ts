/**
 * ネットワーク変更からの復帰（SPEC §10.3〜§10.7）。
 *
 * 1 ターン = 1 プロセス方式のおかげで、待機中のセッションは影響を受けない。
 * 壊れるのは「ターン実行中に切り替わったとき」だけなので、対処すべき窓は狭い。
 *
 * 復帰では元の指示を再送しない。二重実行を避けるため、
 * 状態確認を挟む復帰プロンプトを送る（SPEC §10.5）。
 */

import type { SessionManager } from './session-manager.ts';
import type { StateStore } from './store.ts';
import type { Session } from './types.ts';
import { ACTIVE_STATES } from './types.ts';
import type { NetworkEvent, NetworkMonitor } from './network.ts';

export interface RecoveryOptions {
  maxRetries?: number;
  /** リトライ間隔。指数バックオフ（SPEC §10.3） */
  backoffMs?: number[];
  /** ネットワーク安定を待つ上限。超えたら諦めて error（SPEC §10.7） */
  maxWaitMs?: number;
  /** false なら検知して通知するだけで自動復帰しない（SPEC §10.6） */
  autoRecover?: boolean;
  /** 復帰プロンプトの文面（SPEC §10.5） */
  buildPrompt?: (originalPrompt: string) => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface RecoveryReport {
  ok: string[];
  failed: string[];
  /** セッション未確定などで復帰できず、メモに書き戻したセッション（SPEC §10.7） */
  skipped: string[];
}

const DEFAULT_BACKOFF = [2_000, 8_000, 32_000];

export function defaultRecoveryPrompt(originalPrompt: string): string {
  return [
    'ネットワークの切り替えにより、直前の作業が途中で中断されました。',
    '現在の状態を確認し、未完了の作業があれば続きから進めてください。',
    'すでに完了している場合は、その旨だけ報告してください。',
    '',
    `中断された指示: ${originalPrompt}`,
  ].join('\n');
}

export interface RecoveryCoordinatorDeps {
  store: StateStore;
  manager: SessionManager;
  monitor?: NetworkMonitor;
  options?: RecoveryOptions;
}

export class RecoveryCoordinator {
  #store: StateStore;
  #manager: SessionManager;
  #monitor: NetworkMonitor | undefined;
  #opts: Required<Omit<RecoveryOptions, 'sleep'>> & { sleep: (ms: number) => Promise<void> };
  #inFlight: Promise<RecoveryReport> | null = null;

  constructor(deps: RecoveryCoordinatorDeps) {
    this.#store = deps.store;
    this.#manager = deps.manager;
    this.#monitor = deps.monitor;

    const o = deps.options ?? {};
    this.#opts = {
      maxRetries: o.maxRetries ?? 3,
      backoffMs: o.backoffMs ?? DEFAULT_BACKOFF,
      maxWaitMs: o.maxWaitMs ?? 60_000,
      autoRecover: o.autoRecover ?? true,
      buildPrompt: o.buildPrompt ?? defaultRecoveryPrompt,
      sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  /** NetworkMonitor を購読する。戻り値を呼ぶと解除。 */
  attach(): () => void {
    const monitor = this.#monitor;
    if (!monitor) return () => {};

    return monitor.on((e: NetworkEvent) => {
      if (e.t !== 'network_changed') return;
      if (!this.#opts.autoRecover) return;
      void this.recover();
    });
  }

  /** 復帰の対象になるセッション。稼働中だけ。待機中は影響を受けない（SPEC §10.1） */
  targets(): Session[] {
    return this.#store
      .active()
      .filter((e) => ACTIVE_STATES.has(e.state) && e.state !== 'reconnecting');
  }

  /**
   * 稼働中のセッションを中断し、ネットワーク安定を待ってから復帰させる。
   * 復帰中に再度呼ばれても多重には走らない。
   */
  recover(): Promise<RecoveryReport> {
    if (this.#inFlight) return this.#inFlight;
    const run = this.#recover().finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #recover(): Promise<RecoveryReport> {
    const empty: RecoveryReport = { ok: [], failed: [], skipped: [] };
    const targets = this.targets();
    if (targets.length === 0) return empty;

    const ids = targets.map((e) => e.id);
    this.#store.emit({ t: 'recovery_started', sessionIds: ids });

    // 中断された指示を控えてから止める。復帰プロンプトに載せるため。
    const originals = new Map<string, string>();
    for (const emp of targets) {
      originals.set(emp.id, emp.currentTask?.prompt ?? '');
      this.#manager.interrupt(emp.id, 'network');
    }
    await Promise.all(ids.map((id) => this.#manager.awaitTurn(id)));

    if (!(await this.#waitForStable())) {
      for (const emp of targets) this.#giveUp(emp, 'ネットワークが復旧しませんでした');
      const report: RecoveryReport = { ok: [], failed: ids, skipped: [] };
      this.#store.emit({ t: 'recovery_finished', ok: [], failed: ids });
      return report;
    }

    // 同じ場所を触るセッションどうしは直列、隔離済みなら並行（SPEC §10.4）
    const groups = new Map<string, Session[]>();
    for (const emp of targets) {
      const key = emp.workspace.actualCwd;
      const list = groups.get(key) ?? [];
      list.push(emp);
      groups.set(key, list);
    }

    const report: RecoveryReport = { ok: [], failed: [], skipped: [] };
    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const emp of group) {
          const outcome = await this.#recoverOne(emp, originals.get(emp.id) ?? '');
          report[outcome].push(emp.id);
        }
      }),
    );

    this.#store.emit({ t: 'recovery_finished', ok: report.ok, failed: report.failed });
    if (report.failed.length > 0) {
      this.#store.emit({ t: 'notify', reason: 'recovery_failed', sessionId: report.failed[0]! });
    }
    return report;
  }

  async #recoverOne(emp: Session, originalPrompt: string): Promise<'ok' | 'failed' | 'skipped'> {
    // セッションが確定する前に切れた場合は復帰しようがない。
    // 元の指示をメモに書き戻して、ユーザーがやり直せるようにする（SPEC §10.7）。
    if (!emp.agentSessionId) {
      if (originalPrompt) this.#manager.addDraft(emp.id, originalPrompt);
      this.#manager.forceState(emp.id, 'idle');
      emp.recovery.lastError = 'セッションが確定する前に中断されました';
      return 'skipped';
    }

    const prompt = this.#opts.buildPrompt(originalPrompt);
    emp.recovery.attempts = 0;

    for (let attempt = 0; attempt < this.#opts.maxRetries; attempt += 1) {
      emp.recovery.attempts = attempt + 1;
      this.#store.emit({ t: 'recovery_progress', sessionId: emp.id, attempt: attempt + 1 });

      try {
        const task = await this.#manager.dispatch(emp.id, prompt, {
          force: true,
          recoveredFrom: emp.recovery.interruptedTaskId ?? undefined,
        });
        if (task.status === 'done' || task.status === 'blocked') {
          emp.stats.reconnects += 1;
          emp.recovery.lastError = null;
          emp.recovery.interruptedTaskId = null;
          return 'ok';
        }
        emp.recovery.lastError = task.summary ?? '復帰に失敗しました';
      } catch (err) {
        emp.recovery.lastError = err instanceof Error ? err.message : String(err);
      }

      const isLast = attempt === this.#opts.maxRetries - 1;
      if (!isLast) {
        const wait = this.#opts.backoffMs[attempt] ?? this.#opts.backoffMs.at(-1) ?? 2_000;
        await this.#opts.sleep(wait);
        // 失敗すると error 状態になっているので、次の試行のために戻す
        this.#manager.forceState(emp.id, 'reconnecting');
      }
    }

    this.#giveUp(emp, emp.recovery.lastError ?? '復帰に失敗しました');
    return 'failed';
  }

  #giveUp(emp: Session, message: string): void {
    emp.recovery.lastError = message;
    emp.lastError = message;
    this.#manager.forceState(emp.id, 'error');
  }

  async #waitForStable(): Promise<boolean> {
    const monitor = this.#monitor;
    if (!monitor) return true;

    // 実時計ではなく待った量で測る。sleep を差し替えたテストでも決定的に動く。
    let waited = 0;
    for (;;) {
      if (monitor.online && !monitor.settling) return true;
      if (waited >= this.#opts.maxWaitMs) return false;
      const step = Math.min(500, this.#opts.maxWaitMs - waited);
      await this.#opts.sleep(step);
      waited += step;
    }
  }
}
