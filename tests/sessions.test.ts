/** 既存セッションの一覧と取り込み。 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  listExistingSessions,
  parseClaudeSession,
  parseCodexSession,
  readHead,
  readSessionTranscript,
  summarizeTranscript,
  toTitle,
} from '../src/core/sessions.ts';
import type { ExistingSession } from '../src/core/sessions.ts';
import { ConversationState, layoutEntries, lineText } from '../src/tui/views/conversation.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
import { sessionRow } from '../src/tui/views/import.ts';
import { displayWidth } from '../src/tui/width.ts';
import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';

let root = '';
let claudeRoot = '';
let codexRoot = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vo-sessions-'));
  claudeRoot = join(root, 'claude', 'projects');
  codexRoot = join(root, 'codex', 'sessions');
  mkdirSync(claudeRoot, { recursive: true });
  mkdirSync(codexRoot, { recursive: true });
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE_ID = '4380afd4-5355-431a-835e-6b6a2b696811';

/**
 * 保存先を差し替えて実行する。
 * 片方だけ差し替えると、実環境のもう片方のセッションが混ざる。
 */
function withIsolatedSessions(fn: () => void): void {
  const before = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
  process.env.CODEX_HOME = join(root, 'codex');
  try {
    fn();
  } finally {
    if (before.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = before.claude;
    if (before.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before.codex;
  }
}

function writeClaudeSession(
  project: string,
  id: string,
  opts: { cwd?: string; title?: string; firstUser?: string; mtime?: number } = {},
): string {
  const dir = join(claudeRoot, project);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.jsonl`);

  const lines = [
    JSON.stringify({ type: 'mode', mode: 'default', sessionId: id }),
    JSON.stringify({
      type: 'user',
      sessionId: id,
      cwd: opts.cwd ?? '/home/work',
      timestamp: '2026-08-23T12:31:49.407Z',
      message: { role: 'user', content: opts.firstUser ?? 'ボットの状況を確認して' },
    }),
  ];
  if (opts.title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: opts.title, sessionId: id }));

  writeFileSync(path, `${lines.join('\n')}\n`);
  if (opts.mtime) utimesSync(path, opts.mtime / 1000, opts.mtime / 1000);
  return path;
}

function writeCodexSession(
  id: string,
  opts: { cwd?: string; firstUser?: string; mtime?: number } = {},
): string {
  const dir = join(codexRoot, '2026', '08', '23');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-23T22-09-08-${id}.jsonl`);

  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { session_id: id, cwd: opts.cwd ?? '/home/proj', cli_version: '0.147.0' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: opts.firstUser ?? 'テストを直して' },
    }),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
  if (opts.mtime) utimesSync(path, opts.mtime / 1000, opts.mtime / 1000);
  return path;
}

// ---------------------------------------------------------------------------

describe('見出しの作り方', () => {
  test('長い発話は 1 行に縮める', () => {
    assert.equal(toTitle('短い'), '短い');
    assert.equal(toTitle('あ'.repeat(100), 10).length, 10);
    assert.equal(toTitle('改行を\n含む\n発話'), '改行を 含む 発話');
  });
});

describe('claude のセッション', () => {
  test('ファイル名がセッション ID になる', () => {
    const path = writeClaudeSession('-home-work', CLAUDE_ID, { title: 'Bot稼働状況の確認' });
    const session = parseClaudeSession(path, readHead(path, 65_536), 1_000)!;

    assert.equal(session.kind, 'claude');
    assert.equal(session.sessionId, CLAUDE_ID);
    assert.equal(session.cwd, '/home/work');
    assert.equal(session.title, 'Bot稼働状況の確認', 'ai-title を見出しに使う');
  });

  test('タイトルが無ければ最初の発話を使う', () => {
    const path = writeClaudeSession('-p', CLAUDE_ID, { firstUser: '認証まわりを直して' });
    const session = parseClaudeSession(path, readHead(path, 65_536), 1_000)!;
    assert.equal(session.title, '認証まわりを直して');
  });

  test('注入された指示文は見出しにしない', () => {
    const path = writeClaudeSession('-p', CLAUDE_ID, {
      firstUser: '<system-reminder>これは指示です</system-reminder>',
    });
    const session = parseClaudeSession(path, readHead(path, 65_536), 1_000)!;
    assert.equal(session.title, '（内容不明）');
  });

  test('セッション ID に見えないファイルは無視する', () => {
    const path = writeClaudeSession('-p', CLAUDE_ID);
    assert.equal(parseClaudeSession(join(claudeRoot, 'memory.jsonl'), '', 0), null);
    assert.ok(parseClaudeSession(path, readHead(path, 65_536), 0));
  });
});

