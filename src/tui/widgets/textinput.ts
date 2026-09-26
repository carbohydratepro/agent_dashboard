/** 1 行〜複数行のテキスト入力。プロンプト履歴も持つ（SPEC §16 会話モード）。 */

import type { Key } from '../input.ts';
import { isPrintable } from '../input.ts';
import { charWidth, displayWidth } from '../width.ts';

/** セッションごとの入力履歴上限。長期利用でもメモリを増やし続けない。 */
export const MAX_INPUT_HISTORY = 500;

export interface TextInputLayout {
  /** 明示改行と画面幅による折り返しを反映した表示行 */
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
}

interface InputSegment {
  text: string;
  /** value 上の UTF-16 インデックス。end は改行文字を含まない。 */
  start: number;
  end: number;
}

/** 表示幅で入力を折り返す。カーソル移動用に元文字列上の範囲も残す。 */
function wrappedInputSegments(value: string, width: number): InputSegment[] {
  const available = Math.max(1, width);
  const out: InputSegment[] = [];
  let text = '';
  let used = 0;
  let start = 0;
  let index = 0;

  for (const ch of value) {
    if (ch === '\n') {
      out.push({ text, start, end: index });
      index += ch.length;
      start = index;
      text = '';
      used = 0;
      continue;
    }

    const cells = charWidth(ch);
    if (text !== '' && used + cells > available) {
      out.push({ text, start, end: index });
      start = index;
      text = '';
      used = 0;
    }
    text += ch;
    used += cells;
    index += ch.length;
  }
  out.push({ text, start, end: index });

  return out;
}

function cursorPosition(
  segments: readonly InputSegment[],
  cursor: number,
): { line: number; column: number } {
  let line = segments.length - 1;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const next = segments[i + 1];
    if (cursor < segment.end) {
      line = i;
      break;
    }
    if (cursor === segment.start) {
      line = i;
      break;
    }
    if (cursor === segment.end && next?.start !== cursor) {
      line = i;
      break;
    }
  }
  const segment = segments[line]!;
  return {
    line,
    column: displayWidth(segment.text.slice(0, Math.max(0, cursor - segment.start))),
  };
}

/** 長文入力の表示行と、折り返し後のカーソル位置を求める。 */
export function layoutTextInput(value: string, cursor: number, width: number): TextInputLayout {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const segments = wrappedInputSegments(value, width);
  const position = cursorPosition(segments, safeCursor);
  return {
    lines: segments.map((segment) => segment.text),
    cursorLine: position.line,
    cursorColumn: position.column,
  };
}

function cursorAtColumn(segment: InputSegment, column: number): number {
  let index = segment.start;
  let used = 0;
  for (const ch of segment.text) {
    const next = used + charWidth(ch);
    if (next > column) {
      return column - used < next - column ? index : index + ch.length;
    }
    used = next;
    index += ch.length;
  }
  return segment.end;
}

/**
 * 折り返しを含む見た目上の上下へ移動する。端を越える場合は null。
 * preferredColumn は連続して上下したときの横位置を保つための表示桁。
 */
export function verticalCursorTarget(
  value: string,
  cursor: number,
  width: number,
  direction: -1 | 1,
  preferredColumn: number | null = null,
): { cursor: number; preferredColumn: number } | null {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const segments = wrappedInputSegments(value, width);
  const current = cursorPosition(segments, safeCursor);
  const targetLine = current.line + direction;
  if (targetLine < 0 || targetLine >= segments.length) return null;
  const desired = preferredColumn ?? current.column;
  return {
    cursor: cursorAtColumn(segments[targetLine]!, desired),
    preferredColumn: desired,
  };
}

export class TextInput {
  value = '';
  cursor = 0;
  readonly history: string[] = [];
  #historyIndex = -1;
  #draft = '';
  #verticalColumn: number | null = null;

