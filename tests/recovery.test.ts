/**
 * ネットワーク復帰（SPEC §10.3〜§10.7）のテスト。
 * MockDriver を「中断されるまで固まる」モードにして、実際に切断を再現する。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import type { StoreEvent } from '../src/core/store.ts';
import { MockDriver, successfulTurn, failingTurn } from '../src/core/drivers/mock.ts';
import { RecoveryCoordinator, defaultRecoveryPrompt } from '../src/core/recovery.ts';
import { NetworkMonitor } from '../src/core/network.ts';
import type { IfaceInfo } from '../src/core/network.ts';
import { FakeClock, SeqIdGen } from '../src/core/clock.ts';
import type { Session, Workspace } from '../src/core/types.ts';

/** 実行中のターンが固まる位置まで進むのを待つ */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 5));
}

function workspaceAt(cwd: string): Workspace {
  return { requestedCwd: cwd, actualCwd: cwd, isolation: 'none', branch: null, sandbox: null };
}

interface Harness {
  manager: SessionManager;
  store: StateStore;
  claude: MockDriver;
  codex: MockDriver;
  coordinator: RecoveryCoordinator;
  events: StoreEvent[];
  waits: number[];
  clock: FakeClock;
}

function harness(opts: { maxRetries?: number; autoRecover?: boolean; monitor?: NetworkMonitor } = {}): Harness {
  const clock = new FakeClock();
  const store = new StateStore(createDashboard());
  const claude = new MockDriver({ kind: 'claude' });
  const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });

  const manager = new SessionManager({
    store,
    drivers: { claude, codex },
    clock,
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
  });

  const waits: number[] = [];
  const coordinator = new RecoveryCoordinator({
    store,
    manager,
    monitor: opts.monitor,
    options: {
      maxRetries: opts.maxRetries ?? 3,
      autoRecover: opts.autoRecover ?? true,
      maxWaitMs: 2_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  });

  const events: StoreEvent[] = [];
  store.on((e) => events.push(e));

  return { manager, store, claude, codex, coordinator, events, waits, clock };
}

/**
 * 指示を出して、途中で固まらせる。
 * 実行中の Promise はオブジェクトに包んで返す。裸で返すと async 関数の
 * 戻り値として平坦化され、呼び出し側の await が「固まったターンの完了」を
 * 待ってしまう。
 */
async function startHangingTurn(
  h: Harness,
  emp: Session,
  prompt: string,
  hangAfter = 2,
): Promise<{ running: Promise<unknown> }> {
  h.claude.setHangAfter(hangAfter);
  h.codex.setHangAfter(hangAfter);
  h.claude.setScenario(() => successfulTurn({ files: ['a.ts'] }));
  h.codex.setScenario(() => successfulTurn({ files: ['a.ts'] }));

  const running = h.manager.dispatch(emp.id, prompt);
  await settle();
  return { running };
}

function stopHanging(h: Harness): void {
  h.claude.setHangAfter(null);
  h.codex.setHangAfter(null);
}

// ---------------------------------------------------------------------------

describe('影響範囲（SPEC §10.1）', () => {
  test('全員待機中なら何もしない', async () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.manager.createSession({ kind: 'claude' });

    const report = await h.coordinator.recover();

    assert.deepEqual(report, { ok: [], failed: [], skipped: [] });
    assert.equal(h.events.some((e) => e.t === 'recovery_started'), false);
  });

  test('稼働中の社員だけが対象になる', async () => {
    const h = harness();
    const idle = h.manager.createSession({ kind: 'claude' });
    const busy = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, busy, 'やって');

    const targets = h.coordinator.targets().map((e) => e.id);
    assert.deepEqual(targets, [busy.id]);
    assert.equal(idle.state, 'idle');

    stopHanging(h);
    await h.coordinator.recover();
    await running;
  });
});

// ---------------------------------------------------------------------------

describe('中断と復帰（SPEC §10.3 / §10.5）', () => {
  test('中断されたタスクは interrupted で、経験値を減らさない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, '認証を直して');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    await h.coordinator.recover();
    const interruptedTask = (await running) as { status: string };

    assert.equal(interruptedTask.status, 'interrupted');
    assert.equal(emp.stats.tasksInterrupted, 1);
    assert.equal(emp.stats.tasksFailed, 0, '社員の失敗ではない');
  });

  test('元の指示を再送せず、状態確認を挟んだ復帰プロンプトを送る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'calc.js に sub を追加して');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    await h.coordinator.recover();
    await running;

    const recoveryPrompt = h.claude.calls.at(-1)!.prompt;
    assert.notEqual(recoveryPrompt, 'calc.js に sub を追加して', '素の再送はしない');
    assert.match(recoveryPrompt, /中断されました/);
    assert.match(recoveryPrompt, /未完了の作業があれば続きから/, '二重実行を避けさせる');
    assert.match(recoveryPrompt, /calc\.js に sub を追加して/, '元の指示は文脈として渡す');
  });

  test('復帰に成功すると idle に戻り、復帰回数が増える', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn({ text: '続きから完了しました' }));

    const report = await h.coordinator.recover();
    await running;

    assert.deepEqual(report.ok, [emp.id]);
    assert.equal(emp.state, 'idle');
    assert.equal(emp.stats.reconnects, 1);
    assert.equal(emp.recovery.lastError, null);
  });

  test('復帰ターンは元の中断タスクを指す', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    await h.coordinator.recover();
    const interrupted = (await running) as { id: string };

    assert.equal(emp.currentTask?.recoveredFrom, interrupted.id);
  });

  test('復帰の開始と終了が通知される', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    await h.coordinator.recover();
    await running;

    assert.ok(h.events.some((e) => e.t === 'recovery_started'));
    assert.ok(h.events.some((e) => e.t === 'recovery_finished'));
    assert.ok(h.events.some((e) => e.t === 'state_changed' && e.to === 'reconnecting'));
  });
});

