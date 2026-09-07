/**
 * 実 claude CLI を起動するドライバ。
 * 引数はフェーズ 0 の実測（docs/phase0/FINDINGS.md）で確認したものだけを使う。
 */

import type { AgentDriver, AttachOpts, StartOpts, TurnOpts } from './driver.ts';
import type { AgentEvent } from '../types.ts';
import { ClaudeParser } from './claude-parser.ts';
import { attachProcess, runProcess } from './process.ts';

export interface ClaudeDriverOptions {
  bin?: string;
  /**
   * 部分メッセージ（stream_event）を受け取るか。
   * タイピングアニメを実装するフェーズ 12 まではオフにしておく。
   * オンにすると 1 ターンの行数が数倍になる（FINDINGS §7.4）。
   */
  includePartialMessages?: boolean;
  killGraceMs?: number;
}

const BASE_ARGS = [
  '--output-format',
  'stream-json',
  '--forward-subagent-text',
  '--verbose',
];

export class ClaudeDriver implements AgentDriver {
  readonly kind = 'claude' as const;

  #bin: string;
  #partial: boolean;
  #killGraceMs: number;

  constructor(opts: ClaudeDriverOptions = {}) {
    this.#bin = opts.bin ?? 'claude';
    this.#partial = opts.includePartialMessages ?? false;
    this.#killGraceMs = opts.killGraceMs ?? 5_000;
  }

  async *start(opts: StartOpts): AsyncIterable<AgentEvent> {
    const args = ['-p', opts.prompt, ...BASE_ARGS];
    if (this.#partial) args.push('--include-partial-messages');
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    if (opts.model) args.push('--model', opts.model);
    // 指定が無ければ渡さない。ユーザーの CLI 設定に従う（SPEC §1）
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);

    yield* this.#run(args, opts);
  }

  async *resume(sessionId: string, opts: TurnOpts): AsyncIterable<AgentEvent> {
    const args = ['-p', opts.prompt, '--resume', sessionId, ...BASE_ARGS];
    if (this.#partial) args.push('--include-partial-messages');
    if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      // 承認待ちで承認されたツールを許可する。実機で動作確認済み（FINDINGS §3.2）
      args.push('--allowedTools', opts.allowedTools.join(','));
    }

    yield* this.#run(args, opts);
  }

  /** 走ったままのものを追いかける。出力はファイルに残っている。 */
  async *attach(opts: AttachOpts): AsyncIterable<AgentEvent> {
    const parser = new ClaudeParser();
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
      outFile?: string;
      onStarted?: (info: { pid: number; outFile: string }) => void;
    },
  ): AsyncIterable<AgentEvent> {
    const parser = new ClaudeParser();

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
