/** サブエージェント演出（SPEC §11）。claude セッションだけの機能。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { displayWidth } from '../src/tui/width.ts';
import type { AgentEvent } from '../src/core/types.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness() {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });
  const manager = new SessionManager({
    store,
    drivers: { claude, codex },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
  });
  const app = new App({ manager, terminal: new FakeTerminal(100, 32), animate: false });
  app.start();

  return {
    app,
    manager,
    claude,
    codex,
    press: (...raws: string[]) => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    },
    view: () => {
      app.render();
      return app.screen.toStrings().join('\n');
    },
  };
}

/**
 * サブエージェントが働いている最中で止まるシナリオ。
 * 最後のイベントまで流してから固まらせたいので、コマ数と合わせて使う。
 */
const IN_FLIGHT_EVENTS = 5;

function delegatingInFlight(): AgentEvent[] {
  return [
    { t: 'requesting' },
    {
      t: 'subagent_start',
      taskId: 'a1',
      toolUseId: 'tu1',
      agentType: 'Explore',
      description: '認証まわりを調査',
    },
    {
      t: 'subagent_start',
      taskId: 'a2',
      toolUseId: 'tu2',
      agentType: 'Plan',
      description: '移行手順を設計',
    },
    {
      t: 'subagent_progress',
      taskId: 'a1',
      description: 'src/auth 配下を確認',
      lastToolName: 'Bash',
      totalTokens: 8_217,
      toolUses: 3,
      durationMs: 3_768,
    },
    {
      t: 'subagent_progress',
      taskId: 'a2',
      description: '設計方針をまとめ中',
      lastToolName: 'Read',
      totalTokens: 4_120,
      toolUses: 1,
      durationMs: 2_100,
    },
  ];
}

// ---------------------------------------------------------------------------

describe('画面での見え方', () => {
  test('状態が DELEGATE になる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(delegatingInFlight);
    h.claude.setHangAfter(IN_FLIGHT_EVENTS);

    const running = h.manager.dispatch(emp.id, '調べて');
    await settle();

    assert.equal(emp.state, 'delegating');
    assert.equal(emp.subagents.length, 2);

    const text = h.view();
    assert.ok(text.includes('DELEGATE'), '席の状態ラベル');
    
    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });

  test('詳細に実データが出る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(delegatingInFlight);
    h.claude.setHangAfter(IN_FLIGHT_EVENTS);

    const running = h.manager.dispatch(emp.id, '調べて');
    await settle();

    const text = h.view();
    assert.ok(text.includes('サブエージェント 2'));
    assert.ok(text.includes('Explore'), '種別');
    assert.ok(text.includes('claude-1/1'), '名前');
    assert.ok(text.includes('Bash ×3'), '使っているツールと回数');
    assert.ok(text.includes('8k tok'), '消費トークン');
    assert.ok(text.includes('3.8s'), '作業時間');
    assert.ok(text.includes('src/auth 配下を確認'), '担当していること');
    assert.ok(text.includes('Plan'));

    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });

  test('複数動いていれば全部出る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      { t: 'requesting' },
      ...[1, 2, 3, 4].map(
        (n): AgentEvent => ({
          t: 'subagent_start',
          taskId: `a${n}`,
          toolUseId: `tu${n}`,
          agentType: 'Explore',
          description: `調査 ${n}`,
        }),
      ),
    ]);
    h.claude.setHangAfter(IN_FLIGHT_EVENTS);

    const running = h.manager.dispatch(emp.id, '調べて');
    await settle();

    assert.equal(emp.subagents.length, 4);
    assert.ok(h.view().includes('サブエージェント 4'), '全部数える');

    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });

  test('ターンが終わると消える', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      ...delegatingInFlight(),
      { t: 'subagent_end', taskId: 'a1', ok: true, summary: '調査完了' },
      { t: 'subagent_end', taskId: 'a2', ok: true, summary: '設計完了' },
      { t: 'text', delta: 'まとめました' },
      { t: 'turn_end', ok: true, result: 'まとめました' },
    ]);

    await h.manager.dispatch(emp.id, '調べて');
    await settle();

    assert.deepEqual(emp.subagents, [], '使い捨て');
    assert.equal(emp.stats.subagentsSpawned, 2, '累計だけ残る');
    assert.equal(h.view().includes('サブエージェント 2'), false);
    assert.ok(h.view().includes('サブ 2'), '集計には残る');
  });

  test('画面幅に収まる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      { t: 'requesting' },
      {
        t: 'subagent_start',
        taskId: 'a1',
        toolUseId: 'tu1',
        agentType: 'とても長い職種名'.repeat(3),
        description: 'とても長い担当業務の説明'.repeat(5),
      },
      {
        t: 'subagent_progress',
        taskId: 'a1',
        description: 'とても長い進捗の説明'.repeat(5),
        lastToolName: 'Bash',
        totalTokens: 1_234_567,
        toolUses: 999,
        durationMs: 999_999,
      },
    ]);
    h.claude.setHangAfter(3);

    const running = h.manager.dispatch(emp.id, '調べて');
    await settle();

    h.app.render();
    for (const row of h.app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
    }

    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });
});

describe('会話モードでの見え方', () => {
  test('作業が親の下にぶら下がる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      ...delegatingInFlight(),
      { t: 'subagent_end', taskId: 'a1', ok: true, summary: '8 ファイルを確認しました' },
      { t: 'subagent_end', taskId: 'a2', ok: true, summary: '3 段階の移行手順' },
      { t: 'text', delta: 'サブエージェントの報告をまとめました' },
      { t: 'turn_end', ok: true, result: 'サブエージェントの報告をまとめました' },
    ]);

    await h.manager.dispatch(emp.id, '調べて');
    await settle();

    h.press('\r');
    const text = h.view();
    assert.ok(text.includes('Agent'), 'サブエージェントを呼んだことが分かる');
    assert.ok(text.includes('認証まわりを調査'));
    assert.ok(text.includes('8 ファイルを確認しました'), '成果報告');
    assert.ok(text.includes('サブエージェントの報告をまとめました'), '上司のまとめ');
  });

  test('Tab で行を畳める', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      ...delegatingInFlight(),
      { t: 'subagent_end', taskId: 'a1', ok: true, summary: '調査完了' },
      { t: 'subagent_end', taskId: 'a2', ok: true, summary: '設計完了' },
      { t: 'turn_end', ok: true, result: 'ok' },
    ]);
    await h.manager.dispatch(emp.id, '調べて');
    await settle();

    h.press('\r');
    assert.ok(h.view().includes('src/auth 配下を確認'));
    h.press('\t');
    assert.equal(h.view().includes('src/auth 配下を確認'), false);
    h.press('\t');
    assert.ok(h.view().includes('src/auth 配下を確認'));
  });
});

describe('codex セッション', () => {
  test('サブエージェントは出ない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex' });
    h.codex.setScenario(() => successfulTurn());
    await h.manager.dispatch(emp.id, 'やって');
    await settle();

    assert.equal(emp.stats.subagentsSpawned, 0);
    assert.equal(emp.stats.subagentsSpawned, 0);
  });
});