// ---------------------------------------------------------------------------

describe('同一ディレクトリでの復帰順序（SPEC §10.4）', () => {
  test('同居している社員は直列に復帰する', async () => {
    const h = harness();
    const shared = workspaceAt('/ws/shared');
    const a = h.manager.createSession({ kind: 'claude', workspace: shared });
    const b = h.manager.createSession({ kind: 'claude', workspace: { ...shared } });

    const { running: ra } = await startHangingTurn(h, a, 'A の作業');
    const { running: rb } = await startHangingTurn(h, b, 'B の作業');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    const timeline: string[] = [];
    h.store.on((e) => {
      if (e.t === 'task_started' && e.task.recoveredFrom !== null) timeline.push(`start:${e.sessionId}`);
      if (e.t === 'task_finished' && e.task.recoveredFrom !== null) timeline.push(`end:${e.sessionId}`);
    });

    await h.coordinator.recover();
    await Promise.all([ra, rb]);

    assert.equal(timeline.length, 4);
    assert.equal(timeline[0]!.startsWith('start:'), true);
    assert.equal(
      timeline[1],
      timeline[0]!.replace('start:', 'end:'),
      `重なっている: ${timeline.join(' → ')}`,
    );
  });

  test('隔離されていれば並行に復帰する', async () => {
    const h = harness();
    const a = h.manager.createSession({ kind: 'claude', workspace: workspaceAt('/wt/a') });
    const b = h.manager.createSession({ kind: 'claude', workspace: workspaceAt('/wt/b') });

    const { running: ra } = await startHangingTurn(h, a, 'A の作業');
    const { running: rb } = await startHangingTurn(h, b, 'B の作業');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    const timeline: string[] = [];
    h.store.on((e) => {
      if (e.t === 'task_started' && e.task.recoveredFrom !== null) timeline.push(`start:${e.sessionId}`);
      if (e.t === 'task_finished' && e.task.recoveredFrom !== null) timeline.push(`end:${e.sessionId}`);
    });

    await h.coordinator.recover();
    await Promise.all([ra, rb]);

    assert.equal(timeline.filter((t) => t.startsWith('start:')).length, 2);
    assert.ok(
      timeline[0]!.startsWith('start:') && timeline[1]!.startsWith('start:'),
      `並行に始まっていない: ${timeline.join(' → ')}`,
    );
  });

  test('1 人が失敗しても他は独立に復帰する', async () => {
    const h = harness({ maxRetries: 1 });
    const a = h.manager.createSession({ kind: 'claude', workspace: workspaceAt('/wt/a') });
    const b = h.manager.createSession({ kind: 'claude', workspace: workspaceAt('/wt/b') });

    const { running: ra } = await startHangingTurn(h, a, 'A の作業');
    const { running: rb } = await startHangingTurn(h, b, 'B の作業');
    stopHanging(h);

    // A の復帰だけ失敗させる
    h.claude.setScenario((ctx) => (ctx.sessionId === a.id ? failingTurn('まだ繋がらない') : successfulTurn()));

    const report = await h.coordinator.recover();
    await Promise.all([ra, rb]);

    assert.deepEqual(report.failed, [a.id]);
    assert.deepEqual(report.ok, [b.id]);
    assert.equal(a.state, 'error');
    assert.equal(b.state, 'idle');
  });
});

// ---------------------------------------------------------------------------

