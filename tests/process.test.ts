/**
 * 子プロセス起動層のテスト。実 CLI の代わりに node 自身を起こして検証する。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { attachProcess, childEnv, isAlive, runProcess } from '../src/core/drivers/process.ts';
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

// ---------------------------------------------------------------------------

describe('切り離して走らせる', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vo-detach-'));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** ゆっくり n 行出して終わるもの */
  function slowScript(lines: number, intervalMs = 120): string {
    const path = join(dir, 'slow.js');
    writeFileSync(
      path,
      `let n = 0;
       const t = setInterval(() => {
         n += 1;
         process.stdout.write(JSON.stringify({ n }) + "\\n");
         if (n >= ${lines}) { clearInterval(t); process.exit(0); }
       }, ${intervalMs});`,
    );
    return path;
  }

  test('親が読むのをやめても子は生き続ける', async () => {
    // パイプで受けていた頃は、読み手が居なくなった時点で子が SIGPIPE で死んでいた
    const outFile = join(dir, 'current.jsonl');
    let pid = 0;

    const gen = runProcess({
      command: process.execPath,
      args: [slowScript(10)],
      cwd: dir,
      outFile,
      onStarted: (i) => {
        pid = i.pid;
      },
    });

    let seen = 0;
    for await (const e of gen) {
      if (e.t === 'line') seen += 1;
      if (seen >= 2) break;
    }

    assert.ok(pid > 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isAlive(pid), true, '読むのをやめても走り続ける');

    process.kill(pid, 'SIGKILL');
  });

  test('あとから追いかけて全部拾える', async () => {
    const outFile = join(dir, 'current.jsonl');
    let pid = 0;

    const gen = runProcess({
      command: process.execPath,
      args: [slowScript(8)],
      cwd: dir,
      outFile,
      onStarted: (i) => {
        pid = i.pid;
      },
    });
    for await (const e of gen) {
      if (e.t === 'line') break;
    }

    // 立ち上げ直して頭から読み直す
    const lines: string[] = [];
    let exited = false;
    for await (const e of attachProcess({ pid, outFile })) {
      if (e.t === 'line') lines.push(e.line);
      else exited = true;
    }

    assert.equal(exited, true, '子が終われば終わりが分かる');
    assert.equal(lines.length, 8, `取りこぼさない: ${lines.length}`);
    assert.deepEqual(JSON.parse(lines.at(-1)!), { n: 8 });
  });

  test('追いかけている途中でも中断できる', async () => {
    const outFile = join(dir, 'current.jsonl');
    let pid = 0;
    const gen = runProcess({
      command: process.execPath,
      args: [slowScript(200, 50)],
      cwd: dir,
      outFile,
      onStarted: (i) => {
        pid = i.pid;
      },
    });
    for await (const e of gen) {
      if (e.t === 'line') break;
    }

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    let exited = false;
    for await (const e of attachProcess({ pid, outFile, signal: controller.signal, killGraceMs: 50 })) {
      if (e.t === 'exit') exited = true;
    }
    assert.equal(exited, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(isAlive(pid), false, '止まっている');
  });

  test('置き場所を渡さなければ従来どおり', async () => {
    const events: ProcEvent[] = [];
    for await (const e of runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("a");console.log("b")'],
      cwd: dir,
    })) {
      events.push(e);
    }
    assert.deepEqual(
      events.filter((e) => e.t === 'line').map((e) => e.line),
      ['a', 'b'],
    );
    assert.equal(events.at(-1)?.t, 'exit');
  });

  test('標準エラーも拾う', async () => {
    const outFile = join(dir, 'current.jsonl');
    const events: ProcEvent[] = [];
    for await (const e of runProcess({
      command: process.execPath,
      args: ['-e', 'console.error("こわれた");process.exit(3)'],
      cwd: dir,
      outFile,
    })) {
      events.push(e);
    }
    const exit = events.at(-1);
    assert.equal(exit?.t, 'exit');
    assert.equal(exit.code, 3);
    assert.match(exit.stderr, /こわれた/);
  });
});
