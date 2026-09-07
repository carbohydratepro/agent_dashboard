/**
 * 子プロセスを起こして stdout を 1 行ずつ流す。
 * フェーズ 0 の実測（docs/phase0/FINDINGS.md §1）で判明した条件を守る:
 *   ・stdin は必ず閉じる（claude は stdin を 3 秒待つ）
 *   ・親の Claude Code 由来の環境変数は落とす
 *
 * 出力はパイプではなくファイルに書かせ、こちらはそれを追いかける。
 * パイプにすると、ダッシュボードを閉じた瞬間に読み手が居なくなり、
 * 子は次に書いたところで SIGPIPE で死ぬ。ファイルなら子は書き続けられるので、
 * ダッシュボードを立ち上げ直して同じファイルを追えば作業を見失わない
 * （FINDINGS §11）。
 */

import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

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
  /**
   * 出力の置き場所。渡すと子を切り離し、親が落ちても走り続ける。
   * 渡さなければ子は親と運命を共にする（テスト用）。
   */
  outFile?: string;
  /** 起動できたら呼ぶ。PID を控えて、あとで追いかけ直すために使う。 */
  onStarted?: (info: { pid: number; outFile: string }) => void;
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
/** ファイルを覗きにいく間隔。パイプと違って自分から見に行く必要がある。 */
const POLL_MS = 60;

export function stderrPathFor(outFile: string): string {
  return `${outFile}.err`;
}

/** 生きているか。EPERM は「居るが触れない」なので生存扱い。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** ファイルの続きを読む道具。読んだところまでを覚えている。 */
class Tail {
  #path: string;
  #offset: number;
  #rest = '';

  constructor(path: string, offset = 0) {
    this.#path = path;
    this.#offset = offset;
  }

  get offset(): number {
    return this.#offset;
  }

