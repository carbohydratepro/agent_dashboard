/**
 * 期間ごとの集計。
 * 数字はすべて実測（タスク数・トークン）で、擬似的な指標は持たない。
 */

import type { Session } from './types.ts';
import { tokensPerTask, utilization } from './stats.ts';

export interface PeriodRecord {
  /** 'YYYY-MM' */
  month: string;
  tasksCompleted: number;
  tasksFailed: number;
  tokensIn: number;
  tokensOut: number;
  sessionCount: number;
  /** アプリを一度も起動しなかった月 */
  idle: boolean;
}

/** セッションごとの月初スナップショット。今月ぶんは累計との差で出す。 */
export interface Baseline {
  tasksCompleted: number;
  tasksFailed: number;
  tokensIn: number;
  tokensOut: number;
}

export interface History {
  currentMonth: string;
  records: PeriodRecord[];
  baseline: Record<string, Baseline>;
}

export function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** from の翌月から to の前月までを並べる */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  let y = fy;
  let m = fm;
  for (let guard = 0; guard < 600; guard += 1) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key >= to) break;
    out.push(key);
  }
  return out;
}

export function createHistory(now: number): History {
  return { currentMonth: monthKey(now), records: [], baseline: {} };
}

export function baselineOf(session: Session): Baseline {
  return {
    tasksCompleted: session.stats.tasksCompleted,
    tasksFailed: session.stats.tasksFailed,
    tokensIn: session.stats.totalTokensIn,
    tokensOut: session.stats.totalTokensOut,
  };
}

/** 今月ぶんの実績。累計から月初のスナップショットを引く。 */
export function currentPeriod(history: History, sessions: readonly Session[]): PeriodRecord {
  let tasksCompleted = 0;
  let tasksFailed = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let sessionCount = 0;

  for (const session of sessions) {
    if (session.archived) continue;
    sessionCount += 1;
    const base = history.baseline[session.id];
    tasksCompleted += session.stats.tasksCompleted - (base?.tasksCompleted ?? 0);
    tasksFailed += session.stats.tasksFailed - (base?.tasksFailed ?? 0);
    tokensIn += session.stats.totalTokensIn - (base?.tokensIn ?? 0);
    tokensOut += session.stats.totalTokensOut - (base?.tokensOut ?? 0);
  }

  return {
    month: history.currentMonth,
    tasksCompleted,
    tasksFailed,
    tokensIn,
    tokensOut,
    sessionCount,
    idle: false,
  };
}

/**
 * 月をまたいでいたら締める。
 * 長期間起動していなかった場合、飛んだ月は「起動なし」として履歴に残す。
 */
export function closeMonthsIfNeeded(
  history: History,
  sessions: readonly Session[],
  now: number,
): { history: History; closed: PeriodRecord[] } {
  const current = monthKey(now);
  if (current === history.currentMonth) return { history, closed: [] };

  const closed: PeriodRecord[] = [currentPeriod(history, sessions)];
  for (const month of monthsBetween(history.currentMonth, current)) {
    closed.push({
      month,
      tasksCompleted: 0,
      tasksFailed: 0,
      tokensIn: 0,
      tokensOut: 0,
      sessionCount: 0,
      idle: true,
    });
  }

  const baseline: Record<string, Baseline> = {};
  for (const session of sessions) baseline[session.id] = baselineOf(session);

  return {
    history: {
      currentMonth: current,
      records: [...history.records, ...closed].slice(-36),
      baseline,
    },
    closed,
  };
}

export interface SessionMetrics {
  sessionId: string;
  name: string;
  tasksCompleted: number;
  /** 実際に動いていた時間の割合 */
  utilization: number;
  /** 1 タスクあたりの平均トークン */
  tokensPerTask: number | null;
  totalTokens: number;
}

/** セッションごとの指標。すべて実測値から出す。 */
export function sessionMetrics(
  session: Session,
  history: History,
  now: number,
): SessionMetrics {
  const base = history.baseline[session.id];
  const completed = session.stats.tasksCompleted - (base?.tasksCompleted ?? 0);
  const elapsed = Math.max(1, now - session.uptime.startedAt);

  return {
    sessionId: session.id,
    name: session.name,
    tasksCompleted: completed,
    utilization: utilization(session.uptime.activeMs, elapsed),
    tokensPerTask: tokensPerTask(session.stats),
    totalTokens: session.stats.totalTokensIn + session.stats.totalTokensOut,
  };
}

/** レート制限で実行できない状態か */
export function isRateLimited(status: string | undefined): boolean {
  return status !== undefined && status !== 'allowed';
}
