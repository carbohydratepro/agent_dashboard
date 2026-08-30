/**
 * 状態の保持と変更通知。core は端末 API を一切触らない。
 * UI はここから流れるイベントを購読して描画するだけ。
 */

import { EventEmitter } from 'node:events';
import type {
  AgentEvent,
  AgentKind,
  Dashboard,
  RateLimitInfo,
  Session,
  SessionState,
  Task,
} from './types.ts';

export type StoreEvent =
  | { t: 'session_added'; session: Session }
  | { t: 'session_archived'; sessionId: string }
  | { t: 'session_changed'; sessionId: string }
  | { t: 'state_changed'; sessionId: string; from: SessionState; to: SessionState }
  | { t: 'task_started'; sessionId: string; task: Task }
  | { t: 'task_finished'; sessionId: string; task: Task }
  | { t: 'agent_event'; sessionId: string; event: AgentEvent }
  | { t: 'approval_requested'; sessionId: string; approvalId: string }
  | { t: 'approval_resolved'; sessionId: string; approvalId: string; granted: boolean }
  | { t: 'rate_limit'; info: RateLimitInfo }
  | { t: 'network_changed'; from: string; to: string }
  | { t: 'network_lost' }
  | { t: 'network_restored' }
  | { t: 'recovery_started'; sessionIds: string[] }
  | { t: 'recovery_progress'; sessionId: string; attempt: number }
  | { t: 'recovery_finished'; ok: string[]; failed: string[] }
  | { t: 'usage_updated'; kind: AgentKind }
  | { t: 'notify'; reason: NotifyReason; sessionId: string | null };

/** 端末ベルを鳴らす契機 */
export type NotifyReason =
  | 'task_done'
  | 'task_failed'
  | 'approval_requested'
  | 'recovery_failed'
  | 'rate_limited';

export class StateStore {
  readonly dashboard: Dashboard;
  #emitter = new EventEmitter();

  constructor(dashboard: Dashboard) {
    this.dashboard = dashboard;
    this.#emitter.setMaxListeners(0);
  }

  on(listener: (e: StoreEvent) => void): () => void {
    this.#emitter.on('change', listener);
    return () => this.#emitter.off('change', listener);
  }

  emit(e: StoreEvent): void {
    this.#emitter.emit('change', e);
  }

  find(id: string): Session | undefined {
    return this.dashboard.sessions.find((s) => s.id === id);
  }

  /** 見つからなければ投げる。呼び出し側で毎回 null チェックしないで済むように。 */
  require(id: string): Session {
    const session = this.find(id);
    if (!session) throw new Error(`セッションが見つかりません: ${id}`);
    return session;
  }

  active(): Session[] {
    return this.dashboard.sessions.filter((s) => !s.archived);
  }

  /** 空いているスロット番号。埋まっていれば null。 */
  firstFreeSlot(): number | null {
    const taken = new Set(this.active().map((s) => s.slot));
    for (let i = 0; i < this.dashboard.slotCount; i += 1) {
      if (!taken.has(i)) return i;
    }
    return null;
  }

  /** 使用中の識別名 */
  usedNames(): string[] {
    return this.dashboard.sessions.map((s) => s.name);
  }
}

export function createDashboard(opts: Partial<Dashboard> = {}): Dashboard {
  return {
    title: opts.title ?? 'AGENT DASHBOARD',
    slotCount: opts.slotCount ?? 6,
    sessions: opts.sessions ?? [],
    rateLimit: opts.rateLimit ?? null,
  };
}
