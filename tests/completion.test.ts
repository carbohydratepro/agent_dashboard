/**
 * スラッシュコマンドの補完。
 * 候補は CLI が返した実物だけを使い、無ければ何も出さない。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCompletion,
  commandPrefix,
  completionFor,
  matchCommands,
  moveSelection,
} from '../src/tui/completion.ts';
import { parseProbeOutput } from '../src/core/usage.ts';
import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { UsageMonitor } from '../src/core/usage-monitor.ts';
import type { UsageSnapshot } from '../src/core/usage.ts';

const COMMANDS = ['compact', 'context', 'config', 'code-review', 'usage', 'doctor', 'color'];
const TERMINAL_ONLY = ['doctor', 'color'];
const source = { commands: COMMANDS, terminalOnly: TERMINAL_ONLY };

const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------

describe('どこで補完を出すか', () => {
  test('先頭のスラッシュだけを対象にする', () => {
    assert.equal(commandPrefix('/co', 3), 'co');
    assert.equal(commandPrefix('/', 1), '');
  });

  test('文中のスラッシュには反応しない', () => {
    assert.equal(commandPrefix('src/auth', 8), null);
    assert.equal(commandPrefix('見て /tmp を', 6), null);
  });

  test('引数を打ち始めたら引っ込む', () => {
    assert.equal(commandPrefix('/compact 古い会話を', 12), null);
  });

  test('2 行目以降は対象外', () => {
    assert.equal(commandPrefix('一行目\n/co', 10), null);
  });

  test('カーソルより後ろは見ない', () => {
    assert.equal(commandPrefix('/compact', 3), 'co', 'カーソル位置までで判断する');
  });
});

describe('候補の並び', () => {
  test('前方一致を先に、名前順で出す', () => {
    assert.deepEqual(matchCommands('co', source), ['code-review', 'compact', 'config', 'context']);
  });

  test('部分一致は後ろに回す', () => {
    const hits = matchCommands('act', source);
    assert.ok(hits.includes('compact'));
    assert.equal(hits[0], 'compact');
  });

  test('端末でしか動かないコマンドは出さない', () => {
    const hits = matchCommands('', source);
    assert.equal(hits.includes('doctor'), false);
    assert.equal(hits.includes('color'), false);
    assert.ok(hits.includes('compact'));
  });

  test('空なら全部（端末限定を除く）', () => {
    assert.equal(matchCommands('', source).length, COMMANDS.length - TERMINAL_ONLY.length);
  });
});

describe('補完の状態', () => {
  test('打った内容から候補を作る', () => {
    const state = completionFor('/co', 3, source)!;
    assert.equal(state.query, 'co');
    assert.equal(state.index, 0);
    assert.ok(state.candidates.length > 1);
  });

  test('一覧が無ければ出さない。作り話をしない。', () => {
    assert.equal(completionFor('/co', 3, { commands: [] }), null);
  });

  test('一致しなければ出さない', () => {
    assert.equal(completionFor('/zzz', 4, source), null);
  });

  test('打ち切っていれば出さない', () => {
    assert.equal(completionFor('/usage', 6, source), null, '確定済みに候補は不要');
  });

  test('選択は端で折り返す', () => {
    const state = completionFor('/co', 3, source)!;
    const n = state.candidates.length;
    assert.equal(moveSelection(state, -1).index, n - 1);
    assert.equal(moveSelection({ ...state, index: n - 1 }, 1).index, 0);
  });

  test('決定すると引数を書ける形になる', () => {
    const state = completionFor('/comp', 5, source)!;
    assert.equal(applyCompletion(state), '/compact ');
  });
});

describe('コマンド一覧の取得', () => {
  test('使用量と同じ出力から一覧を拾う', () => {
    const stdout = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        slash_commands: ['compact', 'context', 'doctor'],
        terminal_slash_commands: ['doctor'],
      }),
      JSON.stringify({ type: 'result', result: 'Current session: 10% used' }),
    ].join('\n');

    const out = parseProbeOutput(stdout);
    assert.deepEqual(out.slashCommands, ['compact', 'context', 'doctor']);
    assert.deepEqual(out.terminalOnly, ['doctor']);
    assert.match(out.text, /10% used/);
  });

  test('壊れた行があっても落ちない', () => {
    const out = parseProbeOutput('壊れた行\n{"type":"result","result":"ok"}');
    assert.equal(out.text, 'ok');
    assert.deepEqual(out.slashCommands, []);
  });
});

describe('画面での動き', () => {
  function harness(kind: 'claude' | 'codex' = 'claude', commands = COMMANDS) {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const claude = new MockDriver({ kind: 'claude' });
    claude.setScenario(() => successfulTurn());
    const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });
    codex.setScenario(() => successfulTurn());
    const manager = new SessionManager({
      store,
      drivers: { claude, codex },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });

    const snapshot: UsageSnapshot = {
      kind: 'claude',
      windows: [],
      planType: null,
      contextWindow: null,
      fetchedAt: 0,
      error: null,
      slashCommands: commands,
      terminalOnlyCommands: TERMINAL_ONLY,
    };
    const usage = new UsageMonitor({
      probes: [{ kind: 'claude', fetch: async () => snapshot }],
      store,
    });

    const term = new FakeTerminal(96, 30);
    const app = new App({ manager, terminal: term, animate: false, bell: false, usage });
    app.start();
    const session = manager.createSession({ kind });

    return {
      app,
      term,
      manager,
      session,
      claude,
      codex,
      usage,
      view: () => {
        app.render();
        return app.screen.toStrings().join('\n');
      },
    };
  }

  test('スラッシュを打つと候補が出る', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/co');

    const text = h.view();
    assert.ok(text.includes('/compact'));
    assert.ok(text.includes('/context'));
    assert.ok(text.includes('候補を選ぶ'), 'キーの案内が変わる');
  });

  test('端末でしか動かないコマンドは候補に出さない', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/do');
    assert.equal(h.view().includes('/doctor'), false);
  });

  test('Tab で選び Enter で確定する', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/comp');
    h.term.feed('\r');

    assert.ok(h.view().includes('/compact '), '確定して引数を書ける');
    assert.equal(h.view().includes('候補を選ぶ'), false, '候補は閉じる');
  });

  test('Esc は候補だけ閉じ、会話からは出ない', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/co');
    h.term.feed('\x1b');

    assert.equal(h.app.screenId, 'conversation', '会話は開いたまま');
    assert.equal(h.view().includes('/compact'), false, '候補は消える');
  });

  test('確定したコマンドはそのまま送れる', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/comp');
    h.term.feed('\r');
    h.term.feed('\r');
    await settle();

    assert.equal(h.claude.calls[0]?.prompt, '/compact');
  });

  test('普通の文章では候補を出さない', async () => {
    const h = harness();
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('src/auth を直して');
    assert.equal(h.view().includes('候補を選ぶ'), false);
  });

  test('一覧が取れていなければ何も出さない', () => {
    const h = harness('claude', []);
    h.term.feed('\r');
    h.term.feed('/co');
    assert.equal(h.view().includes('候補を選ぶ'), false);
  });

  test('codex には候補を出さず、送る前に知らせる', async () => {
    const h = harness('codex');
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/compact');
    assert.equal(h.view().includes('候補を選ぶ'), false, 'codex は解釈しないので出さない');

    h.term.feed('\r');
    await settle();
    assert.equal(h.codex.calls.length, 0, '黙って送らない');
    assert.ok(h.view().includes('解釈しません'));
  });
});
