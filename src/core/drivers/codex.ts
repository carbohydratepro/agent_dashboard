/**
 * 実 codex CLI を起動するドライバ。
 *
 * フェーズ 0 で判明した制約（docs/phase0/FINDINGS.md §1.2）:
 *   ・`codex exec resume` はオプションを位置引数より前に置く必要がある
 *   ・`resume` は --sandbox を受け付けない。初回セッションの設定を継承する
 */

import type { AgentDriver, AttachOpts, StartOpts, TurnOpts } from './driver.ts';
import type { AgentEvent } from '../types.ts';
import { CodexParser } from './codex-parser.ts';
import { attachProcess, runProcess } from './process.ts';

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
    if (opts.reasoning) args.push('-c', `model_reasoning_effort="${opts.reasoning}"`);
    // サンドボックスはここでしか指定できない。以後このセッションの生涯にわたり固定される
    if (opts.sandbox) args.push('--sandbox', opts.sandbox);

    yield* this.#run(args, opts);
  }

  async *resume(sessionId: string, opts: TurnOpts): AsyncIterable<AgentEvent> {
    // ★オプションは位置引数より前★ 逆にすると unexpected argument で落ちる
    const args = ['exec', 'resume', '--json'];

    // resume は -m を受け付けない。設定の上書き（-c）でなら変えられる。
    // これが無いと、途中でモデルを変えても最初のモデルのまま動き続ける。
    if (opts.model) args.push('-c', `model="${opts.model}"`);
    if (opts.reasoning) args.push('-c', `model_reasoning_effort="${opts.reasoning}"`);

    args.push(sessionId, opts.prompt);

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // codex には --allowedTools 相当が無い。承認待ちは claude セッションのみの機能。
      // 呼ばれても落とさず、そのまま再実行する。
    }

    yield* this.#run(args, opts);
  }

  /** 走ったままのものを追いかける。出力はファイルに残っている。 */
  async *attach(opts: AttachOpts): AsyncIterable<AgentEvent> {
    const parser = new CodexParser({
      prevInputTokens: opts.prevInputTokens,
      prevOutputTokens: opts.prevOutputTokens,
      model: opts.model ?? '',
    });
    for await (const e of attachProcess({
      pid: opts.pid,
      outFile: opts.outFile,
      signal: opts.signal,
      killGraceMs: this.#killGraceMs,
      onRawLine: opts.onRawLine,
    })) {
      if (e.t === 'line') yield* parser.push(e.line);
      else yield* parser.finish(e);
    }
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
      outFile?: string;
      onStarted?: (info: { pid: number; outFile: string }) => void;
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
      outFile: opts.outFile,
      onStarted: opts.onStarted,
    })) {
      if (e.t === 'line') yield* parser.push(e.line);
      else yield* parser.finish(e);
    }
  }
}
