/**
 * モデルの出力に含まれるマークダウンを、端末で読める形にする。
 *
 * 方針:
 *   ・**情報は落とさない。** 記号を装飾に置き換えるだけで、中身は変えない。
 *     リンクの URL も捨てずに残す。
 *   ・コードブロックの中は一切解釈しない。書かれたとおりに出す。
 *   ・解釈できない記法は、そのままの文字として出す（壊れた表示にしない）。
 */

import type { Style } from './screen.ts';
import type { Theme } from './theme.ts';
import { charWidth, displayWidth } from './width.ts';

/** 同じ装飾が続く一続きの文字 */
export interface Span {
  text: string;
  style: Style;
}

export interface MarkdownLine {
  spans: Span[];
  /** 行頭に空ける桁数 */
  indent: number;
}

export interface MarkdownOptions {
  theme: Theme;
  width: number;
  /** 本文の基本色。省略するとテーマの text */
  baseColor?: number;
}

// ---------------------------------------------------------------------------
// インライン
// ---------------------------------------------------------------------------

interface InlineToken {
  text: string;
  style: Style;
}

/** `code` **bold** *italic* ~~strike~~ [text](url) を装飾に置き換える */
export function parseInline(text: string, opts: MarkdownOptions): InlineToken[] {
  /** 直前が単語の一部なら、_ は区切りではなく文字（snake_case を壊さない） */
  const afterWord = (at: number): boolean => /[\w\d]/.test(text[at - 1] ?? '');
  const base: Style = { fg: opts.baseColor ?? opts.theme.text };
  const out: InlineToken[] = [];
  let buffer = '';

  const flush = (): void => {
    if (buffer !== '') {
      out.push({ text: buffer, style: base });
      buffer = '';
    }
  };
  const push = (t: string, style: Style): void => {
    flush();
    if (t !== '') out.push({ text: t, style });
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);

    // `code`（バッククォートの数を合わせる。中は解釈しない）
    const code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      push(code[2]!, { fg: opts.theme.accent, bg: opts.theme.rowAlt });
      i += code[0].length;
      continue;
    }

    // [text](url) — URL も残す
    const link = /^\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(rest);
    if (link) {
      push(link[1]!, { fg: opts.theme.accent, underline: true });
      push(` ${link[2]!}`, { fg: opts.theme.textDim });
      i += link[0].length;
      continue;
    }

    // **bold** / __bold__
    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) {
      for (const t of parseInline(bold[2]!, opts)) {
        push(t.text, { ...t.style, bold: true, fg: opts.theme.textBright });
      }
      i += bold[0].length;
      continue;
    }

    // ~~strike~~
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest);
    if (strike) {
      push(strike[1]!, { ...base, strike: true, dim: true });
      i += strike[0].length;
      continue;
    }

    // *italic* / _italic_（単語の途中の _ は区切りにしない）
    const italic =
      rest[0] === '_' && afterWord(i) ? null : /^(\*|_)(?=\S)([^*_\n]*?\S)\1/.exec(rest);
    if (italic) {
      push(italic[2]!, { ...base, italic: true });
      i += italic[0].length;
      continue;
    }

    buffer += text[i]!;
    i += 1;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// 折り返し
// ---------------------------------------------------------------------------

/** 装飾を保ったまま表示幅で折り返す */
export function wrapSpans(tokens: InlineToken[], width: number, indent: number): MarkdownLine[] {
  if (width <= 0) return [];
  const lines: MarkdownLine[] = [];
  let spans: Span[] = [];
  let used = 0;

  const newline = (): void => {
    lines.push({ spans, indent });
    spans = [];
    used = 0;
  };

  for (const token of tokens) {
    let current = '';
    for (const ch of token.text) {
      if (ch === '\n') {
        if (current !== '') spans.push({ text: current, style: token.style });
        current = '';
        newline();
        continue;
      }
      const w = charWidth(ch);
      if (used + w > width) {
        if (current !== '') spans.push({ text: current, style: token.style });
        current = '';
        newline();
      }
      current += ch;
      used += w;
    }
    if (current !== '') spans.push({ text: current, style: token.style });
  }
  if (spans.length > 0 || lines.length === 0) newline();
  return lines;
}

// ---------------------------------------------------------------------------
// ブロック
// ---------------------------------------------------------------------------

