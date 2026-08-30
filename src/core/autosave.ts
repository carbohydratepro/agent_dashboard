/**
 * 状態が変わったらディスクに書き戻す（SPEC §14.2 の保存タイミング）。
 * SessionManager を汚さないよう、StateStore の購読者として外から付ける。
 */

import type { StateStore, StoreEvent } from './store.ts';
import type { Persistence } from './persistence.ts';
import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';

/** これらのイベントでセッションを保存する。agent_event は多すぎるので入れない。 */
const SAVE_SESSION_ON = new Set<StoreEvent['t']>([
  'session_added',
  'session_archived',
  'session_changed',
  'state_changed',
  'task_started',
  'task_finished',
  'approval_requested',
  'approval_resolved',
]);

export interface AutosaveOptions {
  store: StateStore;
  persistence: Persistence;
  clock?: Clock;
}

export function attachAutosave(opts: AutosaveOptions): () => void {
  const { store, persistence } = opts;
  const clock = opts.clock ?? systemClock;

  return store.on((e) => {
    if ('sessionId' in e && typeof e.sessionId === 'string' && SAVE_SESSION_ON.has(e.t)) {
      const emp = store.find(e.sessionId);
      if (emp) persistence.saveSession(emp);
    }
    if (e.t === 'session_added') {
      persistence.saveSession(e.session);
      persistence.saveDashboard(store.dashboard, clock.now());
    }
    if (e.t === 'session_archived') persistence.saveDashboard(store.dashboard, clock.now());
    if (e.t === 'task_finished') persistence.appendTask(e.sessionId, e.task);
    if (e.t === 'rate_limit') persistence.saveDashboard(store.dashboard, clock.now());
  });
}
