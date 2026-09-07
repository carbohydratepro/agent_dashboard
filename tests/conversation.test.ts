/** 会話モード（SPEC §15.3）。4 種類のテキストが混ざらないことを中心に見る。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn, delegatingTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import {
  ConversationState,
  drawConversation,
  scrollStep,
  layoutEntries,
  lineText,
  MAX_ENTRIES,
} from '../src/tui/views/conversation.ts';
import { Screen } from '../src/tui/screen.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
import { displayWidth } from '../src/tui/width.ts';

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

const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------

describe('履歴の組み立て', () => {
  test('AI の発話は連続した text をまとめる', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: 'あい' });
    conv.applyEvent({ t: 'text', delta: 'うえお' });
    assert.equal(conv.entries.length, 1);
    assert.deepEqual(conv.entries[0], { t: 'assistant', text: 'あいうえお' });
  });

  test('ツールを挟むと発話が切れる', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: '調べます' });
    conv.applyEvent({ t: 'tool_start', name: 'Read', detail: 'a.ts', toolUseId: '1' });
    conv.applyEvent({ t: 'text', delta: '分かりました' });
    assert.deepEqual(conv.entries.map((e) => e.t), ['assistant', 'tool', 'assistant']);
  });

  test('ツールの成否が後から入る', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'tool_start', name: 'Bash', detail: 'npm test', toolUseId: '1' });
    conv.applyEvent({ t: 'tool_end', name: 'Bash', ok: false, toolUseId: '1' });
    const tool = conv.entries[0]!;
    assert.equal(tool.t === 'tool' && tool.ok, false);
  });

  test('サブエージェントの発話は親の id で振り分ける', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: '上司の発話' });
    conv.applyEvent({ t: 'text', delta: 'サブエージェントの発話', parentToolUseId: 'p1' });
    assert.deepEqual(conv.entries.map((e) => e.t), ['assistant', 'subagent']);
  });

  test('上限を超えたら古いものから捨てる', () => {
    const conv = new ConversationState();
    for (let i = 0; i < MAX_ENTRIES + 50; i += 1) conv.pushSystem(`line ${i}`);
    assert.equal(conv.entries.length, MAX_ENTRIES);
    const first = conv.entries[0]!;
    assert.ok(first.t === 'system' && first.text.includes('50'));
  });

  test('進行中のタスクから組み立て直せる', () => {
    const conv = new ConversationState();
    conv.seedFromTask({
      id: 't1',
      sessionId: 'e1',
      prompt: '認証を直して',
      startedAt: 0,
      endedAt: null,
      status: 'running',
      events: [
        { t: 'tool_start', name: 'Edit', detail: 'a.ts', toolUseId: '1' },
        { t: 'text', delta: '直しました' },
      ],
      summary: null,
      recoveredFrom: null,
    });
    assert.deepEqual(conv.entries.map((e) => e.t), ['user', 'tool', 'assistant']);
  });
});

describe('描画の区別（SPEC §15.3）', () => {
  const theme = DEFAULT_THEME;

  test('4 種類が別々の見た目になる', () => {
    const conv = new ConversationState();
    conv.pushUser('やって');
    conv.applyEvent({ t: 'text', delta: '完了しました' });
    conv.applyEvent({ t: 'tool_start', name: 'Edit', detail: 'a.ts', toolUseId: '1' });
    conv.applyEvent({ t: 'text', delta: 'サブの出力', parentToolUseId: 'p' });
    conv.pushSystem('中断');

    const lines = layoutEntries(conv.entries, 80, theme, true);
    const assistant = lines.find((l) => lineText(l).includes('完了しました'))!;
    const sub = lines.find((l) => lineText(l).includes('サブの出力'))!;
    const system = lines.find((l) => lineText(l).includes('中断'))!;


    assert.equal(assistant.boxed, true, 'モデルの出力は枠で囲む');

    assert.ok(sub.indent > assistant.indent, 'サブエージェントはさらにインデントする');
    assert.ok(lineText(system).startsWith('─'), 'システムは区切り線');
  });

  test('モデルの出力は原文のまま', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: 'UTC を仮定していたため誤判定していました。' });
    const lines = layoutEntries(conv.entries, 80, theme, true);
    const joined = lines.filter((l) => l.boxed).map((l) => lineText(l)).join('');
    assert.equal(joined, 'UTC を仮定していたため誤判定していました。');
  });

  test('Tab でサブエージェントの行を隠せる', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: 'サブの出力', parentToolUseId: 'p' });
    assert.equal(layoutEntries(conv.entries, 80, theme, true).length, 1);
    assert.equal(layoutEntries(conv.entries, 80, theme, false).length, 0);
  });

  test('折り返しても画面幅に収まる', () => {
    const conv = new ConversationState();
    conv.applyEvent({ t: 'text', delta: 'あ'.repeat(200) });
    for (const line of layoutEntries(conv.entries, 60, theme, true)) {
      assert.ok(displayWidth(lineText(line)) <= 60);
    }
  });
});

describe('画面としての会話', () => {
  test('指示を出すと履歴に user と演出と実出力が並ぶ', async () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude', name: 'ミナ' });
    h.claude.setScenario(() => successfulTurn({ text: '直しました' }));

    h.press('\r');
    h.press('認証を直して');
    h.press('\r');
    await settle();

    const text = h.view();
    assert.ok(text.includes('> 認証を直して'), 'ユーザーの指示');
        assert.ok(text.includes('直しました'), 'モデルの出力');
  });

  test('会話画面を開いていなくても履歴は溜まる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'オフィスから出した指示');
    await settle();

    h.press('\r');
    assert.ok(h.view().includes('オフィスから出した指示'));
  });

  test('中断すると区切りが入る', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(emp.id, '長い作業');
    await settle();

    h.manager.interrupt(emp.id, 'user');
    await running;

    h.press('\r');
    assert.ok(h.view().includes('中断しました'));
  });

  test('ネットワーク中断は別の文言になる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setHangAfter(2);
    const running = h.manager.dispatch(emp.id, '長い作業');
    await settle();

    h.manager.interrupt(emp.id, 'network');
    await running;

    h.press('\r');
    assert.ok(h.view().includes('ネットワーク切替により中断'));
  });

  test('サブエージェントの作業がぶら下がる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() =>
      delegatingTurn([{ taskId: 'a1', type: 'Explore', description: '認証まわりを調査' }]),
    );
    await h.manager.dispatch(emp.id, '調べて');
    await settle();

    h.press('\r');
    const text = h.view();
    assert.ok(text.includes('Agent'), 'サブエージェントを使ったことが分かる');
    assert.ok(text.includes('認証まわりを調査'));
  });

  test('全ての行が画面幅に収まる', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    h.claude.setScenario(() =>
      successfulTurn({ text: 'とても長い応答です。'.repeat(30), files: ['src/very/long/path/to/file.ts'] }),
    );
    await h.manager.dispatch(emp.id, 'あ'.repeat(120));
    await settle();

    h.press('\r');
    h.app.render();
    for (const row of h.app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
    }
  });

  test('スクロールしても落ちない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    for (let i = 0; i < 5; i += 1) await h.manager.dispatch(emp.id, `指示 ${i}`);
    await settle();

    h.press('\r');
    h.press('\x1b[5~', '\x1b[5~', '\x1b[5~');
    assert.ok(h.view().length > 0);
    h.press('\x1b[6~', '\x1b[6~', '\x1b[6~', '\x1b[6~');
    assert.ok(h.view().includes('指示 4'), '最下部に戻る');
  });
});

// ---------------------------------------------------------------------------

describe('自分の指示と回答を色で分ける', () => {
  function layout(build: (c: ConversationState) => void) {
    const conv = new ConversationState();
    build(conv);
    return layoutEntries(conv.entries, 60, DEFAULT_THEME, true);
  }

  test('自分の指示は黄緑、回答は本文色', () => {
    const lines = layout((c) => {
      c.pushUser('テストを走らせて');
      c.applyEvent({ t: 'text', delta: '走らせました。' });
    });

    const mine = lines.find((l) => lineText(l).includes('テストを走らせて'));
    const reply = lines.find((l) => lineText(l).includes('走らせました'));

    assert.equal(mine?.spans[0]?.style.fg, DEFAULT_THEME.userText);
    assert.notEqual(reply?.spans[0]?.style.fg, DEFAULT_THEME.userText);
  });

  test('折り返しても全部の行が黄緑のまま', () => {
    const lines = layout((c) => c.pushUser('あ'.repeat(120)));
    const mine = lines.filter((l) => lineText(l).includes('あ'));

    assert.ok(mine.length > 1, '折り返っている');
    for (const line of mine) {
      for (const span of line.spans) {
        assert.equal(span.style.fg, DEFAULT_THEME.userText);
      }
    }
  });

  test('回答のマークダウンは黄緑を使わない', () => {
    // 見出しや強調に別の色を当てているので、そこと衝突していないか
    const lines = layout((c) =>
      c.applyEvent({ t: 'text', delta: '# 見出し\n\n**強調**と`コード`。\n\n- 箇条書き' }),
    );
    for (const line of lines) {
      for (const span of line.spans) {
        assert.notEqual(span.style.fg, DEFAULT_THEME.userText, lineText(line));
      }
    }
  });

  test('入力中の文字も黄緑で出る', () => {
    const conv = new ConversationState();
    conv.input.value = 'これから書く指示';
    conv.input.cursor = conv.input.value.length;

    const screen = new Screen(60, 16, 'none');
    drawConversation(screen, {
      session: { name: 'claude-1', state: 'idle', drafts: [], pendingApprovals: [] } as never,
      conversation: conv,
      theme: DEFAULT_THEME,
      now: 0,
    });

    const rows = screen.toStrings();
    const y = rows.findIndex((r) => r.includes('これから書く指示'));
    assert.ok(y >= 0, '入力欄に出ている');
    assert.equal(screen.get(rows[y]!.indexOf('これ'), y).fg, DEFAULT_THEME.userText);
  });
});

// ---------------------------------------------------------------------------

describe('動いていることが分かる', () => {
  /** 実行中の会話画面を 1 枚描く */
  function drawBusy(
    over: { state?: string; events?: unknown[]; now?: number; frame?: number } = {},
  ): string[] {
    const screen = new Screen(90, 20, 'none');
    drawConversation(screen, {
      session: {
        name: 'claude-1',
        kind: 'claude',
        state: over.state ?? 'thinking',
        drafts: [],
        pendingApprovals: [],
        currentTask: { id: 't1', startedAt: 0, events: over.events ?? [] },
      } as never,
      conversation: new ConversationState(),
      theme: DEFAULT_THEME,
      now: over.now ?? 5_000,
      frame: over.frame ?? 0,
      animate: true,
    });
    return screen.toStrings();
  }

  /** 動いている印の行。ヘッダの状態表示ともキーバーとも区別する。 */
  const statusRow = (rows: string[]): string =>
    rows.find((r) => r.includes('Ctrl+C で中断')) ?? '';

  test('送った直後から動いている印が出る', async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude', name: 'claude-1' });
    h.press('\r');
    h.press('テストして', '\r');
    h.manager.forceState(session.id, 'thinking');

    const view = h.view();
    assert.ok(view.includes('テストして'), '打った指示がすぐ見える');
    assert.ok(view.includes('思考中'), '状態が出ている');

    await settle();
  });

  test('止まっている間は印を出さない', async () => {
    const h = harness();
    h.manager.createSession({ kind: 'claude', name: 'claude-1' });
    h.press('\r');
    h.press('テストして', '\r');
    await settle();

    // 応答が終われば消える。残ると、動いていないのに動いて見える。
    assert.equal(statusRow(h.view().split('\n')), '');
  });

  test('止め方が分かる', () => {
    assert.match(statusRow(drawBusy()), /Ctrl\+C で中断/);
  });

  test('実行中のツールが出る', () => {
    const rows = drawBusy({
      state: 'working',
      events: [
        { t: 'tool_start', name: 'Read', detail: 'a.ts', toolUseId: '1' },
        { t: 'tool_start', name: 'Bash', detail: 'npm test', toolUseId: '2' },
      ],
    });
    assert.match(statusRow(rows), /npm test/, '最後に始めたものが分かる');
  });

  test('まだ何もしていなければ何も書かない', () => {
    // 嘘を書くくらいなら空けておく
    const row = statusRow(drawBusy({ events: [] }));
    assert.match(row, /思考中/);
    assert.equal(/Bash|Read/.test(row), false);
  });

  test('印が回る', () => {
    const marks = new Set<string>();
    for (const frame of [0, 1, 2, 3]) {
      marks.add(statusRow(drawBusy({ frame })).trimStart().slice(0, 1));
    }
    assert.ok(marks.size > 1, `印が変化する: ${[...marks].join('')}`);
  });

  test('経過時間が出る', () => {
    assert.match(statusRow(drawBusy({ now: 95_000 })), /01:35/, '待ち時間が分かる');
  });

  test('本文の行を潰さない', () => {
    // 印のぶん 1 行使うので、確保する高さを間違えると会話が隠れる
    const conv = new ConversationState();
    conv.pushUser('この行は消えてはいけない');

    const screen = new Screen(90, 20, 'none');
    drawConversation(screen, {
      session: {
        name: 'claude-1',
        kind: 'claude',
        state: 'thinking',
        drafts: [],
        pendingApprovals: [],
        currentTask: { id: 't1', startedAt: 0, events: [] },
      } as never,
      conversation: conv,
      theme: DEFAULT_THEME,
      now: 5_000,
      frame: 0,
      animate: true,
    });
    const rows = screen.toStrings();
    assert.ok(rows.some((r) => r.includes('この行は消えてはいけない')));
    assert.ok(rows.some((r) => r.includes('Ctrl+C で中断')));
  });
});

