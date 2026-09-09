/**
 * 画面の領域計算。
 *
 * スマホから SSH で覗くと 40x20 ほどしかない。列を落として収まるようにしてあるので、
 * 最小はそこまで下げる。これ未満は何を出しても読めないので断る。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_WIDTH = 36;
export const MIN_HEIGHT = 14;

/** 一覧の見出し 1 行 + 罫線 1 行 */
const TABLE_CHROME = 2;

export interface Layout {
  header: Rect;
  usage: Rect;
  /** セッション一覧（表） */
  table: Rect;
  detail: Rect;
  footer: Rect;
}

export function computeLayout(width: number, height: number, rowCount: number): Layout {
  const header: Rect = { x: 0, y: 0, w: width, h: 1 };
  const usage: Rect = { x: 0, y: 1, w: width, h: 1 };
  const footer: Rect = { x: 0, y: height - 1, w: width, h: 1 };

  // 一覧は行数ぶん。残りを詳細に回す。
  // 画面が低いと詳細が潰れるので、一覧に回す割合を下げる。
  const share = height < 24 ? 0.5 : 0.6;
  const tableHeight = Math.min(rowCount + TABLE_CHROME, Math.max(3, Math.floor((height - 4) * share)));
  const table: Rect = { x: 0, y: usage.y + usage.h, w: width, h: tableHeight };
  const detail: Rect = {
    x: 0,
    y: table.y + table.h,
    w: width,
    h: Math.max(1, footer.y - (table.y + table.h)),
  };

  return { header, usage, table, detail, footer };
}

export function tooSmall(width: number, height: number): boolean {
  return width < MIN_WIDTH || height < MIN_HEIGHT;
}
