/**
 * 端末上の表示幅。日本語は 2 セルを占めるので、
 * これを無視すると画面全体がずれる。
 */

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // ハングル字母
  [0x2e80, 0x303e], // CJK 部首・記号（'、''。' など）
  [0x3041, 0x33ff], // かな・カタカナ・CJK 互換
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], // CJK 統合漢字
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // ハングル音節
  [0xf900, 0xfaff], // CJK 互換漢字
  [0xfe30, 0xfe6f], // CJK 互換形
  [0xff00, 0xff60], // 全角英数・記号
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f9ff], // 絵文字
  [0x20000, 0x3fffd],
];

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x1100) return 1;
  for (const [lo, hi] of WIDE_RANGES) {
    if (cp >= lo && cp <= hi) return 2;
  }
  return 1;
}

export function displayWidth(str: string): number {
  let w = 0;
  for (const ch of str) w += charWidth(ch);
  return w;
}

/** 表示幅で切り詰める。切ったら末尾に ellipsis を足す。 */
export function truncate(str: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  if (displayWidth(str) <= maxWidth) return str;

  const tail = displayWidth(ellipsis);
  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth - tail) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** 表示幅で右詰め */
export function padEnd(str: string, width: number, fill = ' '): string {
  const w = displayWidth(str);
  return w >= width ? str : str + fill.repeat(width - w);
}

export function padStart(str: string, width: number, fill = ' '): string {
  const w = displayWidth(str);
  return w >= width ? str : fill.repeat(width - w) + str;
}

export function center(str: string, width: number): string {
  const w = displayWidth(str);
  if (w >= width) return truncate(str, width);
  const left = Math.floor((width - w) / 2);
  return ' '.repeat(left) + str + ' '.repeat(width - w - left);
}

/**
 * 複数行テキストのカーソル位置を、行番号と表示幅の桁で返す。
 * 全角を 1 桁と数えると、日本語を打った瞬間にカーソルが文字の上に乗る。
 */
export function cursorPosition(value: string, cursor: number): { line: number; column: number } {
  const before = value.slice(0, Math.max(0, Math.min(cursor, value.length)));
  const lines = before.split('\n');
  return { line: lines.length - 1, column: displayWidth(lines.at(-1) ?? '') };
}

/** 表示幅で先頭から cols 桁ぶん捨てる。文字の途中では切らない。 */
export function dropWidth(str: string, cols: number): string {
  if (cols <= 0) return str;
  let w = 0;
  let i = 0;
  for (const ch of str) {
    if (w >= cols) break;
    w += charWidth(ch);
    i += ch.length;
  }
  return str.slice(i);
}

/**
 * 1 行の入力欄で、カーソルが見える位置まで横スクロールさせる量。
 * 全角を打ち続けても入力が画面外に消えないようにするため。
 */
export function scrollOffsetFor(column: number, available: number): number {
  if (available <= 0) return 0;
  return Math.max(0, column - available + 1);
}