// ---------------------------------------------------------------------------

describe('過去の会話を遡る', () => {
  function longConversation(turns: number) {
    const conv = new ConversationState();
    for (let i = 0; i < turns; i += 1) {
      conv.pushUser(`指示 ${i}`);
      conv.applyEvent({ t: 'text', delta: `返事 ${i}` });
      conv.applyEvent({ t: 'turn_end', ok: true, result: '' });
    }
    return conv;
  }

  function draw(conv: ConversationState): string[] {
    const screen = new Screen(80, 20, 'none');
    drawConversation(screen, {
      session: { name: 'claude-1', kind: 'claude', state: 'idle', drafts: [], pendingApprovals: [] } as never,
      conversation: conv,
      theme: DEFAULT_THEME,
      now: 0,
    });
    return screen.toStrings();
  }

  test('上に続きがあることを知らせる', () => {
    // 何も出さないと「これで全部」に見えて、遡れることに気づけない
    const rows = draw(longConversation(40));
    assert.ok(
      rows.some((r) => /↑ さらに \d+ 行  \[Ctrl\+U\]/.test(r)),
      '残りの行数と押すキーが出る',
    );
  });

  test('短い会話では出さない', () => {
    const rows = draw(longConversation(1));
    assert.equal(rows.some((r) => r.includes('↑ さらに')), false);
  });

  test('遡ると下にも続きがあると出る', () => {
    const conv = longConversation(40);
    conv.scrollBy(-30);
    const rows = draw(conv);
    assert.ok(rows.some((r) => /↓ さらに \d+ 行/.test(r)));
  });

  test('最下部に戻ると下の案内は消える', () => {
    const conv = longConversation(40);
    conv.scrollBy(-30);
    conv.scrollToBottom();
    const rows = draw(conv);
    assert.equal(rows.some((r) => r.includes('↓ さらに')), false);
  });

  test('キーバーに遡り方が出ている', () => {
    const rows = draw(longConversation(2));
    assert.ok(rows.some((r) => r.includes('[Ctrl+U/D]過去の会話')));
  });

  test('前回までのやり取りが会話に入る', () => {
    // 起動し直しても、前に何を頼んで何が返ってきたかを読める
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const claude = new MockDriver({ kind: 'claude' });
    const manager = new SessionManager({
      store,
      drivers: { claude },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });
    const session = manager.createSession({ kind: 'claude', name: 'claude-1' });

    const term = new FakeTerminal(100, 32);
    const app = new App({
      manager,
      terminal: term,
      animate: false,
      loadHistory: () => [
        {
          id: 'task-1',
          sessionId: session.id,
          prompt: '前回の指示',
          startedAt: 0,
          endedAt: 1,
          status: 'done',
          events: [],
          summary: '前回の返事です。',
          recoveredFrom: null,
        },
      ],
    });
    app.start();

    for (const k of decodeKeys('\r')) app.handleKey(k);
    app.render();
    const view = app.screen.toStrings().join('\n');

    assert.ok(view.includes('前回の指示'), '何を頼んだか');
    assert.ok(view.includes('前回の返事です。'), '何が返ってきたか');
  });
});

