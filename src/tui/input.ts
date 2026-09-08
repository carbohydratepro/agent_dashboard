/**
 * 端末から届くバイト列をキーに直す（SPEC §16）。
 *
 * 日本語入力のために気を使っているところ:
 *   ・マルチバイト文字がチャンクの境目で割れても壊さない（StringDecoder）
 *   ・エスケープ列が途中で切れたら、続きが来るまで待つ
 *   ・ブラケットペーストで囲まれた入力は、中身を解釈せずそのまま文字として扱う
 *     （IME の確定文字列がショートカットとして誤爆しないように）
 */

import { StringDecoder } from 'node:string_decoder';

export type KeyName =
  | 'char'
  | 'paste'
  | 'up' | 'down' | 'left' | 'right'
  | 'enter' | 'newline' | 'escape' | 'tab' | 'backtab'
  | 'backspace' | 'delete'
  | 'home' | 'end' | 'pageup' | 'pagedown'
  | 'wheelup' | 'wheeldown'
  | 'unknown';

export interface Key {
  name: KeyName;
  /** name が 'char' なら 1 文字、'paste' なら貼り付けられた文字列 */
  ch: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  raw: string;
}

function key(name: KeyName, opts: Partial<Key> = {}): Key {
  return { name, ch: '', ctrl: false, alt: false, shift: false, raw: '', ...opts };
}

const CSI_NAMES: Record<string, KeyName> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
};

const TILDE_NAMES: Record<string, KeyName> = {
  '1': 'home',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
};

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

/** s 全体が full の先頭部分か（まだ続きが来る可能性がある） */
function isPartialOf(s: string, full: string): boolean {
  return s.length < full.length && full.startsWith(s);
}