  /** 増えたぶんを行にして返す。まだ行が閉じていない末尾は次に持ち越す。 */
  read(): string[] {
    let size: number;
    try {
      size = statSync(this.#path).size;
    } catch {
      return [];
    }
    if (size <= this.#offset) return [];

    const length = size - this.#offset;
    const buffer = Buffer.alloc(length);
    let fd: number;
    try {
      fd = openSync(this.#path, 'r');
    } catch {
      return [];
    }
    try {
      readSync(fd, buffer, 0, length, this.#offset);
    } finally {
      closeSync(fd);
    }
    this.#offset = size;

    const text = this.#rest + buffer.toString('utf8');
    const parts = text.split('\n');
    this.#rest = parts.pop() ?? '';
    return parts;
  }

  /** 閉じていない末尾も含めて全部吐く。終了後の取りこぼし防止。 */
  drain(): string[] {
    const lines = this.read();
    if (this.#rest !== '') {
      lines.push(this.#rest);
      this.#rest = '';
    }
    return lines;
  }
}

function readStderr(path: string): string {
  try {
    const size = statSync(path).size;
    const length = Math.min(size, STDERR_KEEP);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 覗きにいく間隔をあける。
 * ここで unref すると、待っている間にイベントループが空になって
 * プロセスごと落ちる。追いかけている間は生かしておく。
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function* runProcess(opts: RunOpts): AsyncGenerator<ProcEvent> {
  // 置き場所を渡されなければ、従来どおりパイプで受ける（テスト用の軽い経路）
  if (opts.outFile === undefined) {
    yield* runPiped(opts);
    return;
  }

  const outFile = opts.outFile;
  const errFile = stderrPathFor(outFile);
  mkdirSync(dirname(outFile), { recursive: true });

  // 'w' で開き直す。前のターンの出力が残っていると、それを新しい出力として読む。
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');

  let child;
  try {
    child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      // stdin を閉じる。開けたままだと claude が 3 秒待つ（FINDINGS §1.1）
      stdio: ['ignore', outFd, errFd],
      env: childEnv(),
      // 親のプロセスグループから外す。親が落ちても巻き添えにならない。
      detached: true,
    });
  } finally {
    // 子に渡ったので、こちらの控えは閉じてよい
    closeSync(outFd);
    closeSync(errFd);
  }

  const pid = child.pid;
  if (pid === undefined) {
    yield { t: 'exit', code: null, signal: null, stderr: '起動できませんでした' };
    return;
  }
  child.unref();
  opts.onStarted?.({ pid, outFile });

  let exit: { code: number | null; signal: string | null } | null = null;
  let spawnError = '';
  child.on('error', (err) => {
    spawnError = String(err);
    exit = { code: null, signal: null };
  });
  child.on('close', (code, signal) => {
    exit = { code, signal };
  });

  let onAbort: (() => void) | undefined;
  if (opts.signal) {
    onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* もう居ない */
      }
      const grace = opts.killGraceMs ?? 5_000;
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* もう居ない */
        }
      }, grace);
      timer.unref();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    yield* follow(outFile, errFile, 0, opts.onRawLine, () => exit, spawnError);
  } finally {
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * すでに走っているものを追いかける。ダッシュボードを立ち上げ直したときに使う。
 * こちらは子のハンドルを持っていないので、生死は PID で見る。
 */
export async function* attachProcess(opts: {
  pid: number;
  outFile: string;
  /** 前回どこまで読んだか。0 なら頭から。 */
  offset?: number;
  signal?: AbortSignal;
  killGraceMs?: number;
  onRawLine?: (line: string) => void;
}): AsyncGenerator<ProcEvent> {
  const errFile = stderrPathFor(opts.outFile);

  let onAbort: (() => void) | undefined;
  if (opts.signal) {
    onAbort = () => {
      try {
        process.kill(opts.pid, 'SIGTERM');
      } catch {
        /* もう居ない */
      }
      const timer = setTimeout(() => {
        try {
          process.kill(opts.pid, 'SIGKILL');
        } catch {
          /* もう居ない */
        }
      }, opts.killGraceMs ?? 5_000);
      timer.unref();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    yield* follow(
      opts.outFile,
      errFile,
      opts.offset ?? 0,
      opts.onRawLine,
      // 終了コードは分からない。生きているかどうかだけ見る。
      () => (isAlive(opts.pid) ? null : { code: null, signal: null }),
      '',
    );
  } finally {
    if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
  }
}

/** ファイルを追いかけて、終わったら exit を出す。起動直後も再開後も同じ流れ。 */
async function* follow(
  outFile: string,
  errFile: string,
  offset: number,
  onRawLine: ((line: string) => void) | undefined,
  exitOf: () => { code: number | null; signal: string | null } | null,
  spawnError: string,
): AsyncGenerator<ProcEvent> {
  const tail = new Tail(outFile, offset);

  const emit = (lines: string[]): ProcEvent[] => {
    const out: ProcEvent[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      onRawLine?.(line);
      out.push({ t: 'line', line });
    }
    return out;
  };

  for (;;) {
    for (const e of emit(tail.read())) yield e;

    const done = exitOf();
    if (done) {
      // 死んだあとに書き込まれたぶんが残っていることがある
      for (const e of emit(tail.drain())) yield e;
      const stderr = [spawnError, readStderr(errFile)].filter((t) => t !== '').join('\n');
      yield { t: 'exit', code: done.code, signal: done.signal, stderr };
      return;
    }
    await sleep(POLL_MS);
  }
}

/** 置き場所を渡されなかったときの、従来どおりのパイプ経由。 */
async function* runPiped(opts: RunOpts): AsyncGenerator<ProcEvent> {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv(),
  });
  if (child.pid !== undefined) opts.onStarted?.({ pid: child.pid, outFile: '' });

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

  let rest = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    const parts = (rest + chunk.toString('utf8')).split('\n');
    rest = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim() === '') continue;
      opts.onRawLine?.(line);
      push({ t: 'line', line });
    }
  });

  child.on('error', (err) => {
    stderr += `\n${String(err)}`;
    finished = true;
    push({ t: 'exit', code: null, signal: null, stderr });
  });

  child.on('close', (code, signal) => {
    if (rest.trim() !== '') {
      opts.onRawLine?.(rest);
      push({ t: 'line', line: rest });
      rest = '';
    }
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
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
