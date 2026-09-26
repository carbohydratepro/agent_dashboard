import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerDriver, steerSocketPath } from '../src/core/drivers/codex-app-server.ts';
import type { AgentEvent } from '../src/core/types.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-steer-test-'));
  const bin = join(dir, 'fake-codex.mjs');
  const fixture = readFileSync(new URL('./fixtures/codex-app-server.mjs', import.meta.url), 'utf8');
  writeFileSync(bin, fixture.replace('#!/usr/bin/env node', `#!${process.execPath}`), { mode: 0o700 });
  return { dir, bin, outFile: join(dir, 'current.jsonl') };
}

test('途中送信は同じターンへ届き、出力・トークン・編集を保持する', { timeout: 10_000 }, async () => {
  const f = fixture();
  const driver = new CodexAppServerDriver({ bin: f.bin });
  const events: AgentEvent[] = [];
  let task!: { pid: number; outFile: string };
  try {
    for await (const event of driver.start({
      prompt: '最初の依頼', cwd: f.dir, outFile: f.outFile, sandbox: 'read-only',
      model: 'test-model', reasoning: 'high', onStarted: (info) => { task = info; },
    })) {
      events.push(event);
      if (event.t === 'requesting') {
        assert.equal(statSync(steerSocketPath(task.outFile, task.pid)).mode & 0o777, 0o600);
        await assert.rejects(driver.steer('wrong-thread', '方向修正', task), /対象/);
        await assert.rejects(driver.steer('thread-test', 'reject', task), /steer rejected/);
        await driver.steer('thread-test', 'テストを先に確認して', task);
      }
    }
    assert.deepEqual(events.filter((e) => e.t === 'user_message'), [{ t: 'user_message', text: 'テストを先に確認して' }], JSON.stringify(events) + readFileSync(f.outFile + '.err', 'utf8'));
    assert.equal(events.filter((e) => e.t === 'text').map((e) => e.delta).join(''), '反映: テストを先に確認して');
    assert.equal(events.filter((e) => e.t === 'requesting').length, 1);
    assert.ok(events.some((e) => e.t === 'file_edited' && e.path === 'sample.ts'));
    assert.ok(events.some((e) => e.t === 'usage' && e.inputTokens === 200 && e.outputTokens === 40));
    assert.ok(events.some((e) => e.t === 'turn_end' && e.ok), JSON.stringify(events));
    const requests = readFileSync(join(f.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    const start = requests.find((r) => r.method === 'thread/start');
    assert.equal(start.params.sandbox, 'read-only');
    assert.equal(start.params.config.model_reasoning_effort, 'high');
    assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1);
    assert.equal(existsSync(steerSocketPath(task.outFile, task.pid)), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('ダッシュボード側の読取りを止めて再接続しても途中送信できる', { timeout: 10_000 }, async () => {
  const f = fixture();
  const driver = new CodexAppServerDriver({ bin: f.bin });
  let task!: { pid: number; outFile: string };
  const abort = new AbortController();
  try {
    for await (const event of driver.resume('thread-test', {
      prompt: '最初の依頼', cwd: f.dir, outFile: f.outFile,
      prevInputTokens: 100, prevOutputTokens: 10, onStarted: (info) => { task = info; },
    })) {
      if (event.t === 'requesting') break;
    }
    const reattached = new CodexAppServerDriver({ bin: f.bin });
    const events: AgentEvent[] = [];
    for await (const event of reattached.attach({ ...task, cwd: f.dir, signal: abort.signal })) {
      events.push(event);
      if (event.t === 'requesting') await reattached.steer('thread-test', '再接続後の追加指示', task);
    }
    assert.ok(events.some((e) => e.t === 'turn_end' && e.ok));
    assert.ok(events.some((e) => e.t === 'usage' && e.inputTokens === 100 && e.outputTokens === 30));
    const requests = readFileSync(join(f.dir, 'requests.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
    assert.equal(requests.filter((r) => r.method === 'thread/resume').length, 1);
    assert.equal(requests.filter((r) => r.method === 'turn/start').length, 1);
  } finally { abort.abort(); rmSync(f.dir, { recursive: true, force: true }); }
});

test('中断とサーバー異常終了はworkerも終了し続きの実行を残さない', { timeout: 10_000 }, async () => {
  for (const prompt of ['hang', 'crash']) {
    const f = fixture();
    const driver = new CodexAppServerDriver({ bin: f.bin });
    const abort = new AbortController();
    let task!: { pid: number; outFile: string };
    const events: AgentEvent[] = [];
    try {
      for await (const event of driver.start({ prompt, cwd: f.dir, outFile: f.outFile,
        signal: abort.signal, onStarted: (info) => { task = info; } })) {
        events.push(event);
        if (event.t === 'requesting' && prompt === 'hang') abort.abort();
      }
      assert.ok(events.some((e) => e.t === 'turn_end' && !e.ok));
      assert.equal(existsSync(steerSocketPath(task.outFile, task.pid)), false);
    } finally { abort.abort(); rmSync(f.dir, { recursive: true, force: true }); }
  }
});
