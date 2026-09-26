/** キー操作の配線（SPEC §16）。FakeTerminal で端末なしに検証する。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn, deniedTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { MOUSE_OFF, MOUSE_ON } from '../src/tui/ansi.ts';
import type { Session } from '../src/core/types.ts';

interface Harness {
  app: App;
  term: FakeTerminal;
  manager: SessionManager;
  claude: MockDriver;
  hire: (name?: string) => Session;
  view: () => string;
}

function harness(): Harness {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  claude.setScenario(() => successfulTurn());
  const manager = new SessionManager({
    store,
    drivers: { claude, codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
  });
  const term = new FakeTerminal(100, 32);
  const app = new App({ manager, terminal: term, animate: false, defaultCwd: '/ws' });

  let n = 0;
  return {
    app,
    term,
    manager,
    claude,
    hire: (name) => manager.createSession({ kind: 'claude', name: name ?? `名${(n += 1)}` }),
    view: () => {
      app.render();
      return app.screen.toStrings().join('\n');
    },
  };
}

/** 生の入力をそのままアプリに流す */
function press(app: App, ...raws: string[]): void {
  for (const raw of raws) {
    for (const k of decodeKeys(raw)) app.handleKey(k);
  }
}

describe('コピー選択モード', () => {
  test('F2なしのドラッグでコピーし、選択中は描画を止め、Esc・入力で再開する', async () => {
    const h = harness();
    h.hire();
    h.app.start();
    try {
      h.term.feed('\r編集中');
      h.app.screen.text(2, 5, '日本語の回答');
      h.term.feed('\x1b[<0;3;6M');
      h.term.feed('\x1b[<32;7;6M');
      h.term.feed('\x1b[<0;7;6m');
      await Promise.resolve();
      assert.deepEqual(h.term.copies, ['日本語']);
      assert.ok(!h.term.output.join('').includes(MOUSE_OFF), '通常のホイール報告を解除しない');
      h.term.output.length = 0;
      h.app.render();
      h.app.tick();
      assert.equal(h.term.output.length, 0, '非同期の再描画は選択を変えない');
      h.term.feed('\x03');
      await Promise.resolve();
      assert.deepEqual(h.term.copies, ['日本語', '日本語']);
      assert.ok(h.app.screen.toStrings().join('\n').includes('編集中'), 'Ctrl+Cでも入力を消さない');
      h.term.feed('\x1b');
      assert.equal(h.app.screenId, 'conversation', 'Escは選択だけを解除');
      h.term.feed('追記');
      assert.ok(h.view().includes('編集中追記'));
    } finally { h.app.stop(); }
  });

  test('クリックだけではコピーせず、選択後のホイール・リサイズ・F2も動く', async () => {
    const h = harness();
    h.hire();
    h.hire();
    h.app.start();
    try {
      h.term.feed('\x1b[<0;3;6M\x1b[<0;3;6m');
      assert.deepEqual(h.term.copies, []);
      h.app.screen.text(2, 5, '回答');
      h.term.feed('\x1b[<0;3;6M\x1b[<0;5;6m');
      await Promise.resolve();
      h.term.feed('\x1b[<65;10;10M');
      assert.equal(h.app.selectedRow, 1, 'ホイールを維持する');
      h.term.feed('\x1b[<0;3;6M\x1b[<32;5;6M');
      h.term.resize(120, 35);
      assert.equal(h.app.screen.width, 120);
      h.term.feed('\x1b[<0;5;6m');
      assert.equal(h.term.copies.length, 1, 'リサイズ前の座標でコピーしない');
      h.term.feed('\x1b[<0;3;6M\x1b[<32;5;6M\x1bOQ');
      assert.ok(h.term.output.join('').includes(MOUSE_OFF));
      assert.ok(h.app.screen.toStrings().join('\n').includes('コピー: ドラッグ'));
    } finally { h.app.stop(); }
  });

  test('コピー失敗はF2の案内を出し、アプリを落とさない', async () => {
    const h = harness();
    h.term.copyText = async () => { throw new Error('clipboard unavailable'); };
    h.app.start();
    try {
      h.app.screen.text(2, 5, '回答');
      h.term.feed('\x1b[<0;3;6M\x1b[<0;5;6m');
      await Promise.resolve();
      assert.ok(h.app.screen.toStrings().join('\n').includes('コピー失敗'));
      assert.equal(h.app.running, true);
    } finally { h.app.stop(); }
  });

  test('コピーを連打しても同時に1件。完了が遅れても別画面へ出力しない', async () => {
    const h = harness();
    let finish!: () => void;
    let calls = 0;
    h.term.copyText = () => { calls += 1; return new Promise<void>((resolve) => { finish = resolve; }); };
    h.app.start();
    try {
      h.app.screen.text(2, 5, '回答');
      h.term.feed('\x1b[<0;3;6M\x1b[<0;5;6m');
      h.term.feed('\x03\x03');
      assert.equal(calls, 1);
      h.term.feed('\x1b');
      h.term.output.length = 0;
      finish();
      await Promise.resolve();
      assert.equal(h.term.output.length, 0, '解除後はコピー完了画面を描かない');
    } finally { h.app.stop(); }
  });

  test('AIが実行中でもドラッグ・Ctrl+Cで中断しない', async () => {
    const h = harness();
    const session = h.hire();
    h.claude.setHangAfter(1);
    h.app.start();
    const turn = h.manager.dispatch(session.id, '処理中');
    try {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      h.term.feed('\r');
      h.app.screen.text(2, 5, '回答');
      h.term.feed('\x1b[<0;3;6M\x1b[<0;5;6m');
      await Promise.resolve();
      h.term.feed('\x03');
      await Promise.resolve();
      assert.equal(h.manager.isRunning(session.id), true);
      assert.equal(h.term.copies.length, 2);
    } finally {
      h.manager.interrupt(session.id, 'user');
      await turn;
      h.app.stop();
    }
  });

  test('F2 で通常ドラッグへ切り替え、コピー中の操作は入力や画面を変えない', () => {
    const h = harness();
    h.hire();
    h.app.start();
    try {
      h.term.feed('\r');
      h.term.feed('編集中');
      h.term.feed('\x1bOQ');
      const snapshot = h.app.screen.toStrings().join('\n');
      assert.ok(snapshot.includes('コピー: ドラッグ'));
      assert.ok(snapshot.includes('編集中'));
      const output = h.term.output.join('');
      for (const mode of [1000, 1002, 1003, 1006]) {
        assert.ok(output.includes(`\x1b[?${mode}l`), `マウス報告 ${mode} を解除`);
      }

      h.term.output.length = 0;
      h.term.feed('\x03'); // Ctrl+Shift+C を端末が Ctrl+C として送る場合
      h.term.feed('\x1b[200~貼付け\x1b[201~');
      h.term.feed('\x1b[<65;10;10M');
      h.app.render();
      h.app.tick();
      assert.equal(h.term.output.length, 0);
      assert.equal(h.app.screen.toStrings().join('\n'), snapshot);
      h.term.resize(120, 35);
      assert.equal(h.term.output.length, 0, 'リサイズもコピー中の出力を行わない');

      h.term.feed('\x1b');
      assert.equal(h.app.screenId, 'conversation', 'Esc は画面を閉じずコピーを終了');
      assert.ok(h.term.output.join('').includes(MOUSE_ON));
      assert.ok(h.app.screen.toStrings().join('\n').includes('編集中'));
      assert.ok(!h.app.screen.toStrings().join('\n').includes('貼付け'));
      assert.equal(h.app.screen.width, 120);
    } finally {
      h.app.stop();
    }
  });

  test('Alt+C でマウス報告を止め、もう一度押すと戻す', () => {
    const h = harness();

    press(h.app, '\x1bc');
    assert.ok(h.term.output.join('').includes(MOUSE_OFF));
    assert.ok(h.view().includes('コピー選択モード'));

    h.term.output.length = 0;
    h.app.tick();
    assert.equal(h.term.output.length, 0, '選択中は定期再描画でコピー範囲を消さない');
    press(h.app, '\x1bc');
    assert.ok(h.term.output.join('').includes(MOUSE_ON));
  });
});