  get isEmpty(): boolean {
    return this.value.trim() === '';
  }

  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
    this.#verticalColumn = null;
  }

  clear(): void {
    this.value = '';
    this.cursor = 0;
    this.#historyIndex = -1;
    this.#verticalColumn = null;
  }

  insert(str: string): void {
    this.value = this.value.slice(0, this.cursor) + str + this.value.slice(this.cursor);
    this.cursor += str.length;
    this.#verticalColumn = null;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor -= 1;
    this.#verticalColumn = null;
  }

  del(): void {
    if (this.cursor >= this.value.length) return;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
    this.#verticalColumn = null;
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
    this.#verticalColumn = null;
  }

  right(): void {
    this.cursor = Math.min(this.value.length, this.cursor + 1);
    this.#verticalColumn = null;
  }

  home(): void {
    this.cursor = 0;
    this.#verticalColumn = null;
  }

  end(): void {
    this.cursor = this.value.length;
    this.#verticalColumn = null;
  }

  /** 見た目上の上下行へ動く。端なら false を返し、呼び出し側が履歴を辿る。 */
  moveVertical(direction: -1 | 1, width: number): boolean {
    const target = verticalCursorTarget(
      this.value,
      this.cursor,
      width,
      direction,
      this.#verticalColumn,
    );
    if (!target) {
      this.#verticalColumn = null;
      return false;
    }
    this.cursor = target.cursor;
    this.#verticalColumn = target.preferredColumn;
    return true;
  }

  /** 送信して履歴に積む。空なら null。 */
  submit(): string | null {
    const value = this.value.trim();
    if (value === '') return null;
    this.remember(value);
    this.clear();
    return value;
  }

  /** 過去に送った入力を履歴へ加える。再起動前の履歴復元にも使う。 */
  remember(value: string): void {
    const body = value.trim();
    if (body === '' || this.history.at(-1) === body) return;
    this.history.push(body);
    if (this.history.length > MAX_INPUT_HISTORY) {
      this.history.splice(0, this.history.length - MAX_INPUT_HISTORY);
    }
  }

  /** 現在の入力を退避しつつ履歴を遡る（SPEC §16） */
  historyPrev(): boolean {
    if (this.history.length === 0) return false;
    if (this.#historyIndex === -1) {
      this.#draft = this.value;
      this.#historyIndex = this.history.length;
    }
    if (this.#historyIndex === 0) return false;
    this.#historyIndex -= 1;
    this.setValue(this.history[this.#historyIndex]!);
    return true;
  }

  historyNext(): boolean {
    if (this.#historyIndex === -1) return false;
    this.#historyIndex += 1;
    if (this.#historyIndex >= this.history.length) {
      this.#historyIndex = -1;
      this.setValue(this.#draft);
      return true;
    }
    this.setValue(this.history[this.#historyIndex]!);
    return true;
  }

  /** キーを処理したら true。呼び出し側は false のときだけ自前で解釈する。 */
  handleKey(k: Key): boolean {
    // ペーストはキーとして解釈せず挿入する。端末/Windows由来のCR・CRLFも
    // 入力欄が扱うLFへ統一する。空行・字下げ・末尾改行は削らない。
    if (k.name === 'paste') {
      this.insert(k.ch.replace(/\r\n?/g, '\n'));
      return true;
    }
    if (isPrintable(k)) {
      this.insert(k.ch);
      return true;
    }
    // 改行は Ctrl+J / Alt+Enter / Shift+Enter のどれでも入る。
    // Alt+Enter は端末や WM に奪われることがあるため、複数を受ける。
    if (k.name === 'newline') {
      this.insert('\n');
      return true;
    }
    if (k.name === 'backspace') {
      this.backspace();
      return true;
    }
    if (k.name === 'delete') {
      this.del();
      return true;
    }
    if (k.name === 'left') {
      this.left();
      return true;
    }
    if (k.name === 'right') {
      this.right();
      return true;
    }
    if (k.name === 'home' || (k.ctrl && k.ch === 'a')) {
      this.home();
      return true;
    }
    if (k.name === 'end' || (k.ctrl && k.ch === 'e')) {
      this.end();
      return true;
    }
    if (k.ctrl && k.ch === 'u') {
      this.value = this.value.slice(this.cursor);
      this.cursor = 0;
      this.#verticalColumn = null;
      return true;
    }
    if (k.ctrl && k.ch === 'k') {
      this.value = this.value.slice(0, this.cursor);
      this.#verticalColumn = null;
      return true;
    }
    return false;
  }
}
