/** 画面に絵を置くためのプリミティブ。 */

import type { Screen, Style } from './screen.ts';
import { charWidth, center, displayWidth, truncate } from './width.ts';

export const BOX = {
  single: { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' },
  double: { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' },
  round: { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' },
} as const;

export type BoxStyle = keyof typeof BOX;

export interface BoxOptions {
  style?: Style;
  box?: BoxStyle;
  title?: string;
  titleStyle?: Style;
  /** 内側を塗る背景色 */
  fill?: number;
}

export function drawBox(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: BoxOptions = {},
): void {
  if (w < 2 || h < 2) return;
  const b = BOX[opts.box ?? 'single'];
  const s = opts.style ?? {};

  screen.set(x, y, b.tl, s);
  screen.set(x + w - 1, y, b.tr, s);
  screen.set(x, y + h - 1, b.bl, s);
  screen.set(x + w - 1, y + h - 1, b.br, s);

  for (let i = 1; i < w - 1; i += 1) {
    screen.set(x + i, y, b.h, s);
    screen.set(x + i, y + h - 1, b.h, s);
  }
  for (let j = 1; j < h - 1; j += 1) {
    screen.set(x, y + j, b.v, s);
    screen.set(x + w - 1, y + j, b.v, s);
  }

  if (opts.fill !== undefined) {
    fillRect(screen, x + 1, y + 1, w - 2, h - 2, opts.fill);
  }
  if (opts.title) {
    const title = truncate(` ${opts.title} `, w - 2);
    screen.text(x + 1, y, title, opts.titleStyle ?? s);
  }
}

export function fillRect(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  h: number,
  bg: number,
): void {
  for (let j = 0; j < h; j += 1) {
    for (let i = 0; i < w; i += 1) screen.set(x + i, y + j, ' ', { bg });
  }
}

export function hline(screen: Screen, x: number, y: number, w: number, style: Style = {}, ch = '─'): void {
  for (let i = 0; i < w; i += 1) screen.set(x + i, y, ch, style);
}

/** 幅に収めて左から書く。はみ出す分は … で切る。 */
export function textClipped(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  str: string,
  style: Style = {},
): void {
  screen.text(x, y, truncate(str, w), style);
}

export function textCentered(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  str: string,
  style: Style = {},
): void {
  screen.text(x, y, center(str, w), style);
}

export function textRight(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  str: string,
  style: Style = {},
): void {
  const t = truncate(str, w);
  screen.text(x + w - displayWidth(t), y, t, style);
}

export interface GaugeOptions {
  filled?: number;
  empty?: number;
  fillChar?: string;
  emptyChar?: string;
  emptyStyle?: Style;
}

/** 横棒ゲージ。ratio は 0..1 */
export function drawGauge(
  screen: Screen,
  x: number,
  y: number,
  w: number,
  ratio: number,
  opts: GaugeOptions = {},
): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filledCells = Math.round(clamped * w);
  const fillChar = opts.fillChar ?? '█';
  const emptyChar = opts.emptyChar ?? '░';

  for (let i = 0; i < w; i += 1) {
    const on = i < filledCells;
    screen.set(
      x + i,
      y,
      on ? fillChar : emptyChar,
      on
        ? { fg: opts.filled }
        : (opts.emptyStyle ?? { fg: opts.empty ?? opts.filled, dim: true }),
    );
  }
}

/** 折り返し。表示幅で折る。 */
export function wrapText(str: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  for (const paragraph of str.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    let w = 0;
    for (const ch of paragraph) {
      const cw = charWidth(ch);
      if (w + cw > width) {
        lines.push(line);
        line = '';
        w = 0;
      }
      line += ch;
      w += cw;
    }
    if (line !== '') lines.push(line);
  }
  return lines;
}
