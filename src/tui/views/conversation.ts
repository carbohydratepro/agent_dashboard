/**
 * 会話ビュー。
 *
 * 4 種類を視覚的に必ず区別する:
 *   こちらの入力      … > 付き
 *   モデルの出力      … 枠付き（原文のまま。加工しない）
 *   サブエージェント  … インデント
 *   システムの出来事  … 区切り線
 */

import type { Screen } from '../screen.ts';
import type { AgentEvent, Session, Task } from '../../core/types.ts';
import type { TranscriptItem } from '../../core/sessions.ts';
import type { Theme } from '../theme.ts';
import { TextInput } from '../widgets/textinput.ts';
import { drawBox, fillRect, hline, textClipped, textRight, wrapText } from '../paint.ts';
import { renderMarkdown } from '../markdown.ts';
import type { CompletionState } from '../completion.ts';
import type { Span } from '../markdown.ts';
import { STATE_LABEL_JA } from '../theme.ts';
import { cursorPosition, dropWidth, scrollOffsetFor, truncate } from '../width.ts';

export type ConvEntry =
  | { t: 'user'; text: string }
  | { t: 'assistant'; text: string }
  | { t: 'tool'; name: string; detail: string; ok: boolean | null; nested: boolean }
  | { t: 'subagent'; label: string; text: string }
  | { t: 'system'; text: string };

/** 1 セッションあたりの保持上限。これを超えたら古いものから捨てる。 */
export const MAX_ENTRIES = 2_000;

export class ConversationState {
  readonly entries: ConvEntry[] = [];
  readonly input = new TextInput();
  showSubordinates = true;
  /** 末尾からの行数。0 は最下部に貼り付く。 */
  scrollFromBottom = 0;

  #assistantOpen = false;

  #push(entry: ConvEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  pushUser(text: string): void {
    this.#push({ t: 'user', text });
    this.#assistantOpen = false;
    this.scrollToBottom();
  }

  pushSystem(text: string): void {
    this.#push({ t: 'system', text });
    this.#assistantOpen = false;
  }

  /**
   * 引き継いだ会話ログから履歴を組み立てる（SPEC §8.1.1）。
   * これが無いと、取り込みしたセッションに何を指示すればよいか分からない。
   */
  seedFromTranscript(items: readonly TranscriptItem[], truncated: boolean): void {
    if (truncated) this.pushSystem('ここより前のやり取りは省略しています');
    for (const item of items) {
      if (item.t === 'user') this.#push({ t: 'user', text: item.text });
      else if (item.t === 'assistant') this.#push({ t: 'assistant', text: item.text });
      else this.#push({ t: 'tool', name: item.name, detail: item.detail, ok: true, nested: false });
    }
    this.#assistantOpen = false;
    this.scrollToBottom();
  }

  /** 進行中タスクのイベントから履歴を組み立て直す（画面を開いたとき用） */
  seedFromTask(task: Task): void {
    this.entries.push({ t: 'user', text: task.prompt });
    for (const ev of task.events) this.applyEvent(ev);
  }

  applyEvent(ev: AgentEvent): void {
    switch (ev.t) {
      case 'text': {
        if (ev.parentToolUseId) {
          this.#push({ t: 'subagent', label: 'サブエージェント', text: ev.delta });
          return;
        }
        const last = this.entries.at(-1);
        if (this.#assistantOpen && last?.t === 'assistant') last.text += ev.delta;
        else {
          this.#push({ t: 'assistant', text: ev.delta });
          this.#assistantOpen = true;
        }
        return;
      }
      case 'tool_start':
        this.#assistantOpen = false;
        this.#push({
          t: 'tool',
          name: ev.name,
          detail: ev.detail,
          ok: null,
          nested: ev.parentToolUseId !== undefined,
        });
        return;
      case 'tool_end': {
        for (let i = this.entries.length - 1; i >= 0; i -= 1) {
          const e = this.entries[i]!;
          if (e.t === 'tool' && e.name === ev.name && e.ok === null) {
            e.ok = ev.ok;
            break;
          }
        }
        return;
      }
      case 'subagent_start':
        this.#assistantOpen = false;
        this.#push({
          t: 'tool',
          name: 'Agent',
          detail: `「${ev.description}」(${ev.agentType})`,
          ok: null,
          nested: false,
        });
        return;
      case 'subagent_progress':
        this.#push({
          t: 'subagent',
          label: ev.lastToolName || '作業',
          text: `${ev.description}  ${ev.totalTokens} tok`,
        });
        return;
      case 'subagent_end':
        this.#push({ t: 'subagent', label: '報告', text: ev.summary || '完了' });
        return;
      case 'permission_denied':
        this.pushSystem(`承認待ちが上がりました — ${ev.toolName}`);
        return;
      case 'error':
        this.pushSystem(`エラー: ${ev.message}`);
        return;
      case 'turn_end':
        this.#assistantOpen = false;
        return;
      default:
        return;
    }
  }

  scrollToBottom(): void {
    this.scrollFromBottom = 0;
  }

  scrollBy(delta: number): void {
    this.scrollFromBottom = Math.max(0, this.scrollFromBottom - delta);
  }
}

