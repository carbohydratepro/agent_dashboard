/**
 * 端末の抽象。App をヘッドレスにテストするために挟む。
 */

import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  CURSOR_SHOW,
  detectColorMode,
} from './ansi.ts';
import type { ColorMode } from './ansi.ts';
import { KeyDecoder } from './input.ts';
import type { Key } from './input.ts';

/** ブラケットペースト。IME の確定文字列やペーストを 1 かたまりで受け取る */
const PASTE_MODE_ON = '\x1b[?2004h';
const PASTE_MODE_OFF = '\x1b[?2004l';

/** 単独の ESC か、エスケープ列の途中かを見分けるための待ち時間 */
const ESCAPE_TIMEOUT_MS = 25;

export interface Terminal {
  readonly columns: number;
  readonly rows: number;
  readonly colorMode: ColorMode;
  write(data: string): void;
  onKey(cb: (key: Key) => void): () => void;
  onResize(cb: () => void): () => void;
  enter(): void;
  exit(): void;
  bell(): void;
}

export class NodeTerminal implements Terminal {
  #stdin: NodeJS.ReadStream;
  #stdout: NodeJS.WriteStream;
  #keyHandlers = new Set<(key: Key) => void>();
  #resizeHandlers = new Set<() => void>();
  #decoder = new KeyDecoder();
  #flushTimer: NodeJS.Timeout | null = null;
  /** Buffer のまま渡す。文字列化を StringDecoder に任せて割れを防ぐ。 */
  #onData = (chunk: Buffer | string): void => {
    this.#emit(this.#decoder.write(chunk));
    this.#scheduleFlush();
  };
  #onResize = (): void => {
    for (const h of this.#resizeHandlers) h();
  };
  #entered = false;

  readonly colorMode: ColorMode;

  constructor(stdin = process.stdin, stdout = process.stdout) {
    this.#stdin = stdin;
    this.#stdout = stdout;
    this.colorMode = detectColorMode();
  }

  get columns(): number {
    return this.#stdout.columns ?? 80;
  }

  get rows(): number {
    return this.#stdout.rows ?? 24;
  }

  write(data: string): void {
    if (data !== '') this.#stdout.write(data);
  }

  onKey(cb: (key: Key) => void): () => void {
    this.#keyHandlers.add(cb);
    return () => this.#keyHandlers.delete(cb);
  }

  onResize(cb: () => void): () => void {
    this.#resizeHandlers.add(cb);
    return () => this.#resizeHandlers.delete(cb);
  }

  #emit(keys: Key[]): void {
    for (const k of keys) {
      for (const h of this.#keyHandlers) h(k);
    }
  }

  /** 溜まったままの並びを、少し待ってから確定させる */
  #scheduleFlush(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (!this.#decoder.hasPending) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#emit(this.#decoder.flush());
    }, ESCAPE_TIMEOUT_MS);
    this.#flushTimer.unref?.();
  }

  enter(): void {
    if (this.#entered) return;
    this.#entered = true;
    if (this.#stdin.isTTY) this.#stdin.setRawMode(true);
    this.#stdin.resume();
    this.#stdin.on('data', this.#onData);
    this.#stdout.on('resize', this.#onResize);
    this.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN + PASTE_MODE_ON);
  }

  exit(): void {
    if (!this.#entered) return;
    this.#entered = false;
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    this.write(PASTE_MODE_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
    this.#stdin.off('data', this.#onData);
    this.#stdout.off('resize', this.#onResize);
    if (this.#stdin.isTTY) this.#stdin.setRawMode(false);
    this.#stdin.pause();
  }

  bell(): void {
    this.write('\x07');
  }
}

/** テスト用。書き込みを溜めるだけ。 */
export class FakeTerminal implements Terminal {
  columns: number;
  rows: number;
  colorMode: ColorMode = 'none';
  readonly output: string[] = [];
  bells = 0;
  entered = false;

  #keyHandlers = new Set<(key: Key) => void>();
  #resizeHandlers = new Set<() => void>();

  constructor(columns = 100, rows = 32) {
    this.columns = columns;
    this.rows = rows;
  }

  write(data: string): void {
    if (data !== '') this.output.push(data);
  }

  onKey(cb: (key: Key) => void): () => void {
    this.#keyHandlers.add(cb);
    return () => this.#keyHandlers.delete(cb);
  }

  onResize(cb: () => void): () => void {
    this.#resizeHandlers.add(cb);
    return () => this.#resizeHandlers.delete(cb);
  }

  enter(): void {
    this.entered = true;
  }

  exit(): void {
    this.entered = false;
  }

  bell(): void {
    this.bells += 1;
  }

  #decoder = new KeyDecoder();

  /** 生の入力を流し込む。実端末と同じデコーダを通す。 */
  feed(raw: string | Buffer): void {
    const keys = [...this.#decoder.write(raw), ...this.#decoder.flush()];
    for (const k of keys) {
      for (const h of this.#keyHandlers) h(k);
    }
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    for (const h of this.#resizeHandlers) h();
  }
}