describe('実行中の追加指示', () => {
  test('Enterは実行中のターンへ渡し、失敗した文章は控えに残す', async () => {
    const h = harness();
    const session = h.hire();
    h.claude.setHangAfter(1);
    const sent: string[] = [];
    Object.assign(h.claude, { steer: async (_id: string, prompt: string) => {
      if (prompt === '送信失敗') throw new Error('接続失敗');
      sent.push(prompt);
      h.manager.store.emit({ t: 'agent_event', sessionId: session.id,
        event: { t: 'user_message', text: prompt } });
    } });
    h.app.start();
    try {
      const turn = h.manager.dispatch(session.id, '最初の指示');
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      session.currentTask!.pid = 123;
      session.currentTask!.outFile = '/tmp/fake-current.jsonl';
      press(h.app, '\r', '途中の追加指示', '\r');
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      assert.deepEqual(sent, ['途中の追加指示']);
      assert.equal(h.claude.calls.length, 1, '2つ目のプロセスを開始しない');
      assert.equal(session.drafts.length, 0, '受付確認できた控えだけ消す');
      assert.ok(h.view().includes('途中の追加指示'));

      press(h.app, '送信失敗', '\r');
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      assert.ok(session.drafts.some((d) => d.text === '送信失敗'));
      assert.ok(h.view().includes('受付を確認できませんでした'));
      assert.equal(h.manager.isRunning(session.id), true, '元の作業は続いている');
      h.manager.interrupt(session.id, 'user');
      await turn;
    } finally {
      h.manager.interrupt(session.id, 'user');
      h.app.stop();
    }
  });
});

