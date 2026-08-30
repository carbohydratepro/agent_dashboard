/**
 * 実行時ロック（SPEC §9.4）。
 *
 * 二重の守り:
 *   ・プロセス内 — 同じディレクトリへの取得を直列化する（復帰の順序制御にも使う、§10.4）
 *   ・ディスク上 — 別インスタンスのダッシュボードが同じ場所を触るのを防ぐ
 *
 * 死んだ PID のロックは奪い取る。起動時にも掃除する。
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface LockInfo {
  pid: number;
  /** 取得したセッションの識別子 */
  owner: string;
  cwd: string;
  acquiredAt: number;
}

export interface LockHandle {
  readonly path: string;
  release(): Promise<void>;
}

export interface LockManagerOptions {
  dir: string;
  /** テスト用。既定は process.kill(pid, 0) による生存確認 */
  isAlive?: (pid: number) => boolean;
  pid?: number;
  /** 他プロセスのロックを待つ間隔 */
  retryIntervalMs?: number;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「生きているが権限が無い」なので生存扱い
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockFileName(cwd: string): string {
  return `${createHash('sha1').update(cwd).digest('hex').slice(0, 16)}.lock`;
}

export class LockManager {
  #dir: string;
  #isAlive: (pid: number) => boolean;
  #pid: number;
  #retryIntervalMs: number;
  /** ディレクトリごとの直列化。末尾の Promise を繋いでいく */
  #chains = new Map<string, Promise<void>>();

  constructor(opts: LockManagerOptions) {
    this.#dir = opts.dir;
    this.#isAlive = opts.isAlive ?? defaultIsAlive;
    this.#pid = opts.pid ?? process.pid;
    this.#retryIntervalMs = opts.retryIntervalMs ?? 100;
    mkdirSync(this.#dir, { recursive: true });
  }

  pathFor(cwd: string): string {
    return join(this.#dir, lockFileName(cwd));
  }

  /**
   * ロックを取る。同じ cwd への取得はプロセス内で直列化される。
   * 他プロセスが握っている場合は timeoutMs まで待つ。
   */
  async acquire(
    cwd: string,
    owner: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<LockHandle> {
    const prev = this.#chains.get(cwd) ?? Promise.resolve();

    let releaseChain!: () => void;
    const mine = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    const chained = prev.then(() => mine);
    this.#chains.set(cwd, chained);

    // 待ち行列の後ろに並ぶセッションがいなくなったら、Map から落として溜め込まない
    const dropIfLast = (): void => {
      if (this.#chains.get(cwd) === chained) this.#chains.delete(cwd);
    };

    await prev;

    try {
      const path = await this.#takeFile(cwd, owner, opts.timeoutMs ?? 30_000);
      let released = false;
      return {
        path,
        release: async () => {
          if (released) return;
          released = true;
          await unlink(path).catch(() => {});
          releaseChain();
          dropIfLast();
        },
      };
    } catch (err) {
      releaseChain();
      dropIfLast();
      throw err;
    }
  }

  async #takeFile(cwd: string, owner: string, timeoutMs: number): Promise<string> {
    const path = this.pathFor(cwd);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const info: LockInfo = { pid: this.#pid, owner, cwd, acquiredAt: Date.now() };
      try {
        // wx: 既に存在すれば EEXIST。作成と存在確認が不可分になる
        const fh = await open(path, 'wx');
        await fh.writeFile(JSON.stringify(info));
        await fh.close();
        return path;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }

      const holder = this.#readLock(path);
      if (!holder || !this.#isAlive(holder.pid)) {
        // 持ち主が死んでいる。奪い取ってやり直す
        try {
          unlinkSync(path);
        } catch {
          /* 競合して誰かが先に消した。次の周回で取り直す */
        }
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `${cwd} は別のプロセス（PID ${holder.pid}）が使用中です`,
        );
      }
      await new Promise((r) => setTimeout(r, this.#retryIntervalMs));
    }
  }

  #readLock(path: string): LockInfo | null {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null) return null;
      const info = parsed as Partial<LockInfo>;
      return typeof info.pid === 'number' ? (info as LockInfo) : null;
    } catch {
      // 壊れたロックファイルは持ち主不明として扱い、掃除対象にする
      return null;
    }
  }

  /** 起動時に呼ぶ。死んだ PID のロックを消して、消した数を返す（SPEC §14.3） */
  cleanupStale(): number {
    let removed = 0;
    let entries: string[];
    try {
      entries = readdirSync(this.#dir);
    } catch {
      return 0;
    }

    for (const name of entries) {
      if (!name.endsWith('.lock')) continue;
      const path = join(this.#dir, name);
      const info = this.#readLock(path);
      if (info && this.#isAlive(info.pid)) continue;
      try {
        unlinkSync(path);
        removed += 1;
      } catch {
        /* 消せなくても致命的ではない */
      }
    }
    return removed;
  }

  /** テスト用。他プロセスが握っている状況を作る */
  writeForeignLock(cwd: string, info: LockInfo): void {
    writeFileSync(this.pathFor(cwd), JSON.stringify(info));
  }
}
