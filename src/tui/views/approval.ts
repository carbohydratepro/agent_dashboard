/**
 * 承認画面（SPEC §8.4）。
 * permission_denials に完全な tool_input が残るので、何をしようとしたかを
 * 差分まで含めて正確に描ける。
 */

import type { Screen } from '../screen.ts';
import type { ApprovalRequest, Session } from '../../core/types.ts';
import type { Theme } from '../theme.ts';
import type { TextInput } from '../widgets/textinput.ts';
import { drawBox, fillRect, textCentered, textClipped, wrapText } from '../paint.ts';

export interface ApprovalViewState {
  session: Session;
  index: number;
  theme: Theme;
  rejectInput: TextInput | null;
}

export interface DiffLine {
  text: string;
  kind: 'add' | 'remove' | 'context';
}

/** 差分計算をかける行数の上限。これを超えたら全消し全足しで見せる。 */
const DIFF_LINE_LIMIT = 400;

/**
 * 行単位の差分。最長共通部分列で並びを保つ。
 * 素朴な集合比較だと同じ行が複数あるときに順序が壊れるので、ちゃんと解く。
 */
export function lineDiff(before: string[], after: string[]): DiffLine[] {
  if (before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT) {
    return [
      ...before.map((text): DiffLine => ({ text, kind: 'remove' })),
      ...after.map((text): DiffLine => ({ text, kind: 'add' })),
    ];
  }

  const n = before.length;
  const m = after.length;
  // lcs[i][j] = before[i..] と after[j..] の最長共通部分列の長さ
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ text: before[i]!, kind: 'context' });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ text: before[i]!, kind: 'remove' });
      i += 1;
    } else {
      out.push({ text: after[j]!, kind: 'add' });
      j += 1;
    }
  }
  while (i < n) out.push({ text: before[i++]!, kind: 'remove' });
  while (j < m) out.push({ text: after[j++]!, kind: 'add' });
  return out;
}

/** 変更のない行が続くところを畳む。前後 2 行だけ残す。 */
export function collapseContext(lines: DiffLine[], keep = 2): DiffLine[] {
  const out: DiffLine[] = [];
  let run = 0;

  const flush = (atEnd: boolean): void => {
    if (run === 0) return;
    const start = out.length - run;
    const block = out.splice(start, run);
    if (block.length > keep * 2 + 1) {
      const head = block.slice(0, atEnd ? keep : keep);
      const tail = block.slice(-keep);
      out.push(...(out.length === 0 ? [] : head));
      out.push({ text: `… ${block.length - keep * 2} 行省略 …`, kind: 'context' });
      if (!atEnd) out.push(...tail);
    } else {
      out.push(...block);
    }
    run = 0;
  };

  for (const line of lines) {
    if (line.kind === 'context') {
      out.push(line);
      run += 1;
    } else {
      flush(false);
      out.push(line);
    }
  }
  flush(true);
  return out;
}

/**
 * tool_input から見せる差分を作る。
 * Edit は old/new、Write は全部追加、それ以外は差分なし。
 */
export function diffLines(input: Record<string, unknown>): DiffLine[] {
  const oldStr = typeof input.old_string === 'string' ? input.old_string : null;
  const newStr = typeof input.new_string === 'string' ? input.new_string : null;

  if (oldStr !== null || newStr !== null) {
    return collapseContext(lineDiff((oldStr ?? '').split('\n'), (newStr ?? '').split('\n')));
  }

  // Write: 中身がまるごと新規
  const content = typeof input.content === 'string' ? input.content : null;
  if (content !== null) {
    return content.split('\n').map((text): DiffLine => ({ text, kind: 'add' }));
  }
  return [];
}

/** 承認の対象を 1 行で表す */
export function approvalTarget(a: ApprovalRequest): string {
  const input = a.toolInput;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.path === 'string') return input.path;
  return '';
}

export function drawApproval(screen: Screen, s: ApprovalViewState): void {
  const { theme, session } = s;
  const approvals = session.pendingApprovals;
  const approval = approvals[s.index];
  if (!approval) return;

  fillRect(screen, 0, 0, screen.width, screen.height, theme.bg);
  const w = Math.min(96, screen.width - 4);
  const h = screen.height - 4;
  const x = Math.floor((screen.width - w) / 2);
  const y = 2;

  const counter = approvals.length > 1 ? `  (${s.index + 1}/${approvals.length})` : '';
  drawBox(screen, x, y, w, h, {
    style: { fg: theme.gauge.high, bg: theme.panelBg },
    title: `承認待ち — ${session.name}${counter}`,
    titleStyle: { fg: theme.gauge.high, bg: theme.panelBg, bold: true },
    fill: theme.panelBg,
  });

  let row = y + 1;
  const inner = w - 4;

  row += 1;

  textClipped(screen, x + 2, row, inner, `種別: ${approval.toolName}`, {
    fg: theme.textBright,
    bg: theme.panelBg,
    bold: true,
  });
  row += 1;
  const target = approvalTarget(approval);
  if (target) {
    textClipped(screen, x + 2, row, inner, `対象: ${target}`, { fg: theme.text, bg: theme.panelBg });
    row += 1;
  }
  row += 1;

  const diff = diffLines(approval.toolInput);
  const bodyBottom = y + h - 5;
  if (diff.length > 0) {
    for (const line of diff) {
      if (row >= bodyBottom) break;
      const mark = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
      const color =
        line.kind === 'add'
          ? theme.gauge.good
          : line.kind === 'remove'
            ? theme.gauge.critical
            : theme.textDim;
      textClipped(screen, x + 3, row, inner - 2, `${mark} ${line.text}`, {
        fg: color,
        bg: theme.panelBg,
        dim: line.kind === 'context',
      });
      row += 1;
    }
    if (row >= bodyBottom && diff.length > 0) {
      textClipped(screen, x + 3, bodyBottom - 1, inner - 2, '… 以下省略 …', {
        fg: theme.textDim,
        bg: theme.panelBg,
        dim: true,
      });
    }
  } else {
    for (const line of wrapText(JSON.stringify(approval.toolInput, null, 1), inner - 2)) {
      if (row >= bodyBottom) break;
      textClipped(screen, x + 3, row, inner - 2, line, { fg: theme.textDim, bg: theme.panelBg });
      row += 1;
    }
  }

  row = bodyBottom;
  for (const line of wrapText(`理由: ${approval.message}`, inner)) {
    if (row >= y + h - 2) break;
    textClipped(screen, x + 2, row, inner, line, { fg: theme.textDim, bg: theme.panelBg });
    row += 1;
  }

  if (s.rejectInput) {
    textClipped(screen, x + 2, y + h - 2, inner, `却下の理由 > ${s.rejectInput.value}▏`, {
      fg: theme.textBright,
      bg: theme.panelBg,
    });
    return;
  }

  const hints =
    approvals.length > 1
      ? '[y] 承認   [n] 却下   [a] 以後このツールを常に許可   [j/k] 切替   [Esc] あとで'
      : '[y] 承認   [n] 却下   [a] 以後このツールを常に許可   [Esc] あとで';
  textCentered(screen, x, y + h - 2, w, hints, { fg: theme.textDim, bg: theme.panelBg });
}