describe('codex のセッション', () => {
  test('session_meta から ID と場所を取る', () => {
    const id = '019f99a3-1924-77d3-923c-7203197906c2';
    const path = writeCodexSession(id, { cwd: '/home/proj', firstUser: 'テストを直して' });
    const session = parseCodexSession(path, readHead(path, 65_536), 2_000)!;

    assert.equal(session.kind, 'codex');
    assert.equal(session.sessionId, id);
    assert.equal(session.cwd, '/home/proj');
    assert.equal(session.title, 'テストを直して');
  });

  test('注入された指示文は飛ばす', () => {
    const path = writeCodexSession('019f0000-0000-7000-8000-000000000000', {
      firstUser: '# AGENTS.md instructions for /home/x\n本文',
    });
    const session = parseCodexSession(path, readHead(path, 65_536), 0)!;
    assert.equal(session.title, '（内容不明）');
  });

  test('session_meta が無ければ一覧に出さない', () => {
    assert.equal(parseCodexSession('/x/rollout-a.jsonl', '{"type":"event_msg"}', 0), null);
  });
});

describe('一覧', () => {
  test('両方の CLI から集めて新しい順に並べる', () => {
    writeClaudeSession('-a', CLAUDE_ID, { title: '古い会話', mtime: 1_000_000 });
    writeCodexSession('019f0000-0000-7000-8000-000000000001', { mtime: 3_000_000 });
    writeClaudeSession('-b', '5380afd4-5355-431a-835e-6b6a2b696822', {
      title: '新しい会話',
      mtime: 2_000_000,
    });

    const list = listExistingSessions({ claudeRoot, codexRoot });
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((s) => s.kind), ['codex', 'claude', 'claude']);
    assert.equal(list[1]!.title, '新しい会話');
  });

  test('件数を絞れる', () => {
    for (let i = 0; i < 5; i += 1) {
      writeClaudeSession(`-p${i}`, `4380afd4-5355-431a-835e-70000000000${i}`, { mtime: 1000 * i });
    }
    assert.equal(listExistingSessions({ claudeRoot, codexRoot, limit: 3 }).length, 3);
  });

  test('壊れたファイルは黙って飛ばす', () => {
    writeClaudeSession('-ok', CLAUDE_ID, { title: '無事' });
    mkdirSync(join(claudeRoot, '-broken'), { recursive: true });
    writeFileSync(join(claudeRoot, '-broken', '5380afd4-5355-431a-835e-b00000000000.jsonl'), '{ 壊れ');

    const list = listExistingSessions({ claudeRoot, codexRoot });
    assert.ok(list.some((s) => s.title === '無事'));
  });

  test('保存先が無くても落ちない', () => {
    assert.deepEqual(
      listExistingSessions({ claudeRoot: join(root, 'ない'), codexRoot: join(root, 'ない2') }),
      [],
    );
  });

  test('大きなファイルでも先頭だけ読む', () => {
    const path = writeClaudeSession('-big', CLAUDE_ID, { title: '見出し' });
    writeFileSync(path, `${'{"type":"noise"}\n'.repeat(50_000)}`, { flag: 'a' });

    const list = listExistingSessions({ claudeRoot, codexRoot, headBytes: 4_096 });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.title, '見出し');
  });
});

