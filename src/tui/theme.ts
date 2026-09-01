/** 画面の配色。状態は色だけでなくラベルでも示す。 */

import type { SessionState } from '../core/types.ts';

export interface Theme {
  bg: number;
  panelBg: number;
  rowAlt: number;
  border: number;
  text: number;
  textDim: number;
  textBright: number;
  accent: number;
  /** 自分が書いた文。回答と一目で区別するために使う。 */
  userText: number;
  system: number;
  gauge: { good: number; warn: number; high: number; critical: number };
  state: Record<SessionState, number>;
  /** 一覧で見分けるための色。意味は持たない。 */
  sessionColors: Record<string, number>;
}

export const DEFAULT_THEME: Theme = {
  bg: 0x0e1116,
  panelBg: 0x161b22,
  rowAlt: 0x12161c,
  border: 0x30363d,
  text: 0xc9d1d9,
  textDim: 0x768390,
  textBright: 0xf0f6fc,
  accent: 0x58a6ff,
  userText: 0xaad94c,
  system: 0x8b949e,
  gauge: {
    good: 0x3fb950,
    warn: 0xd29922,
    high: 0xdb6d28,
    critical: 0xf85149,
  },
  state: {
    idle: 0x768390,
    thinking: 0x58a6ff,
    working: 0x3fb950,
    delegating: 0xa371f7,
    blocked: 0xd29922,
    reconnecting: 0x39c5cf,
    error: 0xf85149,
    resting: 0xbb8009,
    offline: 0x545d68,
  },
  sessionColors: {
    sky: 0x58a6ff,
    moss: 0x3fb950,
    clay: 0xdb6d28,
    plum: 0xa371f7,
    sand: 0xd29922,
    slate: 0x8b949e,
  },
};

export const STATE_LABEL: Record<SessionState, string> = {
  idle: 'IDLE',
  thinking: 'THINKING',
  working: 'WORKING',
  delegating: 'DELEGATE',
  blocked: 'BLOCKED',
  reconnecting: 'RECONNECT',
  error: 'ERROR',
  resting: 'CTX FULL',
  offline: 'OFFLINE',
};

export const STATE_LABEL_JA: Record<SessionState, string> = {
  idle: '待機',
  thinking: '思考中',
  working: '実行中',
  delegating: 'サブエージェント',
  blocked: '承認待ち',
  reconnecting: '再接続中',
  error: 'エラー',
  resting: 'コンテキスト逼迫',
  offline: '未接続',
};

export function gaugeColor(theme: Theme, ratio: number): number {
  if (ratio >= 0.85) return theme.gauge.critical;
  if (ratio >= 0.75) return theme.gauge.high;
  if (ratio >= 0.5) return theme.gauge.warn;
  return theme.gauge.good;
}

export function sessionColor(theme: Theme, name: string): number {
  return theme.sessionColors[name] ?? theme.text;
}
