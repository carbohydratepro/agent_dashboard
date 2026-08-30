/**
 * 通し確認。bootstrap から App まで、実際の起動と同じ組み立てで一周する。
 * ドライバだけモックに差し替える。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bootstrap } from '../src/core/bootstrap.ts';
import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { MockDriver, successfulTurn, deniedTurn } from '../src/core/drivers/mock.ts';
import { displayWidth } from '../src/tui/width.ts';

let home = '';

/** イベント処理が一巡するのを待つ */
const drain = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'vo-e2e-'));
});

afterEach(() => {
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
});

async function launch(driver?: MockDriver) {
  const claude = driver ?? new MockDriver({ kind: 'claude' });
  if (!driver) claude.setScenario(() => successfulTurn({ text: '直しました', files: ['a.ts'] }));

  const boot = await bootstrap({
    root: home,
    cwd: '/ws',
    drivers: { claude, codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
    skipVersionCheck: true,
  });
  const term = new FakeTerminal(100, 32);
  const app = new App({
    manager: boot.manager,
    terminal: term,
    animate: false,
    bell: false,
    defaultCwd: '/ws',
    loadHistory: (id) => boot.persistence.loadTasks(id, 20),
    warnings: boot.warnings,
    history: boot.history,
    availableKinds: boot.availableKinds,
  });
  app.start();

  return {
    boot,
    app,
    term,
    claude,
    press: (...raws: string[]) => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    },
    view: () => {
      app.render();
      return app.screen.toStrings().join('\n');
    },
    /**
     * 実行中のターンが閉じるまで待つ。
     * 固定の sleep だと、ロックのファイル I/O が挟まる分だけ足りなくなり、
     * 並列実行時に不安定になる。
     */
    finish: async (sessionId: string) => {
      await boot.manager.awaitTurn(sessionId);
      await drain();
    },
  };
}

// ---------------------------------------------------------------------------

describe('初回起動から一周', () => {
  test('追加 → 指示 → 完了 → 下書き → 次の指示', async () => {
    const h = await launch();

    // 何もない状態
    assert.ok(h.view().includes('空き'));

    // 追加
    h.press('n');
    assert.equal(h.app.screenId, 'hire');
    h.press('\r');
    assert.equal(h.boot.store.active().length, 1);
    const emp = h.boot.store.active()[0]!;

    // 会話モードで指示
    h.press('\r');
    assert.equal(h.app.screenId, 'conversation');
    h.press('認証まわりを直して');
    h.press('\r');
    await h.finish(emp.id);

    let text = h.view();
    assert.ok(text.includes('認証まわりを直して'));
    assert.ok(text.includes('直しました'));
    assert.equal(emp.stats.tasksCompleted, 1);

    // 下書きを書く
    h.press('\x1b');
    h.press('e', 'テストも書いて', '\r');
    assert.equal(emp.nextPrompt, 'テストも書いて');

    // オフィスの Enter でそのまま送る
    h.press('\r');
    await h.finish(emp.id);
    assert.equal(h.claude.calls[1]?.prompt, 'テストも書いて');
    assert.equal(emp.stats.tasksCompleted, 2);

    // 全部の画面を開いても落ちない
    for (const key of ['L', 'p', '$', ',', '?']) {
      h.press(key);
      assert.ok(h.view().length > 0);
      h.press('\x1b');
    }
  });

  test('保存されて、立ち上げ直すと戻る', async () => {
    const first = await launch();
    first.press('n', '\r');
    const emp = first.boot.store.active()[0]!;
    first.press('\r', 'やって', '\r');
    await first.finish(emp.id);
    first.press('\x1b');
    first.press('e', '次の作業', '\r');
    first.app.stop();
    first.boot.detachAutosave();

    const second = await launch();
    const restored = second.boot.store.active()[0]!;

    assert.equal(restored.id, emp.id);
    assert.equal(restored.name, emp.name);
    assert.equal(restored.nextPrompt, '次の作業');
    assert.equal(restored.stats.tasksCompleted, 1);
    assert.equal(restored.agentSessionId, emp.agentSessionId);

    // 下書きがあっても会話画面は開ける（直送は完了直後だけ）
    second.press('\r');
    assert.equal(second.app.screenId, 'conversation');
    assert.ok(second.view().includes('やって'), '前回の履歴が読み戻る');
  });

  test('承認待ちまで含めて一周する', async () => {
    const claude = new MockDriver({ kind: 'claude' });
    let turn = 0;
    claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn({ filePath: 'src/a.ts' }) : successfulTurn();
    });

    const h = await launch(claude);
    h.press('n', '\r');
    const emp = h.boot.store.active()[0]!;

    h.press('\r', 'やって', '\r');
    await h.finish(emp.id);

    assert.equal(emp.state, 'blocked');
    h.press('\x1b');
    assert.ok(h.view().includes('承認待ち 1 件'));

    h.press('\r');
    assert.equal(h.app.screenId, 'approval');
    assert.ok(h.view().includes('src/a.ts'));

    h.press('y');
    await drain();
    await h.finish(emp.id);
    assert.equal(emp.state, 'idle');
    assert.equal(emp.stats.approvalsGranted, 1);
  });
});

