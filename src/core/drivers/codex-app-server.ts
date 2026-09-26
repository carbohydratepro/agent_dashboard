/** 双方向の Codex 実行。worker は親から切り離し、再起動後も出力と追加指示を引き継ぐ。 */
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '../types.ts';
import type { StartOpts, TurnOpts } from './driver.ts';
import { CodexDriver } from './codex.ts';
import { CodexParser } from './codex-parser.ts';
import { runProcess } from './process.ts';

export function steerSocketPath(outFile: string, pid: number): string {
  const digest = createHash('sha256').update(outFile).digest('hex').slice(0, 16);
  return join(tmpdir(), `agent-dashboard-steer-${process.getuid?.() ?? 'user'}-${pid}-${digest}.sock`);
}

export interface WorkerOptions {
  bin: string;
  threadId?: string;
  prompt: string;
  cwd: string;
  model?: string | null;
  reasoning?: string | null;
  sandbox?: string | null;
  outFile?: string;
  prevInputTokens?: number;
  prevOutputTokens?: number;
}

export class CodexAppServerDriver extends CodexDriver {
  #serverBin: string;

  constructor(opts: { bin?: string } = {}) {
    super(opts);
    this.#serverBin = opts.bin ?? 'codex';
  }

  override async *start(opts: StartOpts): AsyncIterable<AgentEvent> {
    yield* this.#runServer(opts);
  }

  override async *resume(threadId: string, opts: TurnOpts): AsyncIterable<AgentEvent> {
    yield* this.#runServer(opts, threadId);
  }

  async *#runServer(opts: StartOpts | TurnOpts, threadId?: string): AsyncIterable<AgentEvent> {
    const worker: WorkerOptions = {
      bin: this.#serverBin, threadId, prompt: opts.prompt, cwd: opts.cwd,
      model: opts.model, reasoning: opts.reasoning,
      sandbox: 'sandbox' in opts ? opts.sandbox : undefined,
      outFile: opts.outFile,
      prevInputTokens: opts.prevInputTokens, prevOutputTokens: opts.prevOutputTokens,
    };
    const parser = new CodexParser();
    for await (const event of runProcess({
      command: process.execPath,
      args: [fileURLToPath(new URL('./codex-worker.ts', import.meta.url)), JSON.stringify(worker)],
      cwd: opts.cwd, signal: opts.signal, outFile: opts.outFile,
      onStarted: opts.onStarted, onRawLine: opts.onRawLine,
    })) {
      if (event.t === 'line') yield* parser.push(event.line);
      else yield* parser.finish(event);
    }
  }

  async steer(threadId: string, prompt: string, task: { pid: number; outFile: string }): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(steerSocketPath(task.outFile, task.pid));
      let reply = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('追加指示の受付を確認できませんでした。会話履歴を確認してください。')), 15_000);
      socket.on('connect', () => socket.write(`${JSON.stringify({ threadId, prompt })}\n`));
      socket.on('error', () => finish(new Error('追加指示の接続先がありません。更新前の実行は完了を待ってください。')));
      socket.on('close', () => finish(new Error('追加指示の受付前に接続が終了しました。')));
      socket.on('data', (chunk) => {
        reply += chunk.toString('utf8');
        if (reply.length > 64_000) return finish(new Error('追加指示の応答が不正です。'));
        if (!reply.includes('\n')) return;
        try {
          const result = JSON.parse(reply.split('\n')[0]!);
          finish(result.ok === true ? undefined : new Error(result.error ?? '追加指示が受理されませんでした。'));
        } catch { finish(new Error('追加指示の応答を解釈できませんでした。')); }
      });
    });
  }
}
