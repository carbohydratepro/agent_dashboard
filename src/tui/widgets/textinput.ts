/** 1 行〜複数行のテキスト入力。プロンプト履歴も持つ（SPEC §16 会話モード）。 */

import type { Key } from '../input.ts';
import { isPrintable } from '../input.ts';

export class TextInput {
  value = '';
  cursor = 0;
  readonly history: string[] = [];
  #historyIndex = -1;
  #draft = '';

  get isEmpty(): boolean {
    return this.value.trim() === '';
  }

  setValue(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  clear(): void {
    this.value = '';
    this.cursor = 0;
    this.#historyIndex = -1;
  }

  insert(str: string): void {
    this.value = this.value.slice(0, this.cursor) + str + this.value.slice(this.cursor);
    this.cursor += str.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
    this.cursor -= 1;
  }

  del(): void {
    if (this.cursor >= this.value.length) return;
    this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
  }

  left(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right(): void {
    this.cursor = Math.min(this.value.length, this.cursor + 1);
  }

  home(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.value.length;
  }

  /** 送信して履歴に積む。空なら null。 */
  submit(): string | null {
    const value = this.value.trim();
    if (value === '') return null;
    if (this.history.at(-1) !== value) this.history.push(value);
    this.clear();
    return value;
  }

  /** 入力欄が空のときだけ履歴を遡る（SPEC §16） */
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
    // ペーストと IME の確定文字列は、中身を解釈せずそのまま入れる
    if (k.name === 'paste') {
      this.insert(k.ch);
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
      return true;
    }
    if (k.ctrl && k.ch === 'k') {
      this.value = this.value.slice(0, this.cursor);
      return true;
    }
    return false;
  }
}