describe('画面の頑丈さ', () => {
  test('どの画面でも幅からはみ出さない', async () => {
    const h = await launch();
    h.press('n', '\r');
    const emp = h.boot.store.active()[0]!;
    h.press('\r', 'なにか長い指示'.repeat(20), '\r');
    await h.finish(emp.id);
    h.press('\x1b');

    for (const key of ['', 'L', 'p', '$', ',', '?', 'm', 'n']) {
      if (key) h.press(key);
      h.app.render();
      for (const row of h.app.screen.toStrings()) {
        assert.ok(displayWidth(row) <= 100, `${key || 'main'} ではみ出し: ${row}`);
      }
      h.press('\x1b');
    }
  });

  test('端末が小さいと警告だけ出す', async () => {
    const h = await launch();
    h.term.resize(70, 20);
    h.app.render();
    const text = h.app.screen.toStrings().join('\n');
    assert.ok(text.includes('画面が小さすぎます'));
  });

  test('大きくすれば戻る', async () => {
    const h = await launch();
    h.press('n', '\r');
    h.term.resize(70, 20);
    h.app.render();
    h.term.resize(140, 44);
    h.app.render();

    const text = h.app.screen.toStrings().join('\n');
    assert.equal(text.includes('画面が小さすぎます'), false, '警告が消える');
    assert.ok(text.includes('IDLE'), 'オフィスが描き直される');
    for (const row of h.app.screen.toStrings()) assert.ok(displayWidth(row) <= 140);
  });

  test('ドライバが無い種別は追加できない', async () => {
    const boot = await bootstrap({ root: home, drivers: {}, skipVersionCheck: true });
    const app = new App({
      manager: boot.manager,
      terminal: new FakeTerminal(100, 32),
      animate: false,
      availableKinds: boot.availableKinds,
    });
    app.start();

    for (const k of decodeKeys('n')) app.handleKey(k);
    app.render();
    assert.ok(app.screen.toStrings().join('\n').includes('見つかりません'));
  });

  test('ASCII モードでも一周できる', async () => {
    const boot = await bootstrap({
      root: home,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      skipVersionCheck: true,
    });
    const app = new App({
      manager: boot.manager,
      terminal: new FakeTerminal(100, 32),
      animate: true,
      ascii: true,
      availableKinds: boot.availableKinds,
    });
    app.start();
    boot.manager.createSession({ kind: 'claude' });
    app.render();

    const text = app.screen.toStrings().join('\n');
    assert.equal(/[▀▄]/.test(text), false, 'ブロック文字を使わない');
    assert.ok(text.includes('IDLE'));
  });
});
