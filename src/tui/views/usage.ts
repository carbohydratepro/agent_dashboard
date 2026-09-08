/**
 * AI ごとの使用量（ホーム画面の 1 行）。
 *
 * claude は `/usage` の出力から、codex はセッション記録から、
 * どちらも「残り何 %」の実数を取ってくる（src/core/usage.ts）。
 * 取れなかったときは推測で埋めず、その旨を書く。
 */

import type { Screen } from '../screen.ts';
import type { Rect } from '../layout.ts';
import type { AgentKind } from '../../core/types.ts';
import type { UsageSnapshot, UsageWindow } from '../../core/usage.ts';
import type { Theme } from '../theme.ts';
import { drawGauge, fillRect, textClipped } from '../paint.ts';
import { padEnd, truncate } from '../width.ts';

const GAUGE_WIDTH = 8;

/** 使用率に応じた色。使うほど赤くなる。 */
export function usageColor(theme: Theme, usedPercent: number): number {
  if (usedPercent >= 90) return theme.gauge.critical;
  if (usedPercent >= 75) return theme.gauge.high;
  if (usedPercent >= 50) return theme.gauge.warn;
  return theme.gauge.good;
}

/** リセットまでの残り。'2:14' のような短い表記。 */
export function untilReset(window: UsageWindow, now: number): string {
  if (window.resetsAt === null) return window.resetsText;
  const remain = Math.max(0, window.resetsAt - now);
  const total = Math.floor(remain / 60_000);
  const days = Math.floor(total / 1_440);
  if (days >= 1) return `${days}日`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export interface UsageViewState {
  theme: Theme;
  now: number;
  snapshots: Partial<Record<AgentKind, UsageSnapshot | null>>;
  /** 使える AI 種別。CLI が無いものは「未導入」と出す */
  availableKinds?: AgentKind[];
}

/** 画面に出す 1 行を、色付きの断片として組み立てる。テストからも使う。 */
export interface UsagePiece {
  text: string;
  color: number;
  gauge?: { ratio: number; color: number };
  bold?: boolean;
}

export function usagePieces(s: UsageViewState): UsagePiece[] {
  const { theme } = s;
  const available = s.availableKinds ?? (['claude', 'codex'] as AgentKind[]);
  const pieces: UsagePiece[] = [];

  for (const kind of ['claude', 'codex'] as AgentKind[]) {
    if (pieces.length > 0) pieces.push({ text: '   |   ', color: theme.border });
    pieces.push({ text: `${padEnd(kind, 7)}`, color: theme.textDim, bold: true });

    if (!available.includes(kind)) {
      pieces.push({ text: '未導入', color: theme.textDim });
      continue;
    }

    const snapshot = s.snapshots[kind];
    if (!snapshot) {
      pieces.push({ text: '取得中…', color: theme.textDim });
      continue;
    }
    if (snapshot.windows.length === 0) {
      pieces.push({ text: snapshot.error ?? '情報なし', color: theme.textDim });
      continue;
    }

    for (const w of snapshot.windows) {
      const color = usageColor(theme, w.usedPercent);
      pieces.push({ text: `${w.label} `, color: theme.textDim });
      pieces.push({
        text: '',
        color,
        gauge: { ratio: w.usedPercent / 100, color },
      });
      pieces.push({ text: ` ${Math.round(w.usedPercent)}%`, color });

      if (w.expired) {
        // 記録は前の窓のもの。0% と出しているのは実測ではなく入れ替わりの結果。
        pieces.push({ text: '(リセット済) ', color: theme.textDim });
        continue;
      }
      const reset = untilReset(w, s.now);
      if (reset !== '') pieces.push({ text: `(${reset}) `, color: theme.textDim });
      else pieces.push({ text: ' ', color: theme.textDim });
    }
  }
  return pieces;
}

export function drawUsage(screen: Screen, rect: Rect, s: UsageViewState): void {
  fillRect(screen, rect.x, rect.y, rect.w, rect.h, s.theme.bg);
  let x = rect.x + 1;
  const limit = rect.x + rect.w - 1;

  for (const piece of usagePieces(s)) {
    if (x >= limit) break;
    if (piece.gauge) {
      const width = Math.min(GAUGE_WIDTH, limit - x);
      if (width <= 0) break;
      drawGauge(screen, x, rect.y, width, piece.gauge.ratio, {
        filled: piece.gauge.color,
        emptyStyle: { fg: s.theme.border, bg: s.theme.bg },
      });
      x += width;
      continue;
    }
    x += screen.text(x, rect.y, truncate(piece.text, limit - x), {
      fg: piece.color,
      bg: s.theme.bg,
      bold: piece.bold,
    });
  }
}

/** 経営状況パネル用。1 行ずつの文字列にする。 */
export function usageLines(s: UsageViewState): string[] {
  const available = s.availableKinds ?? (['claude', 'codex'] as AgentKind[]);
  const lines: string[] = [];

  for (const kind of ['claude', 'codex'] as AgentKind[]) {
    if (!available.includes(kind)) {
      lines.push(`${kind}  未導入`);
      continue;
    }
    const snapshot = s.snapshots[kind];
    if (!snapshot) {
      lines.push(`${kind}  取得中…`);
      continue;
    }
    if (snapshot.windows.length === 0) {
      lines.push(`${kind}  ${snapshot.error ?? '情報なし'}`);
      continue;
    }
    const plan = snapshot.planType ? `  プラン ${snapshot.planType}` : '';
    lines.push(`${kind}${plan}`);
    for (const w of snapshot.windows) {
      const reset = w.resetsText || untilReset(w, s.now);
      // 全角を含むので表示幅で揃える。String.padEnd だと桁がずれる。
      lines.push(
        `  ${padEnd(w.label, 12)} ${String(Math.round(w.usedPercent)).padStart(3)}% 使用   リセット ${reset}`,
      );
    }
  }
  return lines;
}