describe('Codex の会話タイトル', () => {
  test('起動時に Codex 自身の生成タイトルを同期する', () => {
    const h = harness();
    const session = h.manager.createSession({
      kind: 'codex',
      agentSessionId: '019f0000-0000-7000-8000-000000000088',
    });
    const app = new App({
      manager: h.manager,
      terminal: new FakeTerminal(170, 32),
      animate: false,
      loadCodexThreadNames: () => new Map([[session.agentSessionId!, '導入可否を確認する']]),
    });

    app.start();

    assert.equal(session.conversationTitle, '導入可否を確認する');
    assert.ok(app.screen.toStrings().some((row) => row.includes('導入可否を確認する')));
  });
});

// ---------------------------------------------------------------------------

describe('席の選択', () => {
  test('矢印と vim キーで動き、端で回り込む', () => {
    const h = harness();
    assert.equal(h.app.selectedRow, 0);

    press(h.app, '\x1b[C');
    assert.equal(h.app.selectedRow, 1);
    press(h.app, 'l');
    assert.equal(h.app.selectedRow, 2);
    press(h.app, '\x1b[D', 'h');
    assert.equal(h.app.selectedRow, 0);
    press(h.app, '\x1b[D');
    assert.equal(h.app.selectedRow, 5, '左端から右端へ回り込む');
  });

  test('番号キーで直接選ぶ', () => {
    const h = harness();
    press(h.app, '4');
    assert.equal(h.app.selectedRow, 3);
    press(h.app, '9');
    assert.equal(h.app.selectedRow, 3, '席数を超える番号は無視する');
  });

  test('Tab は稼働中のセッションを優先して巡回する', async () => {
    const h = harness();
    h.hire('A');
    const busy = h.hire('B');
    h.hire('C');

    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(busy.id, 'やって');
    await new Promise((r) => setTimeout(r, 5));

    press(h.app, '\t');
    assert.equal(h.app.selectedRow, busy.slot, '作業中のセッションに飛ぶ');

    h.claude.setHangAfter(null);
    h.manager.interrupt(busy.id, 'user');
    await running;
  });

  test('Tab は誰もいなければ動かない', () => {
    const h = harness();
    press(h.app, '\t');
    assert.equal(h.app.selectedRow, 0);
  });

  test('Space で詳細の展開を切り替える', () => {
    const h = harness();
    assert.equal(h.app.expanded, false);
    press(h.app, ' ');
    assert.equal(h.app.expanded, true);
  });
});

