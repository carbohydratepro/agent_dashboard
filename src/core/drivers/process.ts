/**
 * 子プロセスを起こして stdout を 1 行ずつ流す。
 * フェーズ 0 の実測（docs/phase0/FINDINGS.md §1）で判明した条件を守る:
 *   ・stdin は必ず閉じる（claude は stdin を 3 秒待つ）
 *   ・親の Claude Code 由来の環境変数は落とす
 */

import { spawn } from 'node:child_process';
import readline from 'node:readline';

export type ProcEvent =
  | { t: 'line'; line: string }
  | { t: 'exit'; code: number | null; signal: string | null; stderr: string };

export interface RunOpts {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  /** 中断時に SIGTERM から SIGKILL へ上げるまでの猶予（SPEC §10.3） */
  killGraceMs?: number;
  /** 生の行をそのまま受け取るフック。raw.jsonl への追記に使う（SPEC §14.2） */
  onRawLine?: (line: string) => void;
}

/** 子に渡してはいけない親の環境変数（FINDINGS §1.3） */
const STRIPPED_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_SIMPLE',
];

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

const STDERR_KEEP = 8_192;

export async function* runProcess(opts: RunOpts): AsyncGenerator<ProcEvent> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    // stdin を閉じる。開けたままだと claude が 3 秒待つ（FINDINGS §1.1）
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
  });

  const queue: ProcEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;

  const push = (e: ProcEvent): void => {
    queue.push(e);
    const w = wake;
    wake = null;
    w?.();
  };

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > STDERR_KEEP) stderr = stderr.slice(-STDERR_KEEP);
  });

  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    opts.onRawLine?.(line);
    push({ t: 'line', line });
  });

  child.on('error', (err) => {
    stderr += `\n${String(err)}`;
    finished = true;
    push({ t: 'exit', code: null, signal: null, stderr });
  });

  child.on('close', (code, signal) => {
    finished = true;
    push({ t: 'exit', code, signal, stderr });
  });

  let onAbort: (() => void) | undefined;
  if (opts.signal) {
    onAbort = () => {
      child.kill('SIGTERM');
      const grace = opts.killGraceMs ?? 5_000;
      const timer = setTimeout(() => child.kill('SIGKILL'), grace);
      timer.unref();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      while (queue.length > 0) {
        const e = queue.shift()!;
        yield e;
        if (e.t === 'exit') return;
      }
      if (finished && queue.length === 0) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    rl.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
