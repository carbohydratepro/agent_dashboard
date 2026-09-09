/**
 * セッション一覧（表）。
 * 画面の主役。1 行 1 セッションで、状態と数字が横に並ぶ。
 */

import type { Screen } from '../screen.ts';
import type { Rect } from '../layout.ts';
import type { Dashboard, Session } from '../../core/types.ts';
import { BUSY_STATES } from '../../core/types.ts';
import type { Theme } from '../theme.ts';
import { gaugeColor, sessionColor, STATE_LABEL } from '../theme.ts';
import { activityMark } from '../animation.ts';
import { drawGauge, fillRect, hline, textClipped, textRight } from '../paint.ts';
import { displayWidth, padEnd, padStart, truncate } from '../width.ts';
import { formatDuration, formatTokens } from './format.ts';

/** 列の定義。幅は固定で、余りは cwd 列に回す。 */
export interface Column {
  key: string;
  header: string;
  width: number;
  align?: 'right';
}

const COLUMNS: Column[] = [
  { key: 'mark', header: '', width: 2 },
  { key: 'name', header: 'セッション', width: 11 },
  { key: 'state', header: '状態', width: 9 },
  { key: 'context', header: 'コンテキスト', width: 19 },
  { key: 'uptime', header: '経過', width: 8, align: 'right' },
  { key: 'tasks', header: 'タスク', width: 6, align: 'right' },
  { key: 'edits', header: '編集', width: 4, align: 'right' },
  { key: 'cmds', header: '実行', width: 4, align: 'right' },
  { key: 'tokens', header: 'トークン', width: 8, align: 'right' },
  { key: 'flags', header: '', width: 4 },
  { key: 'model', header: 'モデル', width: 20 },
  { key: 'activity', header: 'いま何をしているか', width: 0 },
];

/**
 * その幅で出す列。
 *
 * スマホから SSH で覗くと 40 桁ほどしかない。狭いところから順に、
 * 無くても困らないものを落としていく。残す順は
 * 「何が・どうなっている・何をしている」を最後まで守る。
 */
export const MODEL_COLUMN_MIN_WIDTH = 124;

/** 落としていく順（先に書いたものから落とす） */
const DROP_ORDER = ['model', 'edits', 'cmds', 'uptime', 'tokens', 'tasks', 'flags', 'state'];

export function columnsFor(width: number): Column[] {
  // 可変幅の列に最低これだけは残す
  const need = 14;
  let columns = COLUMNS;

  for (const key of DROP_ORDER) {
    const fixed = columns.reduce((sum, c) => sum + c.width + GAP, 0);
    if (fixed + need <= width) break;
    columns = columns.filter((c) => c.key !== key);
  }

  // コンテキストのゲージは狭いと場所を食うだけ。数字だけにする。
  const fixed = columns.reduce((sum, c) => sum + c.width + GAP, 0);
  if (fixed + need > width) {
    columns = columns.map((c) => (c.key === 'context' ? { ...c, width: 5, header: 'ctx' } : c));
  }
  return columns;
}

/** ゲージを描くだけの幅があるか */
export function hasContextGauge(columns: Column[]): boolean {
  return (columns.find((c) => c.key === 'context')?.width ?? 0) >= 12;
}

export interface CodexDefaults {
  model: string | null;
  effort: string | null;
}

/**
 * そのセッションが実際に使うモデルと推論の深さ。
 *
 * codex は exec の出力にモデルを載せてこないので、指定していなければ
 * config.toml の既定がそのまま効く。claude は CLI が報告してくる。
 */
export function modelFor(session: Session, defaults?: CodexDefaults): string {
  const model =
    session.modelOverride ??
    (session.kind === 'codex' ? (session.model ?? defaults?.model ?? null) : session.model);
  if (!model) return '';

  const effort =
    session.kind === 'codex' ? (session.reasoningOverride ?? defaults?.effort ?? null) : null;
  return effort ? `${model}/${effort}` : model;
}

const GAP = 1;

/** 可変幅の列（作業内容）に回せる幅を計算する */
function flexWidth(total: number, columns: Column[]): number {
  const fixed = columns.reduce((sum, c) => sum + c.width + GAP, 0);
  return Math.max(12, total - fixed - 1);
}

export interface TableViewState {
  dashboard: Dashboard;
  /** codex の config.toml の既定。指定していないセッションはこれが効く。 */
  codexDefaults?: CodexDefaults;
  selected: number;
  frame: number;
  now: number;
  theme: Theme;
  animate: boolean;
  ascii?: boolean;
}

