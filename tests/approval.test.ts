/** 承認待ちフロー（SPEC §8.4）。差分の見せ方と、承認・却下の一周。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn, deniedTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { approvalTarget, collapseContext, diffLines, lineDiff } from '../src/tui/views/approval.ts';
import { displayWidth } from '../src/tui/width.ts';
import type { AgentEvent } from '../src/core/types.ts';

const settle = () => new Promise((r) => setTimeout(r, 20));

function harness() {
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  const manager = new SessionManager({
    store,
    drivers: { claude },
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
    term,
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

describe('差分の組み立て', () => {
  test('追加された行だけが + になる', () => {
    const d = lineDiff(['a', 'b'], ['a', 'b', 'c']);
    assert.deepEqual(d, [
      { text: 'a', kind: 'context' },
      { text: 'b', kind: 'context' },
      { text: 'c', kind: 'add' },
    ]);
  });

  test('同じ行が複数あっても並びが壊れない', () => {
    // 集合で比較すると順序が崩れるケース
    const d = lineDiff(['x', 'a', 'x'], ['x', 'b', 'x']);
    assert.deepEqual(d.map((l) => `${l.kind[0]}${l.text}`), ['cx', 'ra', 'ab', 'cx']);
  });

  test('置き換えは削除と追加になる', () => {
    const d = lineDiff(['old'], ['new']);
    assert.deepEqual(d.map((l) => l.kind), ['remove', 'add']);
  });

  test('大きすぎる差分は計算せず丸ごと見せる', () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const d = lineDiff(big, big);
    assert.equal(d.every((l) => l.kind !== 'context'), true, '諦めて全消し全足しにする');
  });

  test('変わらない行が続くところを畳む', () => {
    const lines = [
      ...Array.from({ length: 20 }, (_, i) => ({ text: `c${i}`, kind: 'context' as const })),
      { text: 'changed', kind: 'add' as const },
    ];
    const collapsed = collapseContext(lines);
    assert.ok(collapsed.length < lines.length);
    assert.ok(collapsed.some((l) => l.text.includes('行省略')));
    assert.ok(collapsed.some((l) => l.text === 'changed'));
  });

  test('Edit の引数から差分を作る', () => {
    const d = diffLines({
      file_path: 'a.ts',
      old_string: 'export function add(a, b) {\n  return a + b;\n}\n',
      new_string: 'export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n',
    });
    const added = d.filter((l) => l.kind === 'add').map((l) => l.text);
    assert.ok(added.some((t) => t.includes('sub')));
    assert.equal(d.some((l) => l.kind === 'remove'), false, '追記なので削除は無い');
  });

  test('Write は全部追加として見せる', () => {
    const d = diffLines({ file_path: 'new.ts', content: 'line1\nline2' });
    assert.deepEqual(d.map((l) => l.kind), ['add', 'add']);
  });

  test('差分の作れない引数では空になる', () => {
    assert.deepEqual(diffLines({ command: 'rm -rf /' }), []);
  });

  test('対象を 1 行で表す', () => {
    const base = { id: 'a', toolUseId: 't', message: '', requestedAt: 0, taskId: 'x' };
    assert.equal(approvalTarget({ ...base, toolName: 'Edit', toolInput: { file_path: 'a.ts' } }), 'a.ts');
    assert.equal(approvalTarget({ ...base, toolName: 'Bash', toolInput: { command: 'npm i' } }), 'npm i');
    assert.equal(approvalTarget({ ...base, toolName: 'X', toolInput: {} }), '');
  });
});

describe('承認待ち画面', () => {
  test('何をしようとしたかが差分まで見える', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() => deniedTurn({ filePath: 'src/auth/session.ts' }));
    await h.manager.dispatch(emp.id, 'sub を追加して');

    h.press('\r');
    const text = h.view();

    assert.ok(text.includes('承認待ち'));
    assert.ok(text.includes('種別: Edit'));
    assert.ok(text.includes('src/auth/session.ts'));
    assert.ok(text.includes('- a'), '消える行');
    assert.ok(text.includes('+ b'), '足される行');
    assert.ok(text.includes('[y] 承認'));
  });

  test('Bash は差分の代わりに引数を出す', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      {
        t: 'permission_denied',
        toolName: 'Bash',
        toolUseId: 'tu1',
        toolInput: { command: 'rm -rf build', description: 'ビルド成果物を消す' },
        message: 'コマンドの実行が許可されていません',
      },
      { t: 'turn_end', ok: true, result: '' },
    ]);
    await h.manager.dispatch(emp.id, '掃除して');

    h.press('\r');
    const text = h.view();
    assert.ok(text.includes('種別: Bash'));
    assert.ok(text.includes('rm -rf build'));
  });

  test('複数件を j / k で送れる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      {
        t: 'permission_denied',
        toolName: 'Edit',
        toolUseId: '1',
        toolInput: { file_path: 'one.ts', old_string: 'a', new_string: 'b' },
        message: '',
      },
      {
        t: 'permission_denied',
        toolName: 'Write',
        toolUseId: '2',
        toolInput: { file_path: 'two.ts', content: 'x' },
        message: '',
      },
      { t: 'turn_end', ok: true, result: '' },
    ]);
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r');
    assert.ok(h.view().includes('(1/2)'));
    assert.ok(h.view().includes('one.ts'));

    h.press('j');
    assert.ok(h.view().includes('(2/2)'));
    assert.ok(h.view().includes('two.ts'));

    h.press('k');
    assert.ok(h.view().includes('one.ts'));
  });

  test('画面幅に収まる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario((): AgentEvent[] => [
      {
        t: 'permission_denied',
        toolName: 'Edit',
        toolUseId: '1',
        toolInput: {
          file_path: '/very/long/path/'.repeat(10) + 'file.ts',
          old_string: 'あ'.repeat(300),
          new_string: 'い'.repeat(300),
        },
        message: 'とても長い理由。'.repeat(20),
      },
      { t: 'turn_end', ok: true, result: '' },
    ]);
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r');
    h.app.render();
    for (const row of h.app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
    }
  });
});

describe('承認と却下の一周', () => {
  test('y で承認すると allowedTools 付きで再実行される', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn() : successfulTurn({ files: ['src/auth/session.ts'] });
    });
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r', 'y');
    await settle();

    assert.equal(emp.state, 'idle');
    assert.equal(emp.pendingApprovals.length, 0);
    assert.deepEqual(h.claude.calls[1]!.allowedTools, ['Edit']);
    assert.equal(emp.stats.approvalsGranted, 1);
    assert.equal(h.app.screenId, 'main');
  });

  test('n で理由を書いて却下すると、それが次の指示になる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn() : successfulTurn();
    });
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r', 'n');
    assert.ok(h.view().includes('却下の理由'));
    h.press('その修正は不要。テストだけ書いて。', '\r');
    await settle();

    assert.equal(h.claude.calls[1]!.prompt, 'その修正は不要。テストだけ書いて。');
    assert.equal(emp.stats.approvalsGranted, 0);
  });

  test('理由なしで却下すると idle に戻るだけ', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() => deniedTurn());
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r', 'n', '\r');
    await settle();

    assert.equal(emp.state, 'idle');
    assert.equal(h.claude.calls.length, 1, '追加の指示は出していない');
  });

  test('a で常時承認にすると以降のターンにも効く', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn({ toolName: 'Edit' }) : successfulTurn();
    });
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r', 'a');
    await settle();
    await h.manager.dispatch(emp.id, '次の指示');

    assert.ok(h.claude.calls[2]!.allowedTools.includes('Edit'), '次のターンにも自動で付く');
  });

  test('Esc なら保留してオフィスに戻る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() => deniedTurn());
    await h.manager.dispatch(emp.id, 'やって');

    h.press('\r', '\x1b');
    assert.equal(h.app.screenId, 'main');
    assert.equal(emp.pendingApprovals.length, 1, '承認待ちは残ったまま');
    assert.equal(emp.state, 'blocked');
    assert.ok(h.view().includes('承認待ち 1 件'), '席と詳細に残る');
  });

  test('承認待ちはセッションの失敗として数えない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() => deniedTurn());
    await h.manager.dispatch(emp.id, 'やって');

    assert.equal(emp.stats.tasksFailed, 0);
    assert.equal(emp.stats.approvalsRequested, 1);
  });
});
