/**
 * 既存セッションの取り込み（SPEC §8.1.1）。
 *
 * 選ぶ前に中身が見えないと、取り込んでよいか判断できない。
 * 一覧の下に、選択中の会話の直近のやり取りを出す。
 */

import type { Screen } from '../screen.ts';
import type { Theme } from '../theme.ts';
import type { ExistingSession, TranscriptItem } from '../../core/sessions.ts';
import { drawBox, fillRect, hline, textClipped, textRight, wrapText } from '../paint.ts';
import { displayWidth, padEnd, truncate } from '../width.ts';

/** 一覧の 1 行 */
export function sessionRow(session: ExistingSession, width: number): string {
  const when = new Date(session.updatedAt).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const head = `${padEnd(session.kind, 7)}${padEnd(when, 14)}`;
  // 表示幅で切る。全角の途中で割ると桁が崩れる。
  return truncate(`${head}${session.title}`, Math.max(0, width));
}

export interface ImportPreview {
  items: readonly TranscriptItem[];
  experience: { turns: number; filesEdited: number; commandsRun: number };
  truncated: boolean;
}

export interface ImportViewState {
  sessions: readonly ExistingSession[];
  index: number;
  scroll: number;
  theme: Theme;
  /** 選択中の会話の中身。読み込み前は null */
  preview: ImportPreview | null;
  /** セッション ID → 以前担当していたアーカイブ者の名前 */
  formerBySession?: ReadonlyMap<string, string>;
}

/** 一覧に使える高さ（残りはプレビュー） */
export function listHeight(screenHeight: number): number {
  return Math.max(3, Math.floor((screenHeight - 6) * 0.55));
}

export function drawImport(screen: Screen, s: ImportViewState): void {
  const { theme } = s;
  fillRect(screen, 0, 0, screen.width, screen.height, theme.bg);
  drawBox(screen, 0, 0, screen.width, screen.height, {
    style: { fg: theme.border, bg: theme.bg },
    title: `取り込み — 引き継げる会話 ${s.sessions.length} 件`,
    titleStyle: { fg: theme.accent, bg: theme.bg, bold: true },
    fill: theme.panelBg,
  });

  const inner = screen.width - 4;
  const rows = listHeight(screen.height);
  const start = Math.max(0, Math.min(s.scroll, Math.max(0, s.sessions.length - rows)));

  for (let i = 0; i < rows; i += 1) {
    const session = s.sessions[start + i];
    if (!session) break;
    const y = 2 + i;
    const selected = start + i === s.index;

    if (selected) {
      for (let x = 1; x < screen.width - 1; x += 1) screen.set(x, y, ' ', { bg: theme.border });
    }
    const former = s.formerBySession?.get(session.sessionId);
    const badge = former ? `  ← 元 ${former}` : '';
    textClipped(screen, 2, y, inner, sessionRow(session, inner - displayWidth(badge)), {
      fg: selected ? theme.textBright : session.kind === 'claude' ? theme.text : theme.system,
      bg: selected ? theme.border : theme.panelBg,
      bold: selected,
    });
    if (badge) {
      textRight(screen, 2, y, inner, badge, {
        fg: selected ? theme.textBright : theme.textDim,
        bg: selected ? theme.border : theme.panelBg,
      });
    }
  }

  if (s.sessions.length > rows) {
    textRight(screen, 2, 1, inner, ` ${s.index + 1}/${s.sessions.length} `, {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
  }

  // --- 選択中の会話の中身 ---
  const dividerY = 2 + rows;
  hline(screen, 1, dividerY, screen.width - 2, { fg: theme.border, bg: theme.panelBg });

  const selected = s.sessions[s.index];
  if (selected) {
    textClipped(screen, 2, dividerY, inner, ` ${selected.cwd || '(場所不明)'} `, {
      fg: theme.system,
      bg: theme.panelBg,
    });
    if (s.preview) {
      const e = s.preview.experience;
      textRight(
        screen,
        2,
        dividerY,
        inner,
        ` やり取り ${e.turns} 回 / 編集 ${e.filesEdited} / 実行 ${e.commandsRun} `,
        { fg: theme.textDim, bg: theme.panelBg },
      );
    }
  }

  const bodyTop = dividerY + 1;
  const bodyBottom = screen.height - 2;
  if (!s.preview) {
    textClipped(screen, 2, bodyTop, inner, '読み込み中…', { fg: theme.textDim, bg: theme.panelBg });
  } else {
    drawPreview(screen, s.preview, bodyTop, bodyBottom, inner, theme);
  }

  textClipped(screen, 2, screen.height - 1, inner, ' [↑↓] 選ぶ  [Enter] 取り込む  [Esc] 戻る ', {
    fg: theme.textDim,
    bg: theme.bg,
  });
}

/** 直近のやり取りを、下から詰めて出す */
function drawPreview(
  screen: Screen,
  preview: ImportPreview,
  top: number,
  bottom: number,
  inner: number,
  theme: Theme,
): void {
  const lines: Array<{ text: string; color: number; dim?: boolean }> = [];

  for (const item of preview.items) {
    if (item.t === 'user') {
      for (const line of wrapText(item.text, inner - 2)) {
        lines.push({ text: `> ${line}`, color: theme.userText });
      }
    } else if (item.t === 'assistant') {
      for (const line of wrapText(item.text, inner - 4)) {
        lines.push({ text: `  ${line}`, color: theme.text });
      }
    } else {
      // 引数は 1 行に潰してあるが、念のためここでも折り返さない
      lines.push({
        text: truncate(`  ⚙ ${item.name} ${item.detail}`, inner),
        color: theme.system,
        dim: true,
      });
    }
  }

  const height = bottom - top;
  const visible = lines.slice(-height);
  for (let i = 0; i < visible.length; i += 1) {
    const line = visible[i]!;
    textClipped(screen, 2, top + i, inner, line.text, {
      fg: line.color,
      bg: theme.panelBg,
      dim: line.dim,
    });
  }
  if (visible.length === 0) {
    textClipped(screen, 2, top, inner, '（やり取りを読み取れませんでした）', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
  }
}
