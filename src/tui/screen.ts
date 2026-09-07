/**
 * ダブルバッファのセルグリッド。差分だけを端末に流す。
 *
 * 8fps でドット絵を動かすので、毎フレーム全画面を書き直すと帯域とちらつきで
 * つらい。前回のバッファと比べて変わったセルだけを出す。
 *
 * toStrings() で色抜きのプレーンテキストを取り出せる。レイアウトのテストは
 * これを使ってスナップショット的に検証する。
 */

import { bgCode, fgCode, moveTo, RESET } from './ansi.ts';
import type { ColorMode } from './ansi.ts';
import { charWidth } from './width.ts';

/** 全角文字の右半分を占める番人。ここには何も出力しない。 */
export const CONTINUATION = '\u0000';

/**
 * セルに入れてはいけない文字を無害にする。
 *
 * 改行・タブ・エスケープがそのままセルに入ると、端末に流れた瞬間に
 * カーソルが動いて画面全体がずれる。文字の出どころは多い
 * （ツールの引数、stderr、モデルの出力、ファイル名…）ので、
 * 個別に直すのではなく描画の入口で止める。
 */
export function sanitizeChar(ch: string): string {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return ' ';
  // C0 制御文字・DEL・C1 制御文字
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return ' ';
  return ch;
}

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  reverse?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

export interface Cell extends Style {
  ch: string;
}

const BLANK: Cell = { ch: ' ' };

function sameCell(a: Cell, b: Cell): boolean {
  return (
    a.ch === b.ch &&
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.reverse === b.reverse &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}

export class Screen {
  width: number;
  height: number;
  colorMode: ColorMode;

  /**
   * 端末の本物のカーソルを置く位置。null なら隠す。
   *
   * 日本語入力の未確定文字列は、端末がカーソルの位置に描く。
   * カーソルを隠したままだと打っている最中の文字がどこにも出ず、
   * 確定して初めて現れる。入力欄があるときは必ずここを埋める。
   */
  cursor: { x: number; y: number } | null = null;

  #back: Cell[];
  #front: Cell[];
  #forceRedraw = true;

  constructor(width: number, height: number, colorMode: ColorMode = 'truecolor') {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.colorMode = colorMode;
    this.#back = new Array(this.width * this.height).fill(BLANK);
    this.#front = new Array(this.width * this.height).fill(BLANK);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.#back = new Array(this.width * this.height).fill(BLANK);
    this.#front = new Array(this.width * this.height).fill(BLANK);
    this.#forceRedraw = true;
  }

  /** 次のフラッシュで全面を書き直す（Ctrl+L 用） */
  invalidate(): void {
    this.#forceRedraw = true;
  }

  clear(style: Style = {}): void {
    const cell: Cell = { ch: ' ', ...style };
    this.#back.fill(cell);
    // 描き直すたびに置き直す。前の画面の位置を引きずらない。
    this.cursor = null;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  set(x: number, y: number, raw: string, style: Style = {}): void {
    if (!this.inBounds(x, y)) return;

    // 制御文字は端末を壊すので、ここで必ず落とす
    const ch = sanitizeChar(raw);

    // 全角文字の上に半角を書くと右半分が孤児になる。先に均しておく。
    this.#evictWide(x, y);

    const w = charWidth(ch);
    if (w === 2) {
      if (x + 1 >= this.width) {
        // 右端に全角は入らない。空白で埋めて崩れを防ぐ。
        this.#back[y * this.width + x] = { ch: ' ', ...style };
        return;
      }
      this.#evictWide(x + 1, y);
      this.#back[y * this.width + x] = { ch, ...style };
      this.#back[y * this.width + x + 1] = { ch: CONTINUATION, ...style };
      return;
    }
    this.#back[y * this.width + x] = { ch, ...style };
  }

  /** x,y が全角文字の一部なら、相方を空白に戻す */
  #evictWide(x: number, y: number): void {
    const i = y * this.width + x;
    const cell = this.#back[i];
    if (!cell) return;
    if (cell.ch === CONTINUATION && x > 0) {
      this.#back[i - 1] = { ...this.#back[i - 1]!, ch: ' ' };
    } else if (charWidth(cell.ch) === 2 && x + 1 < this.width) {
      const right = this.#back[i + 1];
      if (right?.ch === CONTINUATION) this.#back[i + 1] = { ...right, ch: ' ' };
    }
  }

  get(x: number, y: number): Cell {
    if (!this.inBounds(x, y)) return BLANK;
    return this.#back[y * this.width + x]!;
  }

  /** 左から文字を並べる。はみ出した分は捨てる。書いた表示幅を返す。 */
  text(x: number, y: number, str: string, style: Style = {}): number {
    let cx = x;
    for (const ch of str) {
      const w = charWidth(ch);
      if (cx + w > this.width) break;
      if (cx >= 0) this.set(cx, y, ch, style);
      cx += w;
    }
    return cx - x;
  }

  /** 端末に流す。変わったセルだけを出す。 */
  render(): string {
    let out = '';
    let cursorX = -1;
    let cursorY = -1;
    let style: Style | null = null;

    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const i = y * this.width + x;
        const cell = this.#back[i]!;
        // 継続セルは全角文字の右半分。本体と一緒に処理済み。
        if (cell.ch === CONTINUATION) {
          this.#front[i] = cell;
          continue;
        }
        if (!this.#forceRedraw && sameCell(cell, this.#front[i]!)) continue;

        if (cursorY !== y || cursorX !== x) {
          out += moveTo(x, y);
          cursorX = x;
          cursorY = y;
        }
        if (!style || !sameStyle(style, cell)) {
          out += this.#styleCode(cell);
          style = cell;
        }
        out += cell.ch;
        cursorX += charWidth(cell.ch);
        this.#front[i] = cell;
      }
    }

    if (out !== '') out += RESET;
    this.#forceRedraw = false;
    return out;
  }

  #styleCode(style: Style): string {
    let s = RESET;
    if (style.bold) s += '\x1b[1m';
    if (style.dim) s += '\x1b[2m';
    if (style.italic) s += '\x1b[3m';
    if (style.underline) s += '\x1b[4m';
    if (style.reverse) s += '\x1b[7m';
    if (style.strike) s += '\x1b[9m';
    if (style.fg !== undefined) s += fgCode(style.fg, this.colorMode);
    if (style.bg !== undefined) s += bgCode(style.bg, this.colorMode);
    return s;
  }

  /** 色を落としたプレーンテキスト。レイアウトのテストに使う。 */
  toStrings(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      let row = '';
      for (let x = 0; x < this.width; x += 1) {
        const ch = this.#back[y * this.width + x]!.ch;
        // 継続セルは出さない。全角文字がそのまま 2 桁を占めるので幅は合う。
        if (ch !== CONTINUATION) row += ch;
      }
      rows.push(row.replace(/\s+$/, ''));
    }
    return rows;
  }

  toString(): string {
    return this.toStrings().join('\n');
  }
}

function sameStyle(a: Style, b: Style): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.reverse === b.reverse &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike
  );
}