/** 一覧に出す行。空きスロットも 1 行として並べる。 */
export function tableRows(dashboard: Dashboard): Array<Session | null> {
  const bySlot = new Map<number, Session>();
  for (const s of dashboard.sessions) {
    if (!s.archived) bySlot.set(s.slot, s);
  }
  const rows: Array<Session | null> = [];
  for (let i = 0; i < dashboard.slotCount; i += 1) rows.push(bySlot.get(i) ?? null);
  return rows;
}

/**
 * その行に出す「いま何をしているか」。
 *
 * 動いている間は最後に始まったツールを出す。止まっているときに出すものが
 * 無いので、代わりに作業ディレクトリを出す（列を 2 つに割るには幅が足りない）。
 */
export function activityText(session: Session): { text: string; busy: boolean } {
  const task = session.currentTask;
  if (task && BUSY_STATES.has(session.state)) {
    for (let i = task.events.length - 1; i >= 0; i -= 1) {
      const ev = task.events[i]!;
      if (ev.t === 'tool_start') {
        return { text: ev.detail ? `${ev.name}  ${ev.detail}` : ev.name, busy: true };
      }
      if (ev.t === 'subagent_start') {
        return { text: `Agent (${ev.agentType})  ${ev.description}`, busy: true };
      }
    }
    // ツールを呼ぶ前。何を頼まれたかを出しておく。
    if (task.prompt !== '') return { text: task.prompt, busy: true };
  }
  return { text: session.workspace.requestedCwd, busy: false };
}

/**
 * 選択行が見えるようにスクロール量を決める。
 *
 * 前回位置を持たず選択位置だけから決める。選択が下端に達したらそこで止まるので、
 * 上下に動かしても行が飛ばない。
 */
export function tableScrollOffset(selected: number, rowCount: number, visible: number): number {
  if (visible <= 0 || rowCount <= visible) return 0;
  const max = rowCount - visible;
  return Math.max(0, Math.min(selected - visible + 1, max));
}

/** 長いパスは先頭を省いて末尾を見せる */
export function tailPath(path: string, width: number): string {
  if (displayWidth(path) <= width) return path;
  let out = '';
  for (const ch of [...path].reverse()) {
    if (displayWidth(out) + displayWidth(ch) > width - 1) break;
    out = ch + out;
  }
  return `…${out}`;
}

/** 短い印。付いている条件が一目で分かるように。 */
export function flagsFor(session: Session): string {
  let out = '';
  if (session.workspace.isolation === 'worktree') out += 'W';
  if (session.drafts.length > 0) out += 'P';
  if (session.pendingApprovals.length > 0) out += '!';
  if (session.subagents.length > 0) out += 'S';
  return out;
}

export function drawTable(screen: Screen, rect: Rect, s: TableViewState): void {
  const { theme } = s;
  fillRect(screen, rect.x, rect.y, rect.w, rect.h, theme.bg);

  const columns = columnsFor(rect.w);
  const flex = flexWidth(rect.w, columns);
  const widths = columns.map((c) => (c.key === 'activity' ? flex : c.width));

  // 見出し
  let x = rect.x + 1;
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i]!;
    const w = widths[i]!;
    if (col.header !== '') {
      textClipped(screen, x, rect.y, w, col.header, { fg: theme.textDim, bg: theme.bg });
    }
    x += w + GAP;
  }
  hline(screen, rect.x, rect.y + 1, rect.w, { fg: theme.border, bg: theme.bg });

  const rows = tableRows(s.dashboard);
  const visible = rect.h - 2;
  const offset = tableScrollOffset(s.selected, rows.length, visible);

  for (let i = 0; i < visible && offset + i < rows.length; i += 1) {
    const row = offset + i;
    const y = rect.y + 2 + i;
    const session = rows[row]!;
    const selected = row === s.selected;
    const bg = selected ? theme.panelBg : row % 2 === 1 ? theme.rowAlt : theme.bg;

    fillRect(screen, rect.x, y, rect.w, 1, bg);
    if (session) drawRow(screen, rect, y, session, columns, widths, bg, selected, s);
    else drawEmptyRow(screen, rect, y, row, widths, bg, selected, theme);
  }

  // 画面に入りきらない行があることを見出しの右端で知らせる
  const above = offset;
  const below = Math.max(0, rows.length - offset - visible);
  if (above > 0 || below > 0) {
    const marks = [above > 0 ? `↑${above}` : '', below > 0 ? `↓${below}` : '']
      .filter((t) => t !== '')
      .join(' ');
    textRight(screen, rect.x, rect.y, rect.w - 1, marks, { fg: theme.textDim, bg: theme.bg });
  }
}

