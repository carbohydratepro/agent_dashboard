/**
 * 日本語入力まわり。
 * IME の確定文字列、マルチバイトの分割、エスケープ列の分割を扱えること。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { KeyDecoder, PASTE_END, PASTE_START, decodeKeys, isPrintable } from '../src/tui/input.ts';
import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { displayWidth, dropWidth, scrollOffsetFor } from '../src/tui/width.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness() {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  claude.setScenario(() => successfulTurn());
  const manager = new SessionManager({
    store,
    drivers: { claude },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
  });
  const term = new FakeTerminal(100, 32);
  const app = new App({ manager, terminal: term, animate: false, bell: false });
  app.start();
  return {
    app,
    manager,
    claude,
    term,
    view: () => {
      app.render();
      return app.screen.toStrings().join('\n');
    },
  };
}

// ---------------------------------------------------------------------------

describe('マルチバイトの分割', () => {
  test('1 文字がチャンクの境目で割れても壊れない', () => {
    const bytes = Buffer.from('あ', 'utf8');
    assert.equal(bytes.length, 3, '前提: 3 バイト');

    const d = new KeyDecoder();
    const first = d.write(bytes.subarray(0, 2));
    assert.deepEqual(first, [], 'まだ文字にならない');

    const second = d.write(bytes.subarray(2));
    assert.equal(second.length, 1);
    assert.equal(second[0]!.ch, 'あ');
  });

  test('文中で何度割れても復元できる', () => {
    const text = 'こんにちは、世界';
    const bytes = Buffer.from(text, 'utf8');
    const d = new KeyDecoder();
    const keys = [];
    for (let i = 0; i < bytes.length; i += 1) {
      keys.push(...d.write(bytes.subarray(i, i + 1)));
    }
    keys.push(...d.flush());
    assert.equal(keys.map((k) => k.ch).join(''), text);
  });

  test('サロゲートペアも割らない', () => {
    const bytes = Buffer.from('𠮷野家', 'utf8');
    const d = new KeyDecoder();
    const keys = [];
    for (let i = 0; i < bytes.length; i += 2) {
      keys.push(...d.write(bytes.subarray(i, i + 2)));
    }
    keys.push(...d.flush());
    assert.equal(keys.map((k) => k.ch).join(''), '𠮷野家');
  });
});

describe('エスケープ列の分割', () => {
  test('矢印キーが割れて届いても 1 キーになる', () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.write('\x1b'), [], '続きを待つ');
    assert.deepEqual(d.write('['), []);
    const keys = d.write('A');
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'up');
  });

  test('待っている間は Esc として誤爆しない', () => {
    const d = new KeyDecoder();
    d.write('\x1b[');
    assert.equal(d.hasPending, true);
    // ここで flush されなければ Esc にはならない
    assert.deepEqual(d.write('D').map((k) => k.name), ['left']);
  });

  test('単独の ESC は確定時に Esc になる', () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.write('\x1b'), []);
    const keys = d.flush();
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'escape');
  });

  test('ESC のあとに文字が続けば Alt 扱い', () => {
    assert.equal(decodeKeys('\x1bm')[0]!.alt, true);
  });
});

describe('ブラケットペースト（IME の確定文字列）', () => {
  test('囲まれた中身は 1 つのペーストになる', () => {
    const keys = decodeKeys(`${PASTE_START}こんにちは${PASTE_END}`);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'paste');
    assert.equal(keys[0]!.ch, 'こんにちは');
    assert.equal(isPrintable(keys[0]!), true);
  });

  test('中身は解釈しない。改行もタブもそのまま', () => {
    const keys = decodeKeys(`${PASTE_START}a\rb\tc${PASTE_END}`);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.ch, 'a\rb\tc', 'Enter や Tab として解釈しない');
  });

  test('中身にエスケープ列が入っていても文字のまま', () => {
    const keys = decodeKeys(`${PASTE_START}\x1b[Aだけ${PASTE_END}`);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.name, 'paste');
    assert.ok(keys[0]!.ch.includes('だけ'));
  });

  test('ペーストがチャンクをまたいでも 1 つにまとまる', () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.write(PASTE_START), []);
    assert.deepEqual(d.write('日本語の'), []);
    assert.deepEqual(d.write('長い文章'), []);
    const keys = d.write(PASTE_END);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.ch, '日本語の長い文章');
  });

  test('開始マーカーが割れても取りこぼさない', () => {
    const d = new KeyDecoder();
    d.write('\x1b[20');
    d.write('0~あ');
    const keys = d.write(PASTE_END);
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.ch, 'あ');
  });

  test('終了マーカーが割れても取りこぼさない', () => {
    const d = new KeyDecoder();
    d.write(`${PASTE_START}テスト\x1b[201`);
    const keys = d.write('~');
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.ch, 'テスト');
  });

  test('終端が来ないまま切れても、入力を捨てない', () => {
    const d = new KeyDecoder();
    d.write(`${PASTE_START}途中まで`);
    const keys = d.flush();
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.ch, '途中まで');
  });
});

describe('入力欄の横スクロール', () => {
  test('カーソルが右端を越えたぶんだけ流す', () => {
    assert.equal(scrollOffsetFor(10, 40), 0, '収まっていれば流さない');
    assert.equal(scrollOffsetFor(40, 40), 1);
    assert.equal(scrollOffsetFor(60, 40), 21);
  });

  test('表示幅で切るので全角の途中で割れない', () => {
    assert.equal(dropWidth('あいうえお', 4), 'うえお');
    assert.equal(dropWidth('あいうえお', 3), 'うえお', '全角の途中なら次の文字から');
    assert.equal(dropWidth('abc', 1), 'bc');
    assert.equal(dropWidth('あいう', 0), 'あいう');
  });
});

describe('画面の中の日本語入力', () => {
  test('日本語を打つと入力欄に出る', async () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');
    h.term.feed('認証まわりを直して');

    assert.equal(h.app.screenId, 'conversation');
    assert.ok(h.view().includes('認証まわりを直して'));
  });

  test('IME の確定文字列がショートカットとして誤爆しない', () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');

    // 'm' や 'q' で始まる確定文字列を貼り付けても画面が飛ばない
    h.term.feed(`${PASTE_START}mqn を含む文${PASTE_END}`);

    assert.equal(h.app.screenId, 'conversation');
    assert.ok(h.view().includes('mqn を含む文'));
  });

  test('バイト列が割れて届いても文字が化けない', () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');

    const bytes = Buffer.from('分割されたバイト列', 'utf8');
    for (let i = 0; i < bytes.length; i += 2) {
      h.term.feed(bytes.subarray(i, i + 2));
    }

    const text = h.view();
    assert.ok(text.includes('分割されたバイト列'), text);
    assert.equal(text.includes('�'), false, '置換文字が出ていない');
  });

  test('長い日本語を打っても入力が見えなくならない', () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');
    h.term.feed('あ'.repeat(120));

    const rows = h.app.screen.toStrings();
    h.app.render();
    const text = h.app.screen.toStrings().join('\n');

    assert.ok(text.includes('‹'), '横に流れていることが分かる印が出る');
    assert.ok(text.includes('▏'), 'カーソルが見えている');
    for (const row of h.app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
    }
    assert.equal(rows.length > 0, true);
  });

  test('打った日本語をそのまま送れる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');
    h.term.feed('テストを追加してください');
    h.term.feed('\r');
    await settle();

    assert.equal(h.claude.calls[0]?.prompt, 'テストを追加してください');
  });

  test('日本語で下書きを書ける', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.term.feed('e');
    h.term.feed('次はドキュメントを更新する');
    h.term.feed('\r');

    assert.equal(emp.nextPrompt, '次はドキュメントを更新する');
  });

  test('日本語の下書きが長くても編集できる', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.term.feed('e');
    h.term.feed('長い下書き'.repeat(30));
    h.app.render();

    const text = h.app.screen.toStrings().join('\n');
    assert.ok(text.includes('‹'));
    assert.ok(text.includes('▏'));
    h.term.feed('\r');
    assert.equal(emp.nextPrompt, '長い下書き'.repeat(30));
  });

  test('追加ダイアログのパスにも日本語を入れられる', () => {
    const h = harness();
    h.term.feed('n');
    // 追加方法 → AI 種別 → 得意分野 → 作業ディレクトリ
    h.term.feed('\x1b[B\x1b[B\x1b[B');
    h.term.feed('/home/ユーザー/プロジェクト');
    h.app.render();
    assert.ok(h.app.screen.toStrings().join('\n').includes('プロジェクト'));
  });
});

describe('改行（端末に奪われないキー）', () => {
  function conversation() {
    const h = harness();
    h.manager.createSession({ kind: 'claude' });
    h.term.feed('\r');
    return h;
  }

  for (const [label, raw] of [
    ['Ctrl+J', '\n'],
    ['Alt+Enter', '\x1b\r'],
    ['Shift+Enter (CSI-u)', '\x1b[13;2u'],
    ['Shift+Enter (xterm)', '\x1b[27;2;13~'],
  ] as const) {
    test(`${label} で改行できる`, async () => {
      const h = conversation();
      h.term.feed('一行目');
      h.term.feed(raw);
      h.term.feed('二行目');

      const text = h.view();
      assert.ok(text.includes('一行目'), label);
      assert.ok(text.includes('二行目'), `${label} で改行後も打てる`);
      assert.equal(h.app.screenId, 'conversation', `${label} で画面が飛ばない`);

      // 送るとまとめて 1 つのプロンプトになる
      h.term.feed('\r');
      await settle();
      assert.equal(h.claude.calls[0]?.prompt, '一行目\n二行目');
    });
  }

  test('Enter は改行せずに送る', async () => {
    const h = conversation();
    h.term.feed('一行だけ');
    h.term.feed('\r');
    await settle();
    assert.equal(h.claude.calls[0]?.prompt, '一行だけ');
  });

  test('下書きでも同じキーで改行できる', () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });
    h.term.feed('e');
    h.term.feed('上');
    h.term.feed('\n');
    h.term.feed('下');
    h.term.feed('\r');
    assert.equal(session.nextPrompt, '上\n下');
  });

  test('日本語でも改行できる', async () => {
    const h = conversation();
    h.term.feed('認証を直して');
    h.term.feed('\n');
    h.term.feed('テストも追加して');
    h.term.feed('\r');
    await settle();
    assert.equal(h.claude.calls[0]?.prompt, '認証を直して\nテストも追加して');
  });
});