describe('画面の行き来', () => {
  test('各パネルを開いて Esc で戻る', () => {
    const h = harness();
    for (const [key, id] of [['?', 'help'], ['L', 'log'], ['a', 'archive'], ['s', 'stats'], [',', 'settings']] as const) {
      press(h.app, key);
      assert.equal(h.app.screenId, id, `${key} で ${id} が開く`);
      press(h.app, '\x1b');
      assert.equal(h.app.screenId, 'main');
    }
  });

  test('ヘルプにキーバインドが並ぶ', () => {
    const h = harness();
    press(h.app, '?');
    const text = h.view();
    assert.ok(text.includes('ヘルプ'));
    assert.ok(text.includes('行を選ぶ'));
  });

  test('パネルをスクロールできる', () => {
    const h = harness();
    press(h.app, '?');
    const top = h.view();
    press(h.app, '\x1b[6~');
    const scrolled = h.view();
    assert.notEqual(top, scrolled, 'PgDn で表示が変わる');
    press(h.app, 'g');
    assert.equal(h.view(), top, 'g で先頭に戻る');
  });

  test('Enter で会話モードに入り Esc で戻る', () => {
    const h = harness();
    h.hire();
    press(h.app, '\r');
    assert.equal(h.app.screenId, 'conversation');
    press(h.app, '\x1b');
    assert.equal(h.app.screenId, 'main');
  });

  test('空きで Enter を押すと追加ダイアログが開く', () => {
    const h = harness();
    press(h.app, '\r');
    assert.equal(h.app.screenId, 'hire');
  });
});

describe('追加とアーカイブ', () => {
  test('追加ダイアログで値を変えて追加する', () => {
    const h = harness();
    press(h.app, 'n');
    assert.equal(h.app.screenId, 'hire');

    // 1 行目は追加方法。AI 種別はその下。
    press(h.app, '\x1b[B', '\x1b[C'); // AI 種別を codex へ
    assert.ok(h.view().includes('codex'));
    assert.ok(h.view().includes('サンドボックス'), 'codex のときだけ出る項目');

    press(h.app, '\x1b[B', '\x1b[C'); // 得意分野を 1 つ進める
    press(h.app, '\r');

    assert.equal(h.app.screenId, 'main');
    const emp = h.manager.store.active()[0]!;
    assert.equal(emp.kind, 'codex');
    assert.equal(h.app.selectedRow, emp.slot, '追加したセッションが選択される');
  });

  test('Esc で追加を取りやめる', () => {
    const h = harness();
    press(h.app, 'n', '\x1b');
    assert.equal(h.app.screenId, 'main');
    assert.equal(h.manager.store.active().length, 0);
  });

  test('満席なら追加できないと知らせる', () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) h.hire();
    press(h.app, 'n');
    assert.equal(h.app.screenId, 'main');
    assert.ok(h.view().includes('スロットが空いていません'));
  });

  test('X で確認してからアーカイブさせる', () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, 'X');
    assert.equal(h.app.screenId, 'confirm');
    assert.ok(h.view().includes('アーカイブ'));

    press(h.app, 'n');
    assert.equal(emp.archived, false, '「いいえ」なら何も起きない');

    press(h.app, 'X', 'y');
    assert.equal(emp.archived, true);
  });
});