function drawRow(
  screen: Screen,
  rect: Rect,
  y: number,
  session: Session,
  columns: Column[],
  widths: number[],
  bg: number,
  selected: boolean,
  s: TableViewState,
): void {
  const { theme } = s;
  let x = rect.x + 1;

  // 列は幅によって出たり出なかったりするので、番号ではなくキーで引く。
  const indexOf = (key: string): number => columns.findIndex((c) => c.key === key);
  const cell = (key: string, text: string, fg: number, bold = false): void => {
    const i = indexOf(key);
    if (i < 0) return;
    const col = columns[i]!;
    const w = widths[i]!;
    const t = truncate(text, w);
    // 右寄せは表示幅で測る。文字数だと全角でずれる。
    const offset = col.align === 'right' ? w - displayWidth(t) : 0;
    screen.text(x + offset, y, t, { fg, bg, bold });
    x += w + GAP;
  };

  // 実行中を示す印。動いていないときに未読の結果があれば、そちらを優先する。
  if (!BUSY_STATES.has(session.state) && session.unseenResult !== null) {
    const done = session.unseenResult === 'done';
    cell(
      'mark',
      done ? (s.ascii ? '*' : '✓') : (s.ascii ? '!' : '×'),
      done ? theme.gauge.good : theme.gauge.critical,
      true,
    );
  } else {
    cell('mark', activityMark(session.state, s.animate ? s.frame : 0, s.ascii), theme.state[session.state]);
  }
  cell('name', session.name, selected ? theme.textBright : sessionColor(theme, session.color), selected);
  cell('state', STATE_LABEL[session.state], theme.state[session.state]);

  // コンテキストはゲージ + 数値。狭いときは数値だけ。
  const ctxIndex = indexOf('context');
  if (ctxIndex >= 0) {
    const ctxW = widths[ctxIndex]!;
    const pct = Math.round(session.context.ratio * 100);
    const mark = session.context.estimated ? '~' : '';
    if (hasContextGauge(columns)) {
      const gaugeW = Math.max(4, ctxW - 7);
      drawGauge(screen, x, y, gaugeW, session.context.ratio, {
        filled: gaugeColor(theme, session.context.ratio),
        emptyStyle: { fg: theme.border, bg },
      });
      screen.text(x + gaugeW + 1, y, `${padStart(String(pct), 3)}%${mark}`, { fg: theme.text, bg });
    } else {
      screen.text(x, y, padStart(`${pct}%${mark}`, ctxW), {
        fg: gaugeColor(theme, session.context.ratio),
        bg,
      });
    }
    x += ctxW + GAP;
  }

  const elapsed = s.now - session.uptime.startedAt;
  cell('uptime', formatDuration(elapsed), theme.textDim);
  cell('tasks', String(session.stats.tasksCompleted), theme.text);
  cell('edits', String(session.stats.filesEdited), theme.textDim);
  cell('cmds', String(session.stats.commandsRun), theme.textDim);
  cell('tokens', formatTokens(session.stats.totalTokensIn + session.stats.totalTokensOut), theme.textDim);
  cell('flags', flagsFor(session), theme.accent);
  cell('model', modelFor(session, s.codexDefaults) || '—', theme.textDim);

  // 動いていれば作業内容、止まっていれば作業ディレクトリ。
  // パスは末尾のほうが情報量が多いので、長ければ先頭を省く。
  const activity = activityText(session);
  const activityWidth = widths[indexOf('activity')] ?? 20;
  cell(
    'activity',
    activity.busy ? activity.text : tailPath(activity.text, activityWidth),
    activity.busy ? theme.text : theme.system,
  );
}

function drawEmptyRow(
  screen: Screen,
  rect: Rect,
  y: number,
  index: number,
  widths: number[],
  bg: number,
  selected: boolean,
  theme: Theme,
): void {
  const x = rect.x + 1 + widths[0]! + GAP;
  textClipped(screen, x, y, rect.w - x, `${padEnd('—', widths[1]!)} 空き  [n] で追加`, {
    fg: selected ? theme.text : theme.textDim,
    bg,
    bold: selected,
  });
  void index;
}
