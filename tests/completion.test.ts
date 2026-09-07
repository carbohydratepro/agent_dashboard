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
import { parseCommand, runLocalCommand } from '../src/core/local-commands.ts';
import type { Session } from '../src/core/types.ts';
import { ConversationState, drawConversation } from '../src/tui/views/conversation.ts';
import { Screen } from '../src/tui/screen.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
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

  test('codex にはダッシュボードが答えるぶんを出す', async () => {
    const h = harness('codex');
    await h.usage.refresh(undefined, { force: true });
    h.term.feed('\r');
    h.term.feed('/stat');

    assert.ok(h.view().includes('/status'), '候補が出る');
    assert.ok(h.view().includes('ダッシュボードが答えます'), '本体には渡らないと分かる');
  });

  test('codex の /status は CLI を呼ばずに答える', async () => {
    const h = harness('codex');
    h.term.feed('\r');
    h.term.feed('/status');
    h.term.feed('\r');
    await settle();

    assert.equal(h.codex.calls.length, 0, 'CLI を呼ばない＝枠を使わない');
    const view = h.view();
    assert.ok(view.includes('コンテキスト'), '状態が会話に出る');
  });

  test('codex の知らないコマンドは黙って送らない', async () => {
    const h = harness('codex');
    h.term.feed('\r');
    h.term.feed('/init');
    h.term.feed('\r');
    await settle();

    assert.equal(h.codex.calls.length, 0, '指示文として送ってしまわない');
    assert.ok(h.view().includes('解釈しません'));
  });
});

// ---------------------------------------------------------------------------

describe('codex では候補を出さない理由を書く', () => {
  function conversationScreen(kind: 'claude' | 'codex', input: string): string[] {
    const conv = new ConversationState();
    conv.input.value = input;
    conv.input.cursor = input.length;

    const screen = new Screen(90, 20, 'none');
    drawConversation(screen, {
      session: { name: `${kind}-1`, kind, state: 'idle', drafts: [], pendingApprovals: [] } as never,
      conversation: conv,
      theme: DEFAULT_THEME,
      now: 0,
      completion: null,
      completionNote:
        kind === 'codex' && input.startsWith('/')
          ? 'codex は指示文としてそのまま送ります（codex exec はスラッシュコマンドを解釈しません）'
          : null,
    });
    return screen.toStrings();
  }

  test('スラッシュを打つと理由が出る', () => {
    const rows = conversationScreen('codex', '/st');
    assert.ok(
      rows.some((r) => r.includes('そのまま送ります')),
      '候補が空でも、なぜ空なのかが分かる',
    );
  });

  test('普通の入力では出さない', () => {
    const rows = conversationScreen('codex', 'テストして');
    assert.equal(
      rows.some((r) => r.includes('そのまま送ります')),
      false,
    );
  });

  test('入力欄は理由に潰されない', () => {
    const rows = conversationScreen('codex', '/st');
    assert.ok(rows.some((r) => r.includes('/st')), '打った文字が見えている');
  });
});

// ---------------------------------------------------------------------------

describe('ダッシュボードが答えるコマンド', () => {
  function fakeSession(over: Partial<Session> = {}): Session {
    return {
      name: 'codex-1',
      kind: 'codex',
      state: 'idle',
      model: null,
      agentSessionId: 'thread-1',
      context: { usedTokens: 40_000, windowTokens: 200_000, ratio: 0.2, estimated: true },
      stats: {
        tasksCompleted: 3,
        tasksFailed: 0,
        tasksInterrupted: 1,
        filesEdited: 5,
        commandsRun: 12,
        totalTokensIn: 30_000,
        totalTokensOut: 10_000,
      },
      workspace: { actualCwd: '/ws', requestedCwd: '/ws', isolation: 'none', branch: null, sandbox: 'workspace-write' },
      ...over,
    } as unknown as Session;
  }

  test('/status は状態を返す', () => {
    const r = runLocalCommand('/status', { session: fakeSession() });
    assert.equal(r.kind, 'answer');
    assert.match(r.text, /codex-1/);
    assert.match(r.text, /コンテキスト\s+20%/);
    assert.match(r.text, /編集 5 ファイル/);
  });

  test('/status は残量が取れていれば添える', () => {
    const r = runLocalCommand('/status', {
      session: fakeSession(),
      usageLine: '5時間 82% 残',
    });
    assert.equal(r.kind, 'answer');
    assert.match(r.text, /82% 残/);
  });

  test('/model は引数が無ければ今の値を返す', () => {
    const r = runLocalCommand('/model', { session: fakeSession() });
    assert.equal(r.kind, 'answer');
    assert.match(r.text, /CLI の既定/);
  });

  test('/model <名前> で切り替える', () => {
    const r = runLocalCommand('/model gpt-5-codex', { session: fakeSession() });
    assert.equal(r.kind, 'changed');
    assert.equal(r.model, 'gpt-5-codex');
  });

  test('/sandbox は codex の制約を書く', () => {
    const r = runLocalCommand('/sandbox', { session: fakeSession() });
    assert.equal(r.kind, 'answer');
    assert.match(r.text, /workspace-write/);
    assert.match(r.text, /途中でサンドボックスを変えられません/);
  });

  test('/compact はアプリ側の操作になる', () => {
    const r = runLocalCommand('/compact', { session: fakeSession() });
    assert.deepEqual(r, { kind: 'action', action: 'compact' });
  });

  test('claude では本体に譲る', () => {
    // 本体の /compact は本物の圧縮、/status は内部状態。こちらが横取りしない。
    for (const cmd of ['/status', '/compact', '/model opus']) {
      const r = runLocalCommand(cmd, { session: fakeSession({ kind: 'claude' }) });
      assert.equal(r.kind, 'passthrough', cmd);
    }
  });

  test('知らないコマンドは渡す', () => {
    assert.equal(runLocalCommand('/init', { session: fakeSession() }).kind, 'passthrough');
    assert.equal(runLocalCommand('普通の指示', { session: fakeSession() }).kind, 'passthrough');
  });

  test('コマンド名と引数を割る', () => {
    assert.deepEqual(parseCommand('/model gpt-5 codex'), { name: 'model', rest: 'gpt-5 codex' });
    assert.deepEqual(parseCommand('/status'), { name: 'status', rest: '' });
    assert.equal(parseCommand('これは違う'), null);
  });
});
