/**
 * 次に送るプロンプトの控え（SPEC §12）。
 *
 * 要は「勝手に出て行かないこと」。作業が終わったところで別のことを
 * 頼みたくなるのが普通で、自動で次が送られると取り消せない。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { flagsFor } from '../src/tui/views/table.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness() {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  claude.setScenario(() => successfulTurn());
  const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });
  const manager = new SessionManager({
    store,
    drivers: { claude, codex },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
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

describe('控えを書く', () => {
  test('e で開いて書いて Enter で足す', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });

    h.press('e');
    assert.equal(h.app.screenId, 'draft');
    h.press('次はテストを書いて', '\r');

    assert.equal(h.app.screenId, 'main');
    assert.equal(session.drafts.length, 1);
    assert.equal(session.drafts[0]!.text, '次はテストを書いて');
  });

  test('何件でも積める', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });

    h.press('e', 'ひとつ目', '\r');
    h.press('e', 'ふたつ目', '\r');
    h.press('e', 'みっつ目', '\r');

    assert.deepEqual(
      session.drafts.map((d) => d.text),
      ['ひとつ目', 'ふたつ目', 'みっつ目'],
    );
  });

  test('空では足さない', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.press('e', '\r');
    assert.equal(session.drafts.length, 0);
  });

  test('Ctrl+J で複数行書ける', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.press('e', '一行目', '\n', '二行目', '\r');
    assert.equal(session.drafts[0]!.text, '一行目\n二行目');
  });

  test('控えがあると行に印が出る', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    assert.equal(flagsFor(session).includes('P'), false);

    h.manager.addDraft(session.id, 'あとで');
    assert.ok(flagsFor(session).includes('P'));
  });
});

describe('選んで送る', () => {
  function withDrafts(...texts: string[]) {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    for (const t of texts) h.manager.addDraft(session.id, t);
    return { ...h, session };
  }

  test('p で一覧が開く', () => {
    const h = withDrafts('ひとつ目', 'ふたつ目');
    h.press('p');

    assert.equal(h.app.screenId, 'drafts');
    const view = h.view();
    assert.ok(view.includes('ひとつ目'));
    assert.ok(view.includes('ふたつ目'));
  });

  test('順番ではなく選んだものが出て行く', async () => {
    const h = withDrafts('ひとつ目', 'ふたつ目', 'みっつ目');
    h.press('p');
    h.press('\x1b[B', '\x1b[B');
    h.press('\r');
    await settle();

    assert.equal(h.claude.calls[0]?.prompt, 'みっつ目', '先頭ではなく選んだもの');
    assert.deepEqual(
      h.session.drafts.map((d) => d.text),
      ['ひとつ目', 'ふたつ目'],
      '送ったものだけ消える',
    );
  });

  test('送ると会話が開く', async () => {
    const h = withDrafts('やって');
    h.press('p', '\r');
    await settle();
    assert.equal(h.app.screenId, 'conversation');
  });

  test('実行中は送らない', async () => {
    const h = withDrafts('あとで');
    h.manager.forceState(h.session.id, 'working');

    h.press('p', '\r');
    await settle();

    assert.equal(h.claude.calls.length, 0);
    assert.equal(h.session.drafts.length, 1, '控えは残る');
    assert.ok(h.view().includes('実行中'));
  });

  test('d で消せる', () => {
    const h = withDrafts('いらない', 'のこす');
    h.press('p', 'd');

    assert.deepEqual(
      h.session.drafts.map((d) => d.text),
      ['のこす'],
    );
  });

  test('e で直せる', () => {
    const h = withDrafts('まちがい');
    h.press('p', 'e');
    assert.equal(h.app.screenId, 'draft');

    h.press('\x7f'.repeat(4), 'なおした', '\r');
    assert.equal(h.session.drafts[0]!.text, 'なおした');
  });

  test('全部消えたら一覧を閉じる', () => {
    const h = withDrafts('ひとつだけ');
    h.press('p', 'd');
    assert.equal(h.app.screenId, 'main');
  });

  test('控えが無いときの p は書く画面を開く', () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.press('p');
    assert.equal(h.app.screenId, 'draft');
  });
});

describe('勝手には送らない', () => {
  test('作業が終わっても自動では送らない', async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.manager.addDraft(session.id, '次はこれ');

    await h.manager.dispatch(session.id, '最初の指示');
    await settle();

    assert.deepEqual(
      h.claude.calls.map((c) => c.prompt),
      ['最初の指示'],
      '控えは出て行かない',
    );
    assert.equal(session.drafts.length, 1);
  });

  test('一覧で Enter を押しても送らない', async () => {
    // 会話を開くだけ。ここで送ると、別のことを頼みたいときに取り消せない。
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.manager.addDraft(session.id, '次はこれ');

    h.press('\r');
    await settle();

    assert.equal(h.app.screenId, 'conversation');
    assert.equal(h.claude.calls.length, 0);
    assert.equal(session.drafts.length, 1);
  });

  test('会話で空のまま Enter を押しても送らない', async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.manager.addDraft(session.id, '次はこれ');

    h.press('\r');
    h.press('\r');
    await settle();

    assert.equal(h.claude.calls.length, 0);
    assert.equal(session.drafts.length, 1);
  });

  test('別のことを打てばそちらが送られる', async () => {
    // 控えを用意したあとに、返答を見て別の指示を出す場面
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.manager.addDraft(session.id, '用意していた指示');

    h.press('\r');
    h.press('やっぱりこっちを先に', '\r');
    await settle();

    assert.equal(h.claude.calls[0]?.prompt, 'やっぱりこっちを先に');
    assert.equal(session.drafts.length, 1, '控えはそのまま残る');
  });

  test('会話中でも Alt+p で選んで送れる', async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.manager.addDraft(session.id, '控えの指示');

    h.press('\r');
    h.press('\x1bp');
    assert.equal(h.app.screenId, 'drafts');

    h.press('\r');
    await settle();
    assert.equal(h.claude.calls[0]?.prompt, '控えの指示');
  });
});