const FENCE = /^\s*(```+|~~~+)\s*(\S*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])\s*(\1\s*){2,}$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/** 表の 1 行をセルに割る */
function tableCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line)?.[1] ?? '';
  return inner.split('|').map((c) => c.trim());
}

/**
 * マークダウンを描画行にする。
 * 解釈できない行は、そのままの文字として 1 行になる。
 */
export function renderMarkdown(text: string, opts: MarkdownOptions): MarkdownLine[] {
  const { theme, width } = opts;
  const lines = text.split('\n');
  const out: MarkdownLine[] = [];
  let i = 0;

  const plain = (s: string, style: Style, indent = 0): void => {
    for (const line of wrapSpans([{ text: s, style }], Math.max(1, width - indent), indent)) {
      out.push(line);
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;

    // コードブロック — 中は一切解釈しない
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2] ?? '';
      i += 1;
      if (lang !== '') {
        out.push({ spans: [{ text: lang, style: { fg: theme.textDim, italic: true } }], indent: 2 });
      }
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker[0]!.repeat(3))) {
        // 書かれたとおりに出す。長ければ切らずに折り返す。
        const body = lines[i]!;
        const chunks = hardWrap(body, Math.max(1, width - 4));
        for (const chunk of chunks) {
          out.push({
            spans: [{ text: chunk, style: { fg: theme.text, bg: theme.rowAlt } }],
            indent: 2,
          });
        }
        i += 1;
      }
      i += 1; // 閉じフェンス
      continue;
    }

    // 表
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const rows: string[][] = [tableCells(line)];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) {
        rows.push(tableCells(lines[i]!));
        i += 1;
      }
      out.push(...renderTable(rows, opts));
      continue;
    }

    if (RULE.test(line)) {
      out.push({
        spans: [{ text: '─'.repeat(Math.max(1, Math.min(width, 40))), style: { fg: theme.border } }],
        indent: 0,
      });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const tokens = parseInline(heading[2]!, opts);
      const style: Style = { fg: theme.accent, bold: true, underline: level === 1 };
      out.push(...wrapSpans(tokens.map((t) => ({ ...t, style })), width, 0));
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const tokens = parseInline(quote[1]!, { ...opts, baseColor: theme.textDim });
      for (const l of wrapSpans(tokens, Math.max(1, width - 2), 0)) {
        out.push({ spans: [{ text: '│ ', style: { fg: theme.border } }, ...l.spans], indent: 0 });
      }
      i += 1;
      continue;
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      const depth = Math.floor(bullet[1]!.length / 2);
      const indent = depth * 2;
      const tokens = parseInline(bullet[3]!, opts);
      const wrapped = wrapSpans(tokens, Math.max(1, width - indent - 2), indent + 2);
      const first = wrapped[0];
      if (first) {
        out.push({
          spans: [{ text: '• ', style: { fg: theme.accent } }, ...first.spans],
          indent,
        });
        out.push(...wrapped.slice(1));
      }
      i += 1;
      continue;
    }

    const ordered = ORDERED.exec(line);
    if (ordered) {
      const depth = Math.floor(ordered[1]!.length / 2);
      const indent = depth * 2;
      const marker = `${ordered[2]!}. `;
      const tokens = parseInline(ordered[3]!, opts);
      const wrapped = wrapSpans(tokens, Math.max(1, width - indent - marker.length), indent + marker.length);
      const first = wrapped[0];
      if (first) {
        out.push({
          spans: [{ text: marker, style: { fg: theme.accent } }, ...first.spans],
          indent,
        });
        out.push(...wrapped.slice(1));
      }
      i += 1;
      continue;
    }

    if (line.trim() === '') {
      out.push({ spans: [], indent: 0 });
      i += 1;
      continue;
    }

    out.push(...wrapSpans(parseInline(line, opts), width, 0));
    i += 1;
    void plain;
  }
  return out;
}

/** 折り返せない文字列を幅で切る（コードブロック用） */
function hardWrap(text: string, width: number): string[] {
  if (displayWidth(text) <= width) return [text];
  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width) {
      out.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += w;
  }
  if (current !== '') out.push(current);
  return out;
}

/** 表を桁の揃った形にする */
function renderTable(rows: string[][], opts: MarkdownOptions): MarkdownLine[] {
  const { theme, width } = opts;
  const columns = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];

  for (let c = 0; c < columns; c += 1) {
    widths.push(Math.max(...rows.map((r) => displayWidth(r[c] ?? ''))));
  }

  // 幅に収まらなければ、はみ出す列から削る
  const total = (): number => widths.reduce((a, b) => a + b, 0) + (columns - 1) * 3 + 2;
  while (total() > width && Math.max(...widths) > 4) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest] = widths[widest]! - 1;
  }

  const out: MarkdownLine[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const isHeader = r === 0;
    const spans: Span[] = [];
    for (let c = 0; c < columns; c += 1) {
      if (c > 0) spans.push({ text: ' │ ', style: { fg: theme.border } });
      const cell = rows[r]![c] ?? '';
      const w = widths[c]!;
      const clipped = displayWidth(cell) > w ? clip(cell, w) : cell;
      const pad = ' '.repeat(Math.max(0, w - displayWidth(clipped)));
      spans.push({
        text: clipped + pad,
        style: isHeader ? { fg: theme.textBright, bold: true } : { fg: theme.text },
      });
    }
    out.push({ spans, indent: 1 });

    if (isHeader) {
      const rule = widths.map((w) => '─'.repeat(w)).join('─┼─');
      out.push({ spans: [{ text: rule, style: { fg: theme.border } }], indent: 1 });
    }
  }
  return out;
}

function clip(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}