export interface ConversationViewState {
  session: Session;
  conversation: ConversationState;
  theme: Theme;
  now: number;
  /** スラッシュコマンドの候補。無ければ出さない。 */
  completion?: CompletionState | null;
  /** 候補が出せない理由。候補の代わりに 1 行だけ出す。 */
  completionNote?: string | null;
  /** 知らせ。一覧画面と同じものを、ここでも出す。 */
  banner?: { text: string; color: number } | null;
}

/** 候補一覧に使う高さ */
export const COMPLETION_ROWS = 6;

export interface RenderedLine {
  /** 装飾ごとに分かれた断片。text だけ見れば素の文字列になる。 */
  spans: Span[];
  indent: number;
  boxed: boolean;
}

/** 断片をつないだ素の文字列。テストと検索に使う。 */
export function lineText(line: RenderedLine): string {
  return line.spans.map((s) => s.text).join('');
}

/**
 * 履歴を折り返して描画行にする。テストからも使う。
 *
 * モデルの出力だけはマークダウンとして解釈する。記号を装飾に置き換えるだけで、
 * 中身は変えない（コードブロックの中は一切触らない）。
 */
export function layoutEntries(
  entries: readonly ConvEntry[],
  width: number,
  theme: Theme,
  showSubagents: boolean,
): RenderedLine[] {
  const out: RenderedLine[] = [];

  for (const entry of entries) {
    switch (entry.t) {
      case 'user':
        for (const line of wrapText(entry.text, width - 4)) {
          out.push({
            spans: [{ text: `> ${line}`, style: { fg: theme.userText, bold: true } }],
            indent: 0,
            boxed: false,
          });
        }
        out.push({ spans: [], indent: 0, boxed: false });
        break;

      case 'assistant':
        for (const line of renderMarkdown(entry.text, { theme, width: width - 8 })) {
          out.push({ spans: line.spans, indent: 2 + line.indent, boxed: true });
        }
        break;

      case 'tool': {
        const mark = entry.ok === null ? '·' : entry.ok ? '✓' : '×';
        const color = entry.ok === false ? theme.gauge.critical : theme.system;
        out.push({
          spans: [{ text: `${mark} ${entry.name}  ${entry.detail}`, style: { fg: color } }],
          indent: entry.nested ? 4 : 2,
          boxed: false,
        });
        break;
      }

      case 'subagent':
        if (!showSubagents) break;
        out.push({
          spans: [
            {
              text: `└ ${entry.label}: ${entry.text}`,
              style: { fg: theme.state.delegating, dim: true },
            },
          ],
          indent: 4,
          boxed: false,
        });
        break;

      case 'system':
        out.push({
          spans: [{ text: `─── ${entry.text} `, style: { fg: theme.system } }],
          indent: 0,
          boxed: false,
        });
        break;
    }
  }
  return out;
}