describe('下書き', () => {
  test('m で編集して Enter で保存する', () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, 'e');
    assert.equal(h.app.screenId, 'draft');

    press(h.app, 'test');
    press(h.app, '\r');
    assert.equal(emp.drafts[0]?.text, 'test');
    assert.equal(h.app.screenId, 'main');
  });

  test('Esc なら足さない', () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, 'e', 'abc', '\x1b');
    assert.equal(emp.drafts.length, 0);
  });

  test('p の一覧から d で消す', () => {
    const h = harness();
    const emp = h.hire();
    h.manager.addDraft(emp.id, '消される予定');
    press(h.app, 'p', 'd');
    assert.equal(emp.drafts.length, 0);
  });

  test('完了直後でも Enter では送らない', async () => {
    // 返答を見て別のことを頼みたい場面がある。勝手に次が出て行くと取り消せない。
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, '最初の指示');
    h.manager.addDraft(emp.id, 'ドキュメントも更新して');

    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.claude.calls.length, 1, '控えは出て行かない');
    assert.equal(emp.drafts.length, 1);
    assert.equal(h.app.screenId, 'conversation');
  });

  test('p で選べば送る', async () => {
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, '最初の指示');
    h.manager.addDraft(emp.id, 'ドキュメントも更新して');

    press(h.app, 'p', '\r');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.claude.calls[1]?.prompt, 'ドキュメントも更新して');
    assert.equal(emp.drafts.length, 0);
  });
});

describe('承認待ち', () => {
  test('承認待ちがあると Enter で承認待ちが開き、y で承認する', async () => {
    const h = harness();
    const emp = h.hire();

    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn({ filePath: 'src/a.ts' }) : successfulTurn();
    });
    await h.manager.dispatch(emp.id, 'やって');
    assert.equal(emp.state, 'blocked');

    press(h.app, '\r');
    assert.equal(h.app.screenId, 'approval');
    const text = h.view();
    assert.ok(text.includes('承認待ち'));
    assert.ok(text.includes('src/a.ts'));

    press(h.app, 'y');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emp.pendingApprovals.length, 0);
    assert.equal(emp.stats.approvalsGranted, 1);
  });

  test('n で却下の理由を入力できる', async () => {
    const h = harness();
    const emp = h.hire();
    h.claude.setScenario(() => deniedTurn());
    await h.manager.dispatch(emp.id, 'やって');

    press(h.app, '\r', 'n');
    assert.ok(h.view().includes('却下の理由'));
    press(h.app, 'no', '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(emp.stats.approvalsGranted, 0);
  });

  test('a で今後は常に承認する', async () => {
    const h = harness();
    const emp = h.hire();
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn({ toolName: 'Edit' }) : successfulTurn();
    });
    await h.manager.dispatch(emp.id, 'やって');

    press(h.app, '\r', 'a');
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(h.manager.config.alwaysAllowedTools.includes('Edit'));
  });
});

describe('中断と終了', () => {
  test('Ctrl+C で作業中のタスクを止める', async () => {
    const h = harness();
    const emp = h.hire();
    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(emp.id, 'やって');
    await new Promise((r) => setTimeout(r, 5));

    press(h.app, '\x03');
    const task = (await running) as { status: string };
    assert.equal(task.status, 'cancelled');
  });

  test('作業中に q を押すと確認する', async () => {
    const h = harness();
    const emp = h.hire();
    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(emp.id, 'やって');
    await new Promise((r) => setTimeout(r, 5));

    press(h.app, 'q');
    assert.equal(h.app.screenId, 'confirm');
    assert.ok(h.view().includes('作業中'));

    press(h.app, 'n');
    h.claude.setHangAfter(null);
    h.manager.interrupt(emp.id, 'user');
    await running;
  });

  test('誰も作業していなければ q で即終了する', () => {
    const h = harness();
    h.hire();
    press(h.app, 'q');
    assert.equal(h.app.running, false);
  });

  test('Ctrl+L は画面を壊さない', () => {
    const h = harness();
    h.hire();
    press(h.app, '\x0c');
    assert.ok(h.view().includes('AGENT DASHBOARD'));
  });
});