describe('取り込みの画面', () => {
  function harness() {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const claude = new MockDriver({ kind: 'claude' });
    claude.setScenario(() => successfulTurn());
    const manager = new SessionManager({
      store,
      drivers: { claude, codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });
    const app = new App({ manager, terminal: new FakeTerminal(100, 32), animate: false, bell: false });
    app.start();
    return {
      app,
      manager,
      store,
      claude,
      press: (...raws: string[]) => {
        for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
      },
      view: () => {
        
        app.render();
        return app.screen.toStrings().join('\n');
      },
    };
  }

  test('引き継いだセッションは最初から resume で続きになる', async () => {
    const h = harness();
    const emp = h.manager.createSession({
      kind: 'claude',
      cwd: '/home/work',
      agentSessionId: 'existing-session-id',
    });

    assert.equal(emp.agentSessionId, 'existing-session-id');
    await h.manager.dispatch(emp.id, '続きをお願い');

    const call = h.claude.calls[0]!;
    assert.equal(call.mode, 'resume', '新規セッションを作らない');
    assert.equal(call.sessionId, 'existing-session-id');
    assert.equal(call.cwd, '/home/work', '会話が始まった場所で動かす');
  });

  test('追加ダイアログで追加方法を切り替えられる', () => {
    const h = harness();
    h.press('n');
    assert.ok(h.view().includes('新規に作る'));

    h.press('\x1b[C');
    const text = h.view();
    assert.ok(text.includes('既存の会話を取り込む'));
    assert.equal(text.includes('作業ディレクトリ'), false, '引き継ぐ会話の場所を使うので出さない');
  });

  test('一覧にあるのセッションが握っている会話は一覧に出さない', () => {
    const h = harness();
    withIsolatedSessions(() => {
      writeClaudeSession('-work', CLAUDE_ID, { title: '担当中の会話' });
      h.manager.createSession({ kind: 'claude', agentSessionId: CLAUDE_ID });

      h.press('n', '\x1b[C', '\r');
      assert.equal(h.app.screenId, 'main', '引き継げる会話が無い');
      assert.ok(h.view().includes('見つかりませんでした'));
    });
  });

  test('アーカイブさせた会話はまた取り込める', () => {
    // アーカイブ済みまで除外すると、一度雇った会話に二度と手が出せなくなる
    const h = harness();
    withIsolatedSessions(() => {
      writeClaudeSession('-work', CLAUDE_ID, { title: '前に担当した会話' });
      const emp = h.manager.createSession({ kind: 'claude', agentSessionId: CLAUDE_ID });
      h.manager.archiveSession(emp.id);

      h.press('n', '\x1b[C', '\r');
      assert.equal(h.app.screenId, 'importSession');
      const list = h.view();
      assert.ok(list.includes('前に担当した会話'));
      assert.ok(list.includes(`元 ${emp.name}`), '以前の使用元が分かる');
    });
  });

  test('引き継げる会話が無ければその旨を出す', () => {
    const h = harness();
    withIsolatedSessions(() => {
      h.press('n', '\x1b[C', '\r');
      assert.equal(h.app.screenId, 'main');
      assert.ok(h.view().includes('見つかりませんでした'));
    });
  });

  test('一覧から選んで取り込みられる', () => {
    const h = harness();
    withIsolatedSessions(() => {
      writeClaudeSession('-work', CLAUDE_ID, {
        cwd: '/home/work',
        title: '認証の調査',
        firstUser: '認証まわりを調べて',
      });

      h.press('n', '\x1b[C', '\r');
      assert.equal(h.app.screenId, 'importSession');
      const list = h.view();
      assert.ok(list.includes('認証の調査'));
      assert.ok(list.includes('/home/work'), '作業場所が出る');
      assert.ok(list.includes('認証まわりを調べて'), '選ぶ前に中身が見える');

      h.press('\r');

      const emp = h.store.active()[0]!;
      assert.equal(emp.agentSessionId, CLAUDE_ID);
      assert.equal(emp.workspace.actualCwd, '/home/work');
      assert.equal(emp.stats.tasksCompleted, 1, '取り込み元の実績が入る');

      // 迎えた直後は会話画面。これまでのやり取りが見えないと指示できない。
      assert.equal(h.app.screenId, 'conversation');
      const conversation = h.view();
      assert.ok(conversation.includes('認証まわりを調べて'), '過去のやり取りが見える');
      assert.ok(conversation.includes('として続行'), '取り込みの区切りが入る');
    });
  });

  test('一覧から Esc で追加ダイアログに戻る', () => {
    const h = harness();
    withIsolatedSessions(() => {
      writeClaudeSession('-work', CLAUDE_ID, { title: 'なにか' });
      h.press('n', '\x1b[C', '\r');
      h.press('\x1b');
      assert.equal(h.app.screenId, 'hire');
    });
  });
});

// ---------------------------------------------------------------------------

describe('会話の中身を読み戻す', () => {
  function claudeConversation(id: string, extra: string[] = []): ExistingSession {
    const dir = join(claudeRoot, '-work');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${id}.jsonl`);
    const lines = [
      JSON.stringify({ type: 'user', sessionId: id, cwd: '/home/work', message: { role: 'user', content: '認証を直して' } }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部の思考' }, { type: 'text', text: '直しました' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: id,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: id,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
      }),
      ...extra,
    ];
    writeFileSync(path, `${lines.join('\n')}\n`);
    return { kind: 'claude', sessionId: id, cwd: '/home/work', title: 'x', updatedAt: 0, path };
  }

  test('ユーザーの発話と AI の出力とツールを取り出す', () => {
    const session = claudeConversation(CLAUDE_ID);
    const { items } = readSessionTranscript(session);

    assert.deepEqual(items.map((i) => i.t), ['user', 'assistant', 'tool']);
    const [first, second, third] = items;
    assert.equal(first?.t === 'user' && first.text, '認証を直して');
    assert.equal(second?.t === 'assistant' && second.text, '直しました');
    assert.equal(third?.t === 'tool' && third.name, 'Edit');
  });

  test('思考ブロックとツール結果は履歴に入れない', () => {
    const { items } = readSessionTranscript(claudeConversation(CLAUDE_ID));
    const texts = items.map((i) => (i.t === 'tool' ? i.detail : i.text)).join(' ');
    assert.equal(texts.includes('内部の思考'), false);
    assert.equal(items.filter((i) => i.t === 'user').length, 1, 'ツール結果を発話に数えない');
  });

  test('サブエージェントの発話は本筋に混ぜない', () => {
    const session = claudeConversation(CLAUDE_ID, [
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'サブエージェントの作業報告' }] },
      }),
    ]);
    const { items } = readSessionTranscript(session);
    assert.equal(items.some((i) => i.t === 'assistant' && i.text.includes('サブエージェント')), false);
  });

  test('引数の改行は 1 行に潰す', () => {
    const session = claudeConversation(CLAUDE_ID, [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: "python - <<'EOF'\nimport sys\nEOF" } }],
        },
      }),
    ]);
    const { items } = readSessionTranscript(session);
    const tool = items.find((i) => i.t === 'tool' && i.name === 'Bash')!;
    assert.equal(tool.t === 'tool' && tool.detail.includes('\n'), false, '改行が残ると行が崩れる');
  });

  test('codex の会話も読める', () => {
    const id = '019f99a3-1924-77d3-923c-7203197906c2';
    const dir = join(codexRoot, '2026', '08', '23');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-x-${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: '/p' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'テストを直して' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: '直しました' } }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({\n  cmd: "npm test",\n})' },
        }),
      ].join('\n'),
    );

    const { items, experience } = readSessionTranscript({
      kind: 'codex', sessionId: id, cwd: '/p', title: '', updatedAt: 0, path,
    });
    assert.deepEqual(items.map((i) => i.t), ['user', 'assistant', 'tool']);
    const tool = items[2];
    assert.equal(tool?.t === 'tool' && tool.detail, 'npm test', 'コード片から cmd を抜く');
    assert.equal(experience.commandsRun, 1);
  });

  test('長い会話は末尾だけ残し、省略したことを伝える', () => {
    const dir = join(claudeRoot, '-long');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${CLAUDE_ID}.jsonl`);
    const lines = [];
    for (let i = 0; i < 50; i += 1) {
      lines.push(JSON.stringify({ type: 'user', cwd: '/w', message: { role: 'user', content: `指示 ${i}` } }));
    }
    writeFileSync(path, `${lines.join('\n')}\n`);

    const session: ExistingSession = { kind: 'claude', sessionId: CLAUDE_ID, cwd: '/w', title: '', updatedAt: 0, path };
    const { items, truncated, experience } = readSessionTranscript(session, { maxItems: 10 });

    assert.equal(items.length, 10);
    assert.equal(truncated, true);
    const last = items[9];
    assert.equal(last?.t === 'user' && last.text, '指示 49', '直近を残す');
    assert.equal(experience.turns, 50, '実績は全体から数える');
  });

  test('読めないファイルでも落ちない', () => {
    const { items, experience } = readSessionTranscript({
      kind: 'claude', sessionId: 'x', cwd: '', title: '', updatedAt: 0, path: '/ない/ファイル',
    });
    assert.deepEqual(items, []);
    assert.deepEqual(experience, { turns: 0, filesEdited: 0, commandsRun: 0 });
  });
});

