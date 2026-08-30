/** 次やること下書き（SPEC §12）。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { RecoveryCoordinator } from '../src/core/recovery.ts';
import { flagsFor } from '../src/tui/views/table.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness(opts: { autoSendNextMemo?: boolean } = {}) {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  claude.setScenario(() => successfulTurn());
  const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });
  const manager = new SessionManager({
    store,
    drivers: { claude, codex },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws', autoSendNextMemo: opts.autoSendNextMemo ?? false },
  });
  const term = new FakeTerminal(100, 32);
  const app = new App({ manager, terminal: term, animate: false });
  app.start();

  return {
    app,
    manager,
    claude,
    codex,
    store,
    press: (...raws: string[]) => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    },
    view: () => {
      app.render();
      return app.screen.toStrings().join('\n');
    },
  };
}

// ---------------------------------------------------------------------------

describe('編集と保存', () => {
  test('m で開いて書いて Enter で保存する', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    h.press('e');
    assert.ok(h.view().includes('次に送るプロンプト'));
    h.press('doc', '\r');

    assert.equal(emp.nextPrompt, 'doc');
  });

  test('Alt+Enter で複数行書ける', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.press('e', 'one', '\x1b\r', 'two', '\r');
    assert.equal(emp.nextPrompt, 'one\ntwo');
  });

  test('既存の下書きを開くと編集できる状態で入る', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.manager.setNextPrompt(emp.id, '既存の内容');

    h.press('e');
    assert.ok(h.view().includes('既存の内容'));
    h.press('\x7f\x7f', '\r');
    assert.equal(emp.nextPrompt, '既存の', 'バックスペース 2 回ぶん');
  });

  test('会話モードからは Alt+e で開ける', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.press('\r');
    h.press('\x1be');
    assert.equal(h.app.screenId, 'draft');
    h.press('x', '\r');
    assert.equal(emp.nextPrompt, 'x');
  });

  test('会話モードで打った e は必ず文字として入る', () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.press('\r');

    // 入力欄が空でも文字を奪わない。日本語入力中に画面が飛ばないように。
    h.press('e');
    assert.equal(h.app.screenId, 'conversation');
    h.press('dit');
    assert.ok(h.view().includes('edit'));
  });
});

describe('席と詳細への表示', () => {
  test('下書きがあると席にバッジが出る', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    assert.equal(flagsFor(emp).includes('P'), false);
    h.manager.setNextPrompt(emp.id, 'あとで');
    assert.ok(flagsFor(emp).includes('P'));
  });

  test('作業中は 1 行の控えめな表示', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.manager.setNextPrompt(emp.id, 'あとでドキュメント');

    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(emp.id, '作業中');
    await settle();

    const text = h.view();
    assert.ok(text.includes('[P] 次: あとでドキュメント'));
    assert.equal(text.includes('[Enter] 送信'), false);

    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });

  test('タスクが終わると「そのまま出せる」と提示する', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.manager.setNextPrompt(emp.id, 'テストを追加して');
    await h.manager.dispatch(emp.id, 'まず実装');
    await settle();

    const text = h.view();
    assert.ok(text.includes('次に送るプロンプト'));
    assert.ok(text.includes('「テストを追加して」'));
    assert.ok(text.includes('[Enter] 送信'));
    assert.ok(text.includes('[d] 削除'));
  });
});

describe('送信', () => {
  test('完了後の Enter で下書きがそのまま指示になる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'まず実装');
    h.manager.setNextPrompt(emp.id, 'テストを追加して');

    h.press('\r');
    await settle();

    assert.equal(h.claude.calls[1]?.prompt, 'テストを追加して');
    assert.equal(emp.nextPrompt, '', '送ったら消える');
    assert.equal(h.app.screenId, 'main', '会話画面には入らない');
  });

  test('下書きが無ければ Enter は会話モードに入る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'なにか');
    h.press('\r');
    assert.equal(h.app.screenId, 'conversation');
  });

  test('会話モードで入力欄が空なら Enter で下書きを送る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });

    // 下書きが無い状態で入る（下書きがあるとオフィスの Enter で直接送られてしまう）
    h.press('\r');
    assert.equal(h.app.screenId, 'conversation');

    h.manager.setNextPrompt(emp.id, '下書きの内容');
    h.press('\r');
    await settle();

    assert.equal(h.claude.calls[0]?.prompt, '下書きの内容');
    assert.equal(emp.nextPrompt, '');
  });

  test('送った下書きは会話履歴に残る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, '最初の指示');
    h.manager.setNextPrompt(emp.id, '下書きから出した指示');

    h.press('\r');
    await settle();

    h.press('\r');
    assert.ok(h.view().includes('下書きから出した指示'));
  });

  test('d で消すと提示も消える', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'なにか');
    h.manager.setNextPrompt(emp.id, '消される');
    assert.ok(h.view().includes('消される'));

    h.press('d');
    assert.equal(emp.nextPrompt, '');
    assert.equal(h.view().includes('消される'), false);
  });
});

describe('自動送信', () => {
  test('オンなら完了後に自動で次を実行する', async () => {
    const h = harness({ autoSendNextMemo: true });
    const emp = h.manager.createSession({ kind: 'claude' });
    h.manager.setNextPrompt(emp.id, '次はドキュメント');

    await h.manager.dispatch(emp.id, 'まずコード');
    await settle();

    assert.deepEqual(h.claude.calls.map((c) => c.prompt), ['まずコード', '次はドキュメント']);
    assert.equal(emp.nextPrompt, '');
    assert.equal(emp.stats.tasksCompleted, 2);
  });

  test('オフなら残ったまま。ユーザーが押すまで動かない', async () => {
    const h = harness({ autoSendNextMemo: false });
    const emp = h.manager.createSession({ kind: 'claude' });
    h.manager.setNextPrompt(emp.id, '次はドキュメント');

    await h.manager.dispatch(emp.id, 'まずコード');
    await settle();

    assert.equal(h.claude.calls.length, 1);
    assert.equal(emp.nextPrompt, '次はドキュメント');
  });

  test('設定画面に現在の値が出る', () => {
    const h = harness({ autoSendNextMemo: true });
    h.press(',');
    assert.ok(h.view().includes('下書きの自動送信'));
    assert.ok(h.view().includes('オン'));
  });
});

describe('復帰との連携（SPEC §10.7）', () => {
  test('セッション未確定で切れたら、元の指示が下書きに戻る', async () => {
    const h = harness();
    const recovery = new RecoveryCoordinator({
      store: h.store,
      manager: h.manager,
      options: { sleep: async () => {} },
    });
    const emp = h.manager.createSession({ kind: 'codex' });

    // session_started の前で固まる
    h.codex.setHangAfter(0);
    const running = h.manager.dispatch(emp.id, '認証まわりを調べて');
    await settle();
    assert.equal(emp.agentSessionId, null);

    h.codex.setHangAfter(null);
    await recovery.recover();
    await running;

    assert.equal(emp.nextPrompt, '認証まわりを調べて');
    assert.equal(emp.state, 'idle');

    // ユーザーが Enter を押せばやり直せる
    h.codex.setScenario(() => successfulTurn());
    h.press('\r');
    await settle();
    assert.equal(h.codex.calls[1]?.prompt, '認証まわりを調べて');
  });
});
