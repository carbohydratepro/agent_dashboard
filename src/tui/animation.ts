/** 実行中であることを示す最小限の表示。 */

import type { SessionState } from '../core/types.ts';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_ASCII = ['|', '/', '-', '\\'];

/** 動いている状態か。止まっていれば再描画しない。 */
export function isBusy(state: SessionState): boolean {
  return state === 'thinking' || state === 'working' || state === 'delegating' || state === 'reconnecting';
}

/** 実行中は回転、それ以外は状態を表す固定の記号。 */
export function activityMark(state: SessionState, frame: number, ascii = false): string {
  if (isBusy(state)) {
    const frames = ascii ? SPINNER_ASCII : SPINNER;
    return frames[Math.abs(frame) % frames.length]!;
  }
  switch (state) {
    case 'blocked':
      return '!';
    case 'error':
      return '×';
    case 'resting':
      return '▲';
    case 'offline':
      return '·';
    default:
      return ' ';
  }
}

/** 思考量の段階。詳細パネルに数値も出す。 */
export function thinkingLevel(tokens: number): 0 | 1 | 2 | 3 {
  if (tokens >= 2_000) return 3;
  if (tokens >= 800) return 2;
  if (tokens >= 200) return 1;
  return 0;
}