describe('会話モードのキー', () => {
  test('文字を打って Enter で送る', async () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, '\r');
    press(h.app, 'hello');
    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.claude.calls[0]?.prompt, 'hello');
  });

  test('Alt+Enter は改行、Enter は送信', async () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, '\r');
    press(h.app, 'a', '\x1b\r', 'b');
    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.claude.calls[0]?.prompt, 'a\nb');
  });

  test('↑ を繰り返して複数の送信履歴を遡る', async () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, '\r');
    press(h.app, 'first', '\r');
    await new Promise((r) => setTimeout(r, 20));
    press(h.app, 'second', '\r');
    await new Promise((r) => setTimeout(r, 20));

    press(h.app, '\x1b[A', '\x1b[A');
    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.claude.calls[2]?.prompt, 'first');
  });

  test('入力途中でも ↑ で履歴を選び、↓ で元の入力へ戻れる', async () => {
    const h = harness();
    h.hire();
    press(h.app, '\r');
    press(h.app, 'first', '\r');
    await new Promise((r) => setTimeout(r, 20));

    press(h.app, '書きかけ', '\x1b[A', '\x1b[B', '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.claude.calls[1]?.prompt, '書きかけ');
  });

  test('Ctrl+C は入力中ならクリア、空なら中断', async () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, '\r');
    press(h.app, 'typing');
    press(h.app, '\x03');
    assert.ok(!h.view().includes('typing'), '入力がクリアされる');
    assert.equal(h.app.screenId, 'conversation', '画面は変わらない');
  });

  test('Tab でサブエージェントの表示を切り替える', () => {
    const h = harness();
    h.hire();
    press(h.app, '\r', '\t');
    assert.ok(h.view().includes('会話'));
  });
});

// ---------------------------------------------------------------------------

describe('終わったことが一覧で分かる', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  /** 一覧のその行だけを見る。詳細パネルにも ✓ が出るので混ざらないように。 */
  function tableRow(h: ReturnType<typeof harness>, name: string): string {
    return h.view().split('\n').find((r) => r.includes(name) && r.includes('%')) ?? '';
  }

  test('完了すると印が付く', async () => {
    const h = harness();
    const emp = h.hire();
    assert.equal(emp.unseenResult, null);

    await h.manager.dispatch(emp.id, 'やって');
    await settle();

    assert.equal(emp.unseenResult, 'done');
    assert.ok(tableRow(h, emp.name).includes('✓'), '一覧の行に出る');
  });

  test('失敗も区別して付く', async () => {
    const h = harness();
    const emp = h.hire();
    h.claude.setScenario(() => [{ t: 'turn_end', ok: false, result: 'こわれた' }]);

    await h.manager.dispatch(emp.id, 'やって');
    await settle();

    assert.equal(emp.unseenResult, 'failed');
    assert.ok(tableRow(h, emp.name).includes('×'));
  });

  test('会話を開くと消える', async () => {
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, 'やって');
    await settle();
    assert.equal(emp.unseenResult, 'done');

    press(h.app, '\r');
    assert.equal(emp.unseenResult, null, '見たので消える');

    press(h.app, '\x1b');
    assert.equal(tableRow(h, emp.name).includes('✓'), false);
  });

  test('次を頼んだ時点でも消える', async () => {
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, '一回目');
    await settle();

    const running = h.manager.dispatch(emp.id, '二回目');
    assert.equal(emp.unseenResult, null, '走り出した時点で前の結果は関係ない');
    await running;
  });

  test('実行中は動いている印を優先する', async () => {
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, 'やって');
    await settle();

    h.manager.forceState(emp.id, 'working');
    emp.unseenResult = 'done';
    assert.equal(tableRow(h, emp.name).includes('✓'), false, '動いている最中に完了印は出さない');
  });
});
