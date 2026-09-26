/** 表示中のセルだけを保持するドラッグ選択。会話本文全体の複製はしない。 */
import { CONTINUATION } from './screen.ts';
import type { Cell, Screen } from './screen.ts';
import { charWidth } from './width.ts';

export class ScreenSelection {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];
  readonly anchor: number;
  end: number;
  dragging = true;
  status = 'ドラッグで選択 → 離すとコピー';

  constructor(screen: Screen, x: number, y: number) {
    this.width = screen.width;
    this.height = screen.height;
    this.cells = Array.from({ length: this.width * this.height }, (_, i) =>
      ({ ...screen.get(i % this.width, Math.floor(i / this.width)) }));
    this.anchor = this.index(x, y);
    this.end = this.anchor;
  }

  index(x: number, y: number): number {
    return Math.max(0, Math.min(this.height - 1, y)) * this.width +
      Math.max(0, Math.min(this.width - 1, x));
  }

  get moved(): boolean { return this.anchor !== this.end; }

  get range(): [number, number] {
    let lo = Math.min(this.anchor, this.end);
    const hi = Math.max(this.anchor, this.end);
    // 全角文字の右半分から選んでも文字を欠落させない。
    if (this.cells[lo]?.ch === CONTINUATION) lo -= 1;
    return [lo, hi];
  }

  text(): string {
    const [lo, hi] = this.range;
    const rows: string[] = [];
    let row = '';
    for (let i = lo; i <= hi; i += 1) {
      const ch = this.cells[i]!.ch;
      if (ch !== CONTINUATION) row += ch;
      if (i % this.width === this.width - 1 || i === hi) {
        rows.push(row.trimEnd());
        row = '';
      }
    }
    return rows.join('\n');
  }

  draw(screen: Screen, bg: number, fg: number): void {
    const [lo, hi] = this.range;
    for (let i = 0; i < this.cells.length; i += 1) {
      const cell = this.cells[i]!;
      if (cell.ch === CONTINUATION) continue;
      const selected = i <= hi && i + charWidth(cell.ch) > lo;
      const { ch, ...style } = cell;
      screen.set(i % this.width, Math.floor(i / this.width), ch,
        selected ? { ...style, bg, fg, reverse: false, dim: false } : style);
    }
    screen.cursor = null;
  }
}