describe('取り込み元の実績', () => {
  test('ログの実数から数える', () => {
    const experience = summarizeTranscript([
      { t: 'user', text: 'a' },
      { t: 'assistant', text: 'b' },
      { t: 'tool', name: 'Edit', detail: 'x.ts' },
      { t: 'tool', name: 'Write', detail: 'y.ts' },
      { t: 'tool', name: 'Bash', detail: 'npm test' },
      { t: 'tool', name: 'exec', detail: 'ls' },
      { t: 'tool', name: 'Read', detail: 'z.ts' },
      { t: 'user', text: 'c' },
    ]);
    assert.deepEqual(experience, { turns: 2, filesEdited: 2, commandsRun: 2 });
  });

  test('取り込んだ実績が集計に入る', () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });

    const emp = manager.createSession({
      kind: 'claude',
      agentSessionId: 'sess',
      carryOver: { turns: 18, filesEdited: 1, commandsRun: 111 },
    });

    // 18*10 + 1*2 + 111 = 293 → Lv.6
    assert.equal(emp.stats.tasksCompleted, 18);
    assert.equal(emp.stats.filesEdited, 1);
    assert.equal(emp.stats.commandsRun, 111);
  });

  test('新規作成は実績ゼロから', () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      config: { defaultCwd: '/ws' },
    });
    const emp = manager.createSession({ kind: 'claude' });
  });
});

