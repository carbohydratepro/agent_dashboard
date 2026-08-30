/**
 * 実 codex CLI を起動するドライバ。
 *
 * フェーズ 0 で判明した制約（docs/phase0/FINDINGS.md §1.2）:
 *   ・`codex exec resume` はオプションを位置引数より前に置く必要がある
 *   ・`resume` は --sandbox を受け付けない。初回セッションの設定を継承する
 */

import type { AgentDriver, StartOpts, TurnOpts } from './driver.ts';
import type { AgentEvent } from '../types.ts';
import { CodexParser } from './codex-parser.ts';
import { runProcess } from './process.ts';

export interface CodexDriverOptions {
  bin?: string;
  killGraceMs?: number;
}

export class CodexDriver implements AgentDriver {
  readonly kind = 'codex' as const;

  #bin: string;
  #killGraceMs: number;

  constructor(opts: CodexDriverOptions = {}) {
    this.#bin = opts.bin ?? 'codex';
    this.#killGraceMs = opts.killGraceMs ?? 5_000;
  }

  async *start(opts: StartOpts): AsyncIterable<AgentEvent> {
    const args = ['exec', opts.prompt, '--json'];
    if (opts.model) args.push('-m', opts.model);
    // サンドボックスはここでしか指定できない。以後このセッションの生涯にわたり固定される
    if (opts.sandbox) args.push('--sandbox', opts.sandbox);

    yield* this.#run(args, opts);
  }

  async *resume(sessionId: string, opts: TurnOpts): AsyncIterable<AgentEvent> {
    // ★オプションは位置引数より前★ 逆にすると unexpected argument で落ちる
    const args = ['exec', 'resume', '--json', sessionId, opts.prompt];

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // codex には --allowedTools 相当が無い。承認待ちは claude セッションのみの機能。
      // 呼ばれても落とさず、そのまま再実行する。
    }

    yield* this.#run(args, opts);
  }

  async *#run(
    args: string[],
    opts: {
      cwd: string;
      signal?: AbortSignal;
      onRawLine?: (line: string) => void;
      prevInputTokens?: number;
      prevOutputTokens?: number;
      model?: string | null;
    },
  ): AsyncIterable<AgentEvent> {
    const parser = new CodexParser({
      prevInputTokens: opts.prevInputTokens,
      prevOutputTokens: opts.prevOutputTokens,
      model: opts.model ?? '',
    });

    for await (const e of runProcess({
      command: this.#bin,
      args,
      cwd: opts.cwd,
      signal: opts.signal,
      killGraceMs: this.#killGraceMs,
      onRawLine: opts.onRawLine,
    })) {
      if (e.t === 'line') yield* parser.push(e.line);
      else yield* parser.finish(e);
    }
  }
}
