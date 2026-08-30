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
    assert.equal(emp.nextPrompt, 'test');
    assert.equal(h.app.screenId, 'main');
  });

  test('Esc なら保存しない', () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, 'e', 'abc', '\x1b');
    assert.equal(emp.nextPrompt, '');
  });

  test('d で消す', () => {
    const h = harness();
    const emp = h.hire();
    h.manager.setNextPrompt(emp.id, '消される予定');
    press(h.app, 'd');
    assert.equal(emp.nextPrompt, '');
  });

  test('完了直後に下書きがあれば Enter でそのまま送る', async () => {
    const h = harness();
    const emp = h.hire();
    await h.manager.dispatch(emp.id, '最初の指示');
    h.manager.setNextPrompt(emp.id, 'ドキュメントも更新して');

    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(h.claude.calls[1]?.prompt, 'ドキュメントも更新して');
    assert.equal(emp.nextPrompt, '');
    assert.equal(h.app.screenId, 'main', '会話画面には入らない');
  });

  test('まだ何もしていないセッションは下書きがあっても会話画面に入る', () => {
    const h = harness();
    const emp = h.hire();
    h.manager.setNextPrompt(emp.id, 'いつか読む');

    press(h.app, '\r');
    assert.equal(h.app.screenId, 'conversation', '下書きがあっても履歴を見に行ける');
    assert.equal(emp.nextPrompt, 'いつか読む');
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

  test('入力欄が空のとき ↑ で履歴を遡る', async () => {
    const h = harness();
    const emp = h.hire();
    press(h.app, '\r');
    press(h.app, 'first', '\r');
    await new Promise((r) => setTimeout(r, 20));

    press(h.app, '\x1b[A');
    press(h.app, '\r');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.claude.calls[1]?.prompt, 'first');
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