describe('引き継いだ会話の見え方', () => {
  test('会話画面に流し込める', () => {
    const conv = new ConversationState();
    conv.seedFromTranscript(
      [
        { t: 'user', text: '認証を直して' },
        { t: 'assistant', text: '直しました' },
        { t: 'tool', name: 'Edit', detail: 'a.ts' },
      ],
      false,
    );

    assert.deepEqual(conv.entries.map((e) => e.t), ['user', 'assistant', 'tool']);
    const lines = layoutEntries(conv.entries, 80, DEFAULT_THEME, true);
    assert.ok(lines.some((l) => lineText(l).includes('認証を直して')));
    assert.ok(lines.some((l) => l.boxed && lineText(l).includes('直しました')), 'AI の出力は枠付き');
  });

  test('省略したことを最初に断る', () => {
    const conv = new ConversationState();
    conv.seedFromTranscript([{ t: 'user', text: 'あ' }], true);
    const first = conv.entries[0]!;
    assert.equal(first.t, 'system');
    assert.ok(first.t === 'system' && first.text.includes('省略'));
  });

  test('一覧の行が幅に収まる', () => {
    const session: ExistingSession = {
      kind: 'claude',
      sessionId: CLAUDE_ID,
      cwd: '/home/work',
      title: 'とても長い見出し'.repeat(20),
      updatedAt: Date.now(),
      path: '/x',
    };
    assert.ok(displayWidth(sessionRow(session, 60)) <= 60);
  });
});