/** s の末尾が marker の先頭部分に一致する最大長 */
function partialSuffixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (marker.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/**
 * 状態を持つデコーダ。チャンクの切れ目をまたいでも壊れない。
 * 確定できない並びは溜めておき、flush() で強制的に確定させる。
 */
export class KeyDecoder {
  #decoder = new StringDecoder('utf8');
  #pending = '';
  #pasting = false;
  #pasteBuffer = '';

  get hasPending(): boolean {
    return this.#pending !== '' || this.#pasting;
  }

  write(chunk: Buffer | string): Key[] {
    this.#pending += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    return this.#drain(false);
  }

  /** 溜まっているものを確定させる。単独の ESC はここで Esc になる。 */
  flush(): Key[] {
    const keys = this.#drain(true);
    if (this.#pasting && this.#pasteBuffer !== '') {
      // 終端が来ないまま切れた。貼り付けた分だけでも渡す。
      keys.push(key('paste', { ch: this.#pasteBuffer, raw: this.#pasteBuffer }));
      this.#pasteBuffer = '';
      this.#pasting = false;
    }
    return keys;
  }

  #drain(force: boolean): Key[] {
    const keys: Key[] = [];

    for (;;) {
      if (this.#pasting) {
        const end = this.#pending.indexOf(PASTE_END);
        if (end < 0) {
          // 終端待ち。末尾が終端の途中かもしれないぶんだけ残す。
          const keep = partialSuffixLen(this.#pending, PASTE_END);
          this.#pasteBuffer += this.#pending.slice(0, this.#pending.length - keep);
          this.#pending = this.#pending.slice(this.#pending.length - keep);
          return keys;
        }
        this.#pasteBuffer += this.#pending.slice(0, end);
        this.#pending = this.#pending.slice(end + PASTE_END.length);
        this.#pasting = false;
        if (this.#pasteBuffer !== '') {
          keys.push(key('paste', { ch: this.#pasteBuffer, raw: this.#pasteBuffer }));
        }
        this.#pasteBuffer = '';
        continue;
      }

      if (this.#pending === '') return keys;

      if (this.#pending.startsWith(PASTE_START)) {
        this.#pending = this.#pending.slice(PASTE_START.length);
        this.#pasting = true;
        continue;
      }
      // ペースト開始の途中まで届いている可能性
      if (!force && isPartialOf(this.#pending, PASTE_START)) return keys;

      const consumed = decodeOne(this.#pending, keys, force);
      if (consumed === 0) return keys;
      this.#pending = this.#pending.slice(consumed);
    }
  }
}

/** 先頭から 1 キーぶん読む。読み切れなければ 0（force なら必ず 1 以上）。 */
function decodeOne(s: string, out: Key[], force: boolean): number {
  const ch = s[0]!;

  if (ch === '\x1b') {
    const consumed = decodeEscape(s, 0, out);
    if (consumed > 0) return consumed;
    if (!force) return 0;
    out.push(key('escape', { raw: ch }));
    return 1;
  }

  // Enter は CR、Ctrl+J は LF。raw モードでは別のバイトなので区別できる。
  // Alt+Enter は端末や WM に奪われがちなので、改行はこちらを主に使う。
  if (ch === '\r') {
    out.push(key('enter', { raw: ch }));
    return 1;
  }
  if (ch === '\n') {
    out.push(key('newline', { ctrl: true, ch: 'j', raw: ch }));
    return 1;
  }
  if (ch === '\t') {
    out.push(key('tab', { raw: ch }));
    return 1;
  }
  if (ch === '\x7f' || ch === '\b') {
    out.push(key('backspace', { raw: ch }));
    return 1;
  }

  const code = ch.charCodeAt(0);
  if (code < 0x20) {
    out.push(key('char', { ch: String.fromCharCode(code + 96), ctrl: true, raw: ch }));
    return 1;
  }

  // サロゲートペアを割らない
  const cp = s.codePointAt(0)!;
  const str = String.fromCodePoint(cp);
  out.push(key('char', { ch: str, raw: str }));
  return str.length;
}

/**
 * 文字コードと修飾から Key を作る。CSI-u / modifyOtherKeys 用。
 * Shift+Enter はここを通って改行になる。
 */
function fromKeyCode(code: number, modifier: number, raw: string): Key {
  const shift = (modifier & 1) !== 0;
  const alt = (modifier & 2) !== 0;
  const ctrl = (modifier & 4) !== 0;

  if (code === 13) {
    // 修飾付きの Enter は改行。素の Enter は送信。
    return key(shift || alt || ctrl ? 'newline' : 'enter', { ctrl, alt, shift, raw });
  }
  if (code === 9) return key(shift ? 'backtab' : 'tab', { ctrl, alt, shift, raw });
  if (code === 27) return key('escape', { ctrl, alt, shift, raw });
  if (code === 127 || code === 8) return key('backspace', { ctrl, alt, shift, raw });
  if (Number.isFinite(code) && code >= 32) {
    return key('char', { ch: String.fromCodePoint(code), ctrl, alt, shift, raw });
  }
  return key('unknown', { ctrl, alt, shift, raw });
}

/** ESC で始まる並びを読む。読めた長さを返す。0 なら未確定。 */
function decodeEscape(chunk: string, start: number, out: Key[]): number {
  const next = chunk[start + 1];
  if (next === undefined) return 0;

  // CSI: ESC [ ...
  if (next === '[') {
    let i = start + 2;
    let params = '';
    // '<' は SGR マウスの頭。ここで弾くと並びが途中で切れる。
    while (i < chunk.length && /[0-9;<]/.test(chunk[i]!)) {
      params += chunk[i]!;
      i += 1;
    }
    const final = chunk[i];
    if (final === undefined) return 0;

    const modifier = Number(params.split(';')[1] ?? '1') - 1;
    const shift = (modifier & 1) !== 0;
    const alt = (modifier & 2) !== 0;
    const ctrl = (modifier & 4) !== 0;
    const raw = chunk.slice(start, i + 1);

    // SGR マウス: ESC [ < <ボタン> ; <桁> ; <行> M（押下）/ m（解放）
    // ホイールはボタン 64（上）/ 65（下）。それ以外の押下は捨てる。
    if (params.startsWith('<') && (final === 'M' || final === 'm')) {
      const button = Number(params.slice(1).split(';')[0] ?? '');
      if (final === 'M' && button === 64) out.push(key('wheelup', { raw }));
      else if (final === 'M' && button === 65) out.push(key('wheeldown', { raw }));
      // クリックやドラッグは使わない。捨てて入力欄に紛れ込ませない。
      return i + 1 - start;
    }

    // xterm の modifyOtherKeys: ESC [ 27 ; <mod> ; <code> ~
    if (final === '~' && params.startsWith('27;')) {
      const parts = params.split(';');
      const code = Number(parts[2] ?? '');
      const mod = Number(parts[1] ?? '1') - 1;
      out.push(fromKeyCode(code, mod, raw));
      return i + 1 - start;
    }

    // kitty などの CSI-u: ESC [ <code> ; <mod> u
    if (final === 'u') {
      const code = Number(params.split(';')[0] ?? '');
      out.push(fromKeyCode(code, modifier, raw));
      return i + 1 - start;
    }

    if (final === '~') {
      const name = TILDE_NAMES[params.split(';')[0] ?? ''] ?? 'unknown';
      out.push(key(name, { ctrl, alt, shift, raw }));
      return i + 1 - start;
    }
    const name = CSI_NAMES[final];
    if (name) {
      out.push(key(name, { ctrl, alt, shift: name === 'backtab' ? true : shift, raw }));
      return i + 1 - start;
    }
    out.push(key('unknown', { raw }));
    return i + 1 - start;
  }

  // SS3: ESC O A など
  if (next === 'O') {
    const final = chunk[start + 2];
    if (final === undefined) return 0;
    const name = CSI_NAMES[final] ?? 'unknown';
    out.push(key(name, { raw: chunk.slice(start, start + 3) }));
    return 3;
  }

  // Alt+Enter。届けば改行として扱う（端末が横取りしなければ）
  if (next === '\r' || next === '\n') {
    out.push(key('newline', { alt: true, raw: chunk.slice(start, start + 2) }));
    return 2;
  }

  const cp = chunk.codePointAt(start + 1)!;
  const str = String.fromCodePoint(cp);
  if (str >= ' ') {
    out.push(key('char', { ch: str, alt: true, raw: chunk.slice(start, start + 1 + str.length) }));
    return 1 + str.length;
  }
  return 0;
}

/** 1 回ぶんをまとめて解釈する。テストと、状態を持たない用途向け。 */
export function decodeKeys(chunk: string): Key[] {
  const decoder = new KeyDecoder();
  return [...decoder.write(chunk), ...decoder.flush()];
}

export function keyToString(k: Key): string {
  const parts: string[] = [];
  if (k.ctrl) parts.push('ctrl');
  if (k.alt) parts.push('alt');
  if (k.shift && k.name !== 'char') parts.push('shift');
  parts.push(k.name === 'char' ? k.ch : k.name);
  return parts.join('+');
}

/** テキスト入力にそのまま流してよいか */
export function isPrintable(k: Key): boolean {
  if (k.name === 'paste') return true;
  return k.name === 'char' && !k.ctrl && !k.alt && k.ch >= ' ';
}
