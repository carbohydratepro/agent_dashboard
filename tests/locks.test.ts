/**
 * 実行時ロック（SPEC §9.4）のテスト。実ファイルを使う。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LockManager } from '../src/core/locks.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vo-lock-'));
});

afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

const DEAD_PID = 999_999;

function manager(opts: { isAlive?: (pid: number) => boolean; pid?: number } = {}) {
  return new LockManager({
    dir: join(dir, 'locks'),
    retryIntervalMs: 5,
    ...opts,
  });
}

describe('LockManager', () => {
  test('取得するとファイルができ、解放すると消える', async () => {
    const lm = manager();
    const lock = await lm.acquire('/ws/a', 'emp-1');

    assert.ok(existsSync(lock.path));
    await lock.release();
    assert.equal(existsSync(lock.path), false);
  });

  test('同じディレクトリへの取得は直列化される', async () => {
    const lm = manager();
    const order: string[] = [];

    const first = await lm.acquire('/ws/a', 'emp-1');
    order.push('1-acquired');

    let secondAcquired = false;
    const secondPromise = lm.acquire('/ws/a', 'emp-2').then((l) => {
      secondAcquired = true;
      order.push('2-acquired');
      return l;
    });

    // 1 人目が握っている間は 2 人目は入れない
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(secondAcquired, false, '1 人目が解放するまで待つ');

    order.push('1-released');
    await first.release();

    const second = await secondPromise;
    assert.deepEqual(order, ['1-acquired', '1-released', '2-acquired']);
    await second.release();
  });

  test('別のディレクトリなら互いに待たない（worktree 隔離済みの並行復帰）', async () => {
    const lm = manager();
    const [a, b] = await Promise.all([
      lm.acquire('/ws/a', 'emp-1'),
      lm.acquire('/ws/b', 'emp-2'),
    ]);
    assert.notEqual(a.path, b.path);
    await Promise.all([a.release(), b.release()]);
  });

  test('死んだ PID のロックは奪い取る', async () => {
    const lm = manager({ isAlive: (pid) => pid !== DEAD_PID });
    lm.writeForeignLock('/ws/a', {
      pid: DEAD_PID,
      owner: 'ghost',
      cwd: '/ws/a',
      acquiredAt: Date.now() - 10_000,
    });

    const lock = await lm.acquire('/ws/a', 'emp-1', { timeoutMs: 500 });
    assert.ok(existsSync(lock.path));
    await lock.release();
  });

  test('生きている別プロセスのロックは奪わず、待って諦める', async () => {
    const lm = manager({ isAlive: () => true });
    lm.writeForeignLock('/ws/a', {
      pid: 4242,
      owner: 'other-instance',
      cwd: '/ws/a',
      acquiredAt: Date.now(),
    });

    await assert.rejects(
      () => lm.acquire('/ws/a', 'emp-1', { timeoutMs: 50 }),
      /PID 4242.*使用中/s,
    );
  });

  test('壊れたロックファイルは持ち主不明として奪い取る', async () => {
    const lm = manager();
    writeFileSync(lm.pathFor('/ws/a'), 'これは JSON ではない');

    const lock = await lm.acquire('/ws/a', 'emp-1', { timeoutMs: 500 });
    assert.ok(existsSync(lock.path));
    await lock.release();
  });

  test('起動時に死んだロックだけを掃除する', () => {
    const lm = manager({ isAlive: (pid) => pid !== DEAD_PID });
    lm.writeForeignLock('/ws/dead', {
      pid: DEAD_PID,
      owner: 'ghost',
      cwd: '/ws/dead',
      acquiredAt: 0,
    });
    lm.writeForeignLock('/ws/alive', {
      pid: 1234,
      owner: 'other',
      cwd: '/ws/alive',
      acquiredAt: 0,
    });

    assert.equal(lm.cleanupStale(), 1);
    assert.equal(existsSync(lm.pathFor('/ws/dead')), false);
    assert.equal(existsSync(lm.pathFor('/ws/alive')), true);
  });

  test('解放を繰り返し呼んでも壊れない', async () => {
    const lm = manager();
    const lock = await lm.acquire('/ws/a', 'emp-1');
    await lock.release();
    await lock.release();
    assert.equal(existsSync(lock.path), false);
  });

  test('待ち行列が捌けたらロックファイルは残らない', async () => {
    const lm = manager();
    const locks = await Promise.all([
      lm.acquire('/ws/a', 'e1'),
      lm.acquire('/ws/b', 'e2'),
      lm.acquire('/ws/c', 'e3'),
    ]);
    for (const l of locks) await l.release();

    assert.deepEqual(readdirSync(join(dir, 'locks')), []);
  });
});