// ---------------------------------------------------------------------------

describe('復元（SPEC §7.3）', () => {
  function manager() {
    const store = new StateStore(createDashboard({ slotCount: 2 }));
    return {
      store,
      manager: new SessionManager({
        store,
        drivers: { claude: new MockDriver({ kind: 'claude' }) },
        ids: new SeqIdGen(),
        config: { defaultCwd: '/ws' },
      }),
    };
  }

  test('アーカイブ済みをスロットに戻せる。実績はそのまま。', () => {
    const h = manager();
    const emp = h.manager.createSession({ kind: 'claude', agentSessionId: 'sess' });
    emp.stats.tasksCompleted = 18;
    h.manager.setNextPrompt(emp.id, '続きをやる');
    h.manager.archiveSession(emp.id);

    assert.equal(h.store.active().length, 0);

    const back = h.manager.unarchiveSession(emp.id);

    assert.equal(back.archived, false);
    assert.equal(back.state, 'offline');
    assert.equal(back.agentSessionId, 'sess', '会話への紐が残る');
    assert.equal(back.stats.tasksCompleted, 18);
    assert.equal(back.nextPrompt, '続きをやる', '下書きも残る');
    assert.equal(h.store.active().length, 1);
  });

  test('一覧にあるのセッションは復元できない', () => {
    const h = manager();
    const emp = h.manager.createSession({ kind: 'claude' });
    assert.throws(() => h.manager.unarchiveSession(emp.id), /一覧にあります/);
  });

  test('スロットが空いていなければ戻せない', () => {
    const h = manager();
    const a = h.manager.createSession({ kind: 'claude' });
    h.manager.archiveSession(a.id);
    h.manager.createSession({ kind: 'claude' });
    h.manager.createSession({ kind: 'claude' });

    assert.throws(() => h.manager.unarchiveSession(a.id), /スロットが空いていません/);
  });

  test('セッション履歴から r で復元させられる', () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager2 = new SessionManager({
      store,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });
    const app = new App({ manager: manager2, terminal: new FakeTerminal(100, 32), animate: false, bell: false });
    app.start();

    const emp = manager2.createSession({ kind: 'claude', agentSessionId: 'sess' });
    manager2.archiveSession(emp.id);

    const press = (raw: string): void => {
      for (const k of decodeKeys(raw)) app.handleKey(k);
    };

    press('a');
    app.render();
    assert.ok(app.screen.toStrings().join('\n').includes('（アーカイブ）'));
    assert.ok(app.screen.toStrings().join('\n').includes('[r] 一覧に戻す'));

    press('r');
    assert.equal(emp.archived, false);
    assert.equal(app.screenId, 'main');
    app.render();
    assert.ok(app.screen.toStrings().join('\n').includes('一覧に戻しました'));
  });

  test('在籍者を選んでいるときは復元の案内を出さない', () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager2 = new SessionManager({
      store,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      config: { defaultCwd: '/ws' },
    });
    const app = new App({ manager: manager2, terminal: new FakeTerminal(100, 32), animate: false, bell: false });
    app.start();
    manager2.createSession({ kind: 'claude' });

    for (const k of decodeKeys('a')) app.handleKey(k);
    app.render();
    assert.equal(app.screen.toStrings().join('\n').includes('[r] 一覧に戻す'), false);
  });
});