// ---------------------------------------------------------------------------

describe('遡りかた', () => {
  test('一度に動くのは 1/4 ほど', () => {
    // 半画面ずつだと残る行が少なく、ページが切り替わったように見える
    for (const height of [24, 30, 50]) {
      const body = height - 6;
      const step = scrollStep(height);
      assert.ok(step >= 2, `${height}: ${step}`);
      assert.ok(step <= body / 3, `${height}: 本文 ${body} 行に対して ${step} 行は動きすぎ`);
      assert.ok(step >= body / 6, `${height}: ${step} 行では進まなすぎ`);
    }
  });

  test('画面が小さくても止まらない', () => {
    assert.ok(scrollStep(8) >= 2);
    assert.ok(scrollStep(1) >= 2);
  });

  test('Ctrl+U / Ctrl+D で動き、PgUp / PgDn では動かない', async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude', name: 'claude-1' });
    for (let i = 0; i < 40; i += 1) {
      await h.manager.dispatch(session.id, `指示 ${i}`);
    }
    h.press('\r');

    /** 画面に出ている「↑ さらに N 行」の N。出ていなければ 0。 */
    const above = (): number => {
      const row = h.view().split('\n').find((r) => r.includes('↑ さらに')) ?? '';
      return Number(row.match(/↑ さらに (\d+) 行/)?.[1] ?? 0);
    };

    const atBottom = above();

    h.press('\x1b[5~');
    assert.equal(above(), atBottom, 'PgUp では動かない');

    h.press('\x15');
    const afterCtrlU = above();
    assert.ok(afterCtrlU < atBottom, 'Ctrl+U で遡る');

    h.press('\x1b[6~');
    assert.equal(above(), afterCtrlU, 'PgDn でも動かない');

    h.press('\x04');
    assert.ok(above() > afterCtrlU, 'Ctrl+D で戻る');
  });

  test('一度に消える行は画面の一部だけ', async () => {
    // 大半の行が残るので、どこを読んでいたか見失わない
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude', name: 'claude-1' });
    for (let i = 0; i < 40; i += 1) {
      await h.manager.dispatch(session.id, `指示 ${i}`);
    }
    h.press('\r');

    const bodyOf = (): string[] =>
      h.view().split('\n').slice(1, 25).filter((r) => r.trim() !== '');

    const before = new Set(bodyOf());
    h.press('\x15');
    const after = bodyOf();

    const kept = after.filter((r) => before.has(r)).length;
    assert.ok(kept >= after.length / 2, `${kept}/${after.length} 行しか残っていない`);
  });
});