describe('リトライと諦め（SPEC §10.3 / §10.7）', () => {
  test('指数バックオフで再試行し、成功したら止まる', async () => {
    const h = harness({ maxRetries: 3 });
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);

    let attempts = 0;
    h.claude.setScenario(() => {
      attempts += 1;
      return attempts < 3 ? failingTurn('まだ繋がらない') : successfulTurn();
    });

    const report = await h.coordinator.recover();
    await running;

    assert.equal(attempts, 3);
    assert.deepEqual(h.waits, [2_000, 8_000], '2 秒 → 8 秒');
    assert.deepEqual(report.ok, [emp.id]);
  });

  test('回数を使い切ったら error にして諦める', async () => {
    const h = harness({ maxRetries: 3 });
    const emp = h.manager.createSession({ kind: 'claude' });

    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => failingTurn('ずっと繋がらない'));

    const report = await h.coordinator.recover();
    await running;

    assert.deepEqual(report.failed, [emp.id]);
    assert.equal(emp.state, 'error');
    assert.equal(emp.recovery.attempts, 3);
    assert.match(emp.lastError ?? '', /繋がらない/);
    assert.ok(h.events.some((e) => e.t === 'notify' && e.reason === 'recovery_failed'));
  });

  test('セッション未確定のまま切れたら復帰せず、指示をメモに書き戻す', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex' });

    // session_started の前で固まる = codex の 1 ターン目で切れた状況
    h.codex.setHangAfter(0);
    const running = h.manager.dispatch(emp.id, '認証まわりを調べて');
    await settle();

    assert.equal(emp.agentSessionId, null);

    stopHanging(h);
    const report = await h.coordinator.recover();
    await running;

    assert.deepEqual(report.skipped, [emp.id]);
    assert.equal(emp.state, 'idle');
    assert.equal(emp.drafts[0]?.text, '認証まわりを調べて', '控えに戻ってやり直せる');
    assert.equal(h.codex.calls.length, 1, '復帰の指示は送っていない');
  });

  test('先にあった控えを潰さない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex' });
    h.manager.addDraft(emp.id, '先に書いておいた控え');

    h.codex.setHangAfter(0);
    const running = h.manager.dispatch(emp.id, '認証まわりを調べて');
    await settle();

    stopHanging(h);
    await h.coordinator.recover();
    await running;

    assert.deepEqual(
      emp.drafts.map((d) => d.text),
      ['先に書いておいた控え', '認証まわりを調べて'],
      '並べて残す。どちらを送るかは選べる。',
    );
  });
});

// ---------------------------------------------------------------------------

describe('NetworkMonitor との連携', () => {
  function iface(address: string): IfaceInfo {
    return { address, family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false };
  }

  test('ネットワーク変更を検知したら自動で復帰する', async () => {
    const clock = new FakeClock();
    let ifaces: Record<string, IfaceInfo[] | undefined> = { wlan0: [iface('192.168.1.10')] };
    const monitor = new NetworkMonitor({
      clock,
      readInterfaces: () => ifaces,
      stabilizeMs: 3_000,
    });

    const h = harness({ monitor });
    const detach = h.coordinator.attach();

    const emp = h.manager.createSession({ kind: 'claude' });
    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    // WiFi が切り替わり、安定する
    ifaces = { wlan0: [iface('10.0.0.5')] };
    clock.advance(5_000);
    monitor.tick();
    clock.advance(5_000);
    monitor.tick();

    await h.coordinator.recover();
    await running;

    assert.equal(emp.stats.reconnects, 1);
    assert.equal(emp.state, 'idle');
    detach();
  });

  test('autoRecover が false なら検知しても自動復帰しない', async () => {
    const clock = new FakeClock();
    let ifaces: Record<string, IfaceInfo[] | undefined> = { wlan0: [iface('192.168.1.10')] };
    const monitor = new NetworkMonitor({ clock, readInterfaces: () => ifaces, stabilizeMs: 1_000 });

    const h = harness({ monitor, autoRecover: false });
    h.coordinator.attach();

    const emp = h.manager.createSession({ kind: 'claude' });
    const { running } = await startHangingTurn(h, emp, 'やって');

    ifaces = { wlan0: [iface('10.0.0.5')] };
    clock.advance(5_000);
    monitor.tick();
    clock.advance(5_000);
    monitor.tick();
    await settle();

    assert.equal(h.events.some((e) => e.t === 'recovery_started'), false);
    assert.equal(emp.state !== 'idle', true, 'まだ固まったまま');

    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());
    await h.coordinator.recover();
    await running;
  });

  test('ネットワークが戻らなければ諦めて error にする', async () => {
    const clock = new FakeClock();
    const monitor = new NetworkMonitor({
      clock,
      readInterfaces: () => ({}),
      stabilizeMs: 1_000,
    });

    const h = harness({ monitor });
    const emp = h.manager.createSession({ kind: 'claude' });
    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);

    const report = await h.coordinator.recover();
    await running;

    assert.deepEqual(report.failed, [emp.id]);
    assert.equal(emp.state, 'error');
    assert.match(emp.recovery.lastError ?? '', /復旧しませんでした/);
    assert.equal(h.claude.calls.length, 1, 'オフラインのまま指示は送らない');
  });

  test('復帰中に再度呼ばれても多重には走らない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    const { running } = await startHangingTurn(h, emp, 'やって');
    stopHanging(h);
    h.claude.setScenario(() => successfulTurn());

    const [r1, r2] = await Promise.all([h.coordinator.recover(), h.coordinator.recover()]);
    await running;

    assert.deepEqual(r1, r2);
    assert.equal(h.events.filter((e) => e.t === 'recovery_started').length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('復帰プロンプト', () => {
  test('二重実行を避ける指示が入っている', () => {
    const p = defaultRecoveryPrompt('テストを追加して');
    assert.match(p, /中断されました/);
    assert.match(p, /現在の状態を確認/);
    assert.match(p, /すでに完了している場合/);
    assert.match(p, /テストを追加して/);
  });
});
