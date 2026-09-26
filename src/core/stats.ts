/** セッションの集計。数字はすべて実測で、演出用の指標は持たない。 */

import type { Session, SessionStats } from './types.ts';

export function createStats(): SessionStats {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksInterrupted: 0,
    filesEdited: 0,
    commandsRun: 0,
    subagentsSpawned: 0,
    approvalsRequested: 0,
    approvalsGranted: 0,
    reconnects: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
  };
}

/** 稼働率 = 実際に動いていた時間 / 起動してからの時間 */
export function utilization(activeMs: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(1, activeMs / elapsedMs);
}

/** 1 タスクあたりの平均トークン。タスクが無ければ null。 */
export function tokensPerTask(stats: SessionStats): number | null {
  if (stats.tasksCompleted === 0) return null;
  return Math.round((stats.totalTokensIn + stats.totalTokensOut) / stats.tasksCompleted);
}

/** 一覧・履歴用。全期間ログがあればそれを、無ければ従来の管理期間値を返す。 */
export function displayStats(session: Session): SessionStats {
  const lifetime = session.lifetime;
  if (!lifetime) return session.stats;
  return {
    ...session.stats,
    tasksCompleted: lifetime.tasksCompleted,
    filesEdited: lifetime.filesEdited,
    commandsRun: lifetime.commandsRun,
    totalTokensIn: lifetime.hasTokenUsage
      ? lifetime.tokens.inputTokens
      : session.stats.totalTokensIn,
    totalTokensOut: lifetime.hasTokenUsage
      ? lifetime.tokens.outputTokens
      : session.stats.totalTokensOut,
  };
}

export function displayStartedAt(session: Session): number {
  return session.lifetime?.startedAt ?? session.uptime.startedAt;
}

export function displayActiveMs(session: Session): number {
  return session.lifetime?.hasTiming
    ? session.lifetime.activeMs
    : session.uptime.activeMs;
}
