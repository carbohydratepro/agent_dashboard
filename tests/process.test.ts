/**
 * 子プロセス起動層のテスト。実 CLI の代わりに node 自身を起こして検証する。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { childEnv, runProcess } from '../src/core/drivers/process.ts';
import type { ProcEvent } from '../src/core/drivers/process.ts';

async function collect(gen: AsyncGenerator<ProcEvent>): Promise<ProcEvent[]> {
  const out: ProcEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

function nodeRun(script: string, signal?: AbortSignal) {
  return runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    signal,
    killGraceMs: 50,
  });
}

describe('runProcess', () => {
  test('stdout を 1 行ずつ流し、最後に exit を出す', async () => {
    const events = await collect(
      nodeRun('console.log("a");console.log("b");console.log("c")'),
    );

    const lines = events.filter((e) => e.t === 'line').map((e) => e.line);
    assert.deepEqual(lines, ['a', 'b', 'c']);

    const exit = events.at(-1);
    assert.equal(exit?.t, 'exit');
    assert.equal(exit.code, 0);
  });

  test('空行は捨てる', async () => {
    const events = await collect(nodeRun('console.log("x");console.log("");console.log("  ")'));
    assert.equal(events.filter((e) => e.t === 'line').length, 1);
  });

  test('生の行をフックに渡す', async () => {
    const raw: string[] = [];
    await collect(
      runProcess({
        command: process.execPath,
        args: ['-e', 'console.log("{}");console.log("{\\"a\\":1}")'],
        cwd: process.cwd(),
        onRawLine: (l) => raw.push(l),
      }),
    );
    assert.deepEqual(raw, ['{}', '{"a":1}']);
  });

  test('stderr を保持し、終了コードを返す', async () => {
    const events = await collect(
      nodeRun('console.error("something went wrong");process.exit(3)'),
    );
    const exit = events.at(-1);
    assert.equal(exit?.t, 'exit');
    assert.equal(exit.code, 3);
    assert.match(exit.stderr, /something went wrong/);
  });

  test('存在しないコマンドでも例外を投げず exit で返す', async () => {
    const events = await collect(
      runProcess({
        command: '/nonexistent/definitely-not-here',
        args: [],
        cwd: process.cwd(),
      }),
    );
    const exit = events.at(-1);
    assert.equal(exit?.t, 'exit');
    assert.match(exit.stderr, /ENOENT/);
  });

  test('abort で子プロセスを止める', async () => {
    const controller = new AbortController();
    const gen = nodeRun('setInterval(()=>{},1000);console.log("started")', controller.signal);

    const events: ProcEvent[] = [];
    for await (const e of gen) {
      events.push(e);
      if (e.t === 'line' && e.line === 'started') controller.abort();
    }

    const exit = events.at(-1);
    assert.equal(exit?.t, 'exit');
    assert.ok(exit.signal !== null || exit.code !== 0, 'シグナルまたは異常終了で閉じる');
  });

  test('途中で break しても子プロセスを残さない', async () => {
    const gen = nodeRun('setInterval(()=>{},1000);console.log("alive")');
    for await (const e of gen) {
      if (e.t === 'line') break;
    }
    // finally 節で SIGKILL される。ここに到達すればハングしていない
    assert.ok(true);
  });
});

describe('childEnv', () => {
  test('親の Claude Code 由来の環境変数を落とす', () => {
    const env = childEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SSE_PORT: '1234',
      MY_VAR: 'keep',
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.MY_VAR, 'keep');
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_SSE_PORT, undefined);
  });
});