export function drawConversation(screen: Screen, s: ConversationViewState): void {
  const { theme, session: session, conversation: conv } = s;
  fillRect(screen, 0, 0, screen.width, screen.height, theme.bg);

  // 枠の上下 2 行ぶんを足す。3 未満だと中身を書く場所が無くなる。
  const inputLineCount = conv.input.value.split('\n').length;
  const inputHeight = Math.min(7, Math.max(3, inputLineCount + 2));
  const memoRow = session.nextPrompt.trim() !== '' ? 1 : 0;
  const bodyTop = 1;
  const bodyHeight = screen.height - 1 - inputHeight - memoRow - 2;

  // ヘッダー。知らせがあれば、そちらを優先して出す。
  if (s.banner) {
    textClipped(screen, 1, 0, screen.width - 2, s.banner.text, {
      fg: s.banner.color,
      bg: theme.bg,
      bold: true,
    });
  } else {
    textClipped(screen, 1, 0, screen.width - 2, `${session.name} との会話`, {
      fg: theme.accent,
      bg: theme.bg,
      bold: true,
    });
    textRight(screen, 0, 0, screen.width - 1, `${STATE_LABEL_JA[session.state]}`, {
      fg: theme.state[session.state],
      bg: theme.bg,
    });
  }

  // 本文
  const lines = layoutEntries(conv.entries, screen.width - 2, theme, conv.showSubordinates);
  const start = Math.max(0, lines.length - bodyHeight - conv.scrollFromBottom);
  for (let i = 0; i < bodyHeight; i += 1) {
    const line = lines[start + i];
    if (!line) break;
    const y = bodyTop + i;
    if (line.boxed) screen.set(2, y, '│', { fg: theme.border, bg: theme.bg });

    let x = line.boxed ? 2 + line.indent : line.indent;
    for (const span of line.spans) {
      if (x >= screen.width - 1) break;
      x += screen.text(x, y, truncate(span.text, screen.width - 1 - x), {
        ...span.style,
        bg: span.style.bg ?? theme.bg,
      });
    }
  }

  // スラッシュコマンドの候補（入力欄の真上）
  const completion = s.completion ?? null;
  // 注記は候補があっても出す。codex では候補の意味そのものが違う。
  const note = s.completionNote ?? null;
  const completionRows =
    (completion ? Math.min(COMPLETION_ROWS, completion.candidates.length) : 0) + (note ? 1 : 0);

  let y = screen.height - 1 - inputHeight - memoRow - completionRows - 1;
  hline(screen, 0, y, screen.width, { fg: theme.border, bg: theme.bg });
  y += 1;

  if (note) {
    // 何も出ない理由が分からないと、壊れているのか使えないのか区別がつかない
    textClipped(screen, 2, y, screen.width - 4, note, { fg: theme.gauge.warn, bg: theme.bg });
    y += 1;
  }

  if (completion) {
    // 選択中が見えるように窓をずらす
    const start = Math.max(
      0,
      Math.min(completion.index - completionRows + 1, completion.candidates.length - completionRows),
    );
    for (let i = 0; i < completionRows; i += 1) {
      const command = completion.candidates[start + i];
      if (command === undefined) break;
      const selected = start + i === completion.index;
      const bg = selected ? theme.panelBg : theme.bg;
      fillRect(screen, 0, y, screen.width, 1, bg);
      textClipped(screen, 2, y, screen.width - 4, `/${command}`, {
        fg: selected ? theme.textBright : theme.text,
        bg,
        bold: selected,
      });
      if (selected) {
        textRight(screen, 0, y, screen.width - 2, `${completion.index + 1}/${completion.candidates.length}`, {
          fg: theme.textDim,
          bg,
        });
      }
      y += 1;
    }
  }

  // メモの提示
  if (memoRow) {
    const first = session.nextPrompt.split('\n')[0] ?? '';
    textClipped(screen, 1, y, screen.width - 20, `[m] 次: ${first}`, {
      fg: theme.accent,
      bg: theme.bg,
    });
    textRight(screen, 0, y, screen.width - 1, '[Enter で送信]', { fg: theme.textDim, bg: theme.bg });
    y += 1;
  }

  // 入力欄
  drawBox(screen, 0, y, screen.width, inputHeight, {
    style: { fg: theme.border, bg: theme.bg },
  });
  // カーソルが右端を越えたら横に流す。全角を打ち続けても入力が見えなくならない。
  const inputLines = conv.input.value.split('\n');
  const available = screen.width - 6;
  const pos = cursorPosition(conv.input.value, conv.input.cursor);
  const offset = scrollOffsetFor(pos.column, available);

  for (let i = 0; i < inputHeight - 2; i += 1) {
    const raw = inputLines[i];
    if (raw === undefined) break;
    const prefix = i === 0 ? '> ' : '  ';
    textClipped(screen, 2, y + 1 + i, screen.width - 4, prefix + dropWidth(raw, offset), {
      fg: theme.userText,
      bg: theme.bg,
    });
  }
  if (offset > 0) {
    screen.set(2, y + 1, '‹', { fg: theme.textDim, bg: theme.bg });
  }
  screen.set(
    Math.min(4 + pos.column - offset, screen.width - 2),
    y + 1 + Math.min(pos.line, inputHeight - 3),
    '▏',
    { fg: theme.userText, bg: theme.bg },
  );

  // キーバー
  textClipped(
    screen,
    1,
    screen.height - 1,
    screen.width - 2,
    s.completion
      ? '[Tab/↑↓]候補を選ぶ  [Enter]決定  [Esc]やめる'
      : '[Enter]送信 [Ctrl+J]改行 [Alt+e]下書き [Tab]サブ [Ctrl+C]中断 [Esc]戻る',
    { fg: theme.textDim, bg: theme.bg },
  );
}

