/** Codex App Server の JSONL RPC。保留要求は必ず期限・切断で解放する。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv } from './process.ts';

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message: string } };

export class CodexRpc {
  readonly process: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  #nextId = 0;
  #pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #ended = false;

  constructor(bin: string, cwd: string, onMessage: (message: RpcMessage) => void) {
    this.process = spawn(bin, ['app-server'], { cwd, env: childEnv(), stdio: 'pipe' });
    this.process.stderr.on('data', (data) => process.stderr.write(data));
    this.process.stdin.on('error', (err) => this.#fail(err));
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) { onMessage(message); return; }
      const request = this.#pending.get(message.id as number);
      if (!request) return;
      this.#pending.delete(message.id as number);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    this.closed = new Promise((resolve) => {
      this.process.once('error', (error) => { this.#fail(error); resolve(); });
      this.process.once('close', () => {
        this.#fail(new Error('Codex App Server との接続が終了しました。'));
        lines.close();
        resolve();
      });
    });
  }

  send(message: RpcMessage): void {
    if (!this.#ended) this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.#ended) return Promise.reject(new Error('Codex App Server は終了しています。'));
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} の受付確認がタイムアウトしました。`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  #fail(error: Error): void {
    this.#ended = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.#pending.clear();
  }

  async close(): Promise<void> {
    this.process.stdin.end();
    this.process.kill('SIGTERM');
    const timer = setTimeout(() => this.process.kill('SIGKILL'), 2_000);
    await this.closed;
    clearTimeout(timer);
  }
}
