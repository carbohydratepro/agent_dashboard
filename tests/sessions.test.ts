/** 既存セッションの一覧と取り込み。 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  analyzeSessionLog,
  findExistingSession,
  listExistingSessions,
  parseClaudeSession,
  parseCodexSession,
  readCodexThreadNames,
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

function writeCodexIndex(records: Array<Record<string, unknown>>): string {
  const path = join(root, 'codex', 'session_index.jsonl');
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
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

  test('Codex が生成した会話題名を索引から読む', () => {
    const path = writeCodexIndex([
      { id: 'thread-1', thread_name: '最初の題名' },
      { broken: true },
      { id: 'thread-1', thread_name: '更新後の題名' },
      { id: 'thread-2', thread_name: '別の題名' },
    ]);
    const names = readCodexThreadNames(path);

    assert.equal(names.get('thread-1'), '更新後の題名', '同じ ID は最後の記録を使う');
    assert.equal(names.get('thread-2'), '別の題名');
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

  test('Codex 自身が生成した題名を最初の投稿より優先する', () => {
    const id = '01a09e76-b131-7591-932d-99f9bbf16913';
    writeCodexSession(id, { firstUser: 'https://github.com/example/repository' });
    writeCodexIndex([{ id, thread_name: '導入可否を確認する' }]);

    const list = listExistingSessions({ claudeRoot, codexRoot });
    assert.equal(list[0]?.title, '導入可否を確認する');
  });

  test('Codex の生成題名が無ければ最初の投稿を使う', () => {
    const id = '019f0000-0000-7000-8000-000000000009';
    writeCodexSession(id, { firstUser: '認証処理を調べて' });
    writeCodexIndex([{ id: '別の会話', thread_name: '別の題名' }]);

    const list = listExistingSessions({ claudeRoot, codexRoot });
    assert.equal(list[0]?.title, '認証処理を調べて');
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

  test('再起動後も取り込んだ CLI 会話の過去ログを表示する', () => {
    const id = '019f99a3-1924-77d3-923c-7203197906c2';
    writeCodexSession(id, { firstUser: '再起動前に依頼した内容' });

    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });
    manager.createSession({ kind: 'codex', agentSessionId: id });
    const app = new App({
      manager,
      terminal: new FakeTerminal(100, 32),
      animate: false,
      bell: false,
      loadAgentSession: (kind, sessionId) =>
        findExistingSession(kind, sessionId, { claudeRoot, codexRoot }),
    });
    app.start();
    for (const key of decodeKeys('\r')) app.handleKey(key);
    app.render();

    assert.ok(app.screen.toStrings().join('\n').includes('再起動前に依頼した内容'));
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

  test('新しい codex の response_item 形式から発話を読める', () => {
    const id = '019f99a3-1924-77d3-923c-7203197906c2';
    const dir = join(codexRoot, '2026', '08', '24');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-new-${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: '/new' } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>注入情報</environment_context>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '過去の質問です' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '過去の回答です' }],
          },
        }),
      ].join('\n'),
    );

    const source = parseCodexSession(path, readHead(path, 65_536), 0)!;
    assert.equal(source.title, '過去の質問です', '索引が無くても最初の実発話を題名にする');

    const { items, experience } = readSessionTranscript(source);
    assert.deepEqual(items, [
      { t: 'user', text: '過去の質問です' },
      { t: 'assistant', text: '過去の回答です' },
    ]);
    assert.equal(experience.turns, 1, '注入情報を投稿数に含めない');
  });

  test('利用者が Markdown や HTML で始めた発話は注入情報と誤認しない', () => {
    const id = '019f99a3-1924-77d3-923c-7203197906c3';
    const dir = join(codexRoot, '2026', '08', '25');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-markup-${id}.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'session_meta', payload: { session_id: id, cwd: '/markup' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '# 見出しから始める依頼' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '<div>HTMLを確認して</div>' } }),
      ].join('\n'),
    );

    const { items } = readSessionTranscript({
      kind: 'codex', sessionId: id, cwd: '/markup', title: '', updatedAt: 0, path,
    });
    assert.deepEqual(items.map((item) => item.t === 'tool' ? item.detail : item.text), [
      '# 見出しから始める依頼',
      '<div>HTMLを確認して</div>',
    ]);
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

describe('CLI セッション全期間の集計', () => {
  test('Codex の各モデル呼び出しをターン別に積み上げる', async () => {
    const id = '019f0000-0000-7000-8000-000000000099';
    const path = writeCodexSession(id);
    const records = [
      { timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { session_id: id, cwd: '/work' } },
      { timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1_788_192_001, model_context_window: 200_000 } },
      { timestamp: '2026-09-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: '認証を直して' } },
      { timestamp: '2026-09-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 }, model_context_window: 200_000 } } },
      { timestamp: '2026-09-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', id: 'cmd-1', stdout: 'x'.repeat(100_000) } } },
      { timestamp: '2026-09-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', id: 'edit-1', changes: { '/work/a.ts': { type: 'update', unified_diff: 'x' }, '/work/b.ts': { type: 'add', unified_diff: 'y' } } } } },
      { timestamp: '2026-09-01T00:00:06.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', started_at: 1_788_192_001, completed_at: 1_788_192_006, duration_ms: 5_000 } },
      { timestamp: '2026-09-01T00:00:07.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2', started_at: 1_788_192_007 } },
      { timestamp: '2026-09-01T00:00:08.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'テストして' } },
      { timestamp: '2026-09-01T00:00:09.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 7, total_tokens: 230 }, model_context_window: 200_000 } } },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const source: ExistingSession = { kind: 'codex', sessionId: id, cwd: '/work', title: '', updatedAt: 0, path };

    const analysis = await analyzeSessionLog(source);

    assert.equal(analysis.lifetime.tasksCompleted, 1);
    assert.equal(analysis.lifetime.commandsRun, 1);
    assert.equal(analysis.lifetime.filesEdited, 2, '1回の変更に複数ファイルがあれば個別に数える');
    assert.equal(analysis.lifetime.activeMs, 5_000);
    assert.equal(analysis.lifetime.tokens.inputTokens, 300);
    assert.equal(analysis.lifetime.tokens.outputTokens, 50);
    assert.equal(analysis.lifetime.contextTokens, 200, '最後のモデル呼び出しが現在の文脈');
    assert.equal(analysis.lifetime.contextWindow, 200_000);
    assert.equal(analysis.lifetime.timedTurns, 1);
    assert.equal(analysis.lifetime.typicalTurnMs, 5_000);
    assert.equal(analysis.turns.length, 2);
    assert.equal(analysis.turns[0]?.label, '認証を直して');
    assert.equal(analysis.turns[0]?.tokens.totalTokens, 120);
    assert.equal(analysis.turns[1]?.complete, false);
  });

  test('完了目安には取得できたターン所要時間の中央値を使う', async () => {
    const id = '019f0000-0000-7000-8000-000000000098';
    const path = writeCodexSession(id);
    const records = [
      { timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { session_id: id, cwd: '/work' } },
      { timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
      { timestamp: '2026-09-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 1_000 } },
      { timestamp: '2026-09-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't2' } },
      { timestamp: '2026-09-01T00:00:12.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', duration_ms: 9_000 } },
      { timestamp: '2026-09-01T00:00:13.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't3' } },
      { timestamp: '2026-09-01T00:00:16.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't3', duration_ms: 3_000 } },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const source: ExistingSession = { kind: 'codex', sessionId: id, cwd: '/work', title: '', updatedAt: 0, path };

    const analysis = await analyzeSessionLog(source);

    assert.equal(analysis.lifetime.timedTurns, 3);
    assert.equal(analysis.lifetime.typicalTurnMs, 3_000);
  });

  test('Claude の分割レコードは message.id 単位で重複排除する', async () => {
    const dir = join(claudeRoot, '-analysis');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${CLAUDE_ID}.jsonl`);
    const usage1 = { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 };
    const records = [
      { type: 'user', uuid: 'u1', timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: 'ログを直して' } },
      { type: 'assistant', timestamp: '2026-09-01T00:00:02.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: {} }], stop_reason: 'tool_use', usage: usage1 } },
      { type: 'assistant', timestamp: '2026-09-01T00:00:03.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} }], stop_reason: 'tool_use', usage: usage1 } },
      { type: 'user', timestamp: '2026-09-01T00:00:04.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-2' }] } },
      { type: 'assistant', timestamp: '2026-09-01T00:00:10.000Z', message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '完了' }], stop_reason: 'end_turn', usage: { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 5, output_tokens: 6 } } },
    ];
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const source: ExistingSession = { kind: 'claude', sessionId: CLAUDE_ID, cwd: '/work', title: '', updatedAt: 0, path };

    const analysis = await analyzeSessionLog(source);

    assert.equal(analysis.lifetime.tasksCompleted, 1);
    assert.equal(analysis.lifetime.filesEdited, 1);
    assert.equal(analysis.lifetime.commandsRun, 1);
    assert.equal(analysis.lifetime.activeMs, 10_000);
    assert.equal(analysis.lifetime.tokens.inputTokens, 13, 'm1 は分割されても 1 回だけ数える');
    assert.equal(analysis.lifetime.tokens.outputTokens, 10);
    assert.equal(analysis.lifetime.contextTokens, 7);
    assert.equal(analysis.turns[0]?.tokens.totalTokens, 23);
  });

  test('統計画面にターン別グラフを表示する', async () => {
    const id = '019f0000-0000-7000-8000-000000000077';
    const path = writeCodexSession(id);
    writeFileSync(path, [
      JSON.stringify({ timestamp: '2026-09-01T00:00:00.000Z', type: 'session_meta', payload: { session_id: id, cwd: '/work' } }),
      JSON.stringify({ timestamp: '2026-09-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1_788_192_001 } }),
      JSON.stringify({ timestamp: '2026-09-01T00:00:02.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'グラフを確認する' } }),
      JSON.stringify({ timestamp: '2026-09-01T00:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1_000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1_200 } } } }),
      JSON.stringify({ timestamp: '2026-09-01T00:00:04.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', duration_ms: 3_000 } }),
    ].join('\n'));
    const source: ExistingSession = { kind: 'codex', sessionId: id, cwd: '/work', title: 'グラフ', updatedAt: 1, path };
    const store = new StateStore(createDashboard({ slotCount: 2 }));
    const manager = new SessionManager({
      store,
      drivers: { codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/work' },
    });
    const session = manager.createSession({ kind: 'codex', agentSessionId: id, name: '調査' });
    const app = new App({
      manager,
      terminal: new FakeTerminal(120, 40),
      animate: false,
      bell: false,
      loadAgentSession: () => source,
    });
    app.start();
    for (let i = 0; i < 50 && !session.lifetime; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (const key of decodeKeys('s')) app.handleKey(key);
    const view = app.screen.toStrings().join('\n');

    assert.ok(view.includes('会話ごとの消費トークン'));
    assert.ok(view.includes('グラフを確認する'));
    assert.ok(view.includes('in 1,000 / out 200'));
    assert.ok(view.includes('セッション切替'));
    app.stop();
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
    h.manager.addDraft(emp.id, '続きをやる');
    h.manager.archiveSession(emp.id);

    assert.equal(h.store.active().length, 0);

    const back = h.manager.unarchiveSession(emp.id);

    assert.equal(back.archived, false);
    assert.equal(back.state, 'offline');
    assert.equal(back.agentSessionId, 'sess', '会話への紐が残る');
    assert.equal(back.stats.tasksCompleted, 18);
    assert.equal(back.drafts[0]?.text, '続きをやる', '控えも残る');
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

// ---------------------------------------------------------------------------

describe('codex の会話一覧', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vo-codex-'));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  /** rollout ファイルを 1 つ書く。mtime を指定して新旧を作る。 */
  function rollout(
    name: string,
    sessionId: string,
    records: unknown[],
    mtimeSec: number,
  ): void {
    const day = join(dir, '2026', '09', '01');
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-${name}-${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: sessionId, cwd: '/ws', base_instructions: { text: 'x'.repeat(200) } },
      }),
      ...records.map((r) => JSON.stringify(r)),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`);
    utimesSync(path, mtimeSec, mtimeSec);
  }

  const userMsg = (message: string) => ({
    type: 'event_msg',
    payload: { type: 'user_message', message },
  });

  const assistantMsg = (text: string) => ({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });

  const agentMsg = (message: string) => ({
    type: 'event_msg',
    payload: { type: 'agent_message', message },
  });

  function list() {
    return listExistingSessions({ codexRoot: dir, claudeRoot: join(dir, 'none'), limit: 40 });
  }

  test('resume で増えたファイルを 1 件にまとめる', () => {
    // codex は resume のたびに新しい rollout を作るが、スレッド ID は変わらない
    rollout('a', 'thread-1', [userMsg('最初の指示')], 1_000);
    rollout('b', 'thread-1', [userMsg('The following is the Codex agent history')], 2_000);
    rollout('c', 'thread-1', [], 3_000);

    const found = list();
    assert.equal(found.length, 1, '同じスレッドは 1 件');
    assert.equal(found[0]!.sessionId, 'thread-1');
  });

  test('まとめるとき中身のある見出しを拾う', () => {
    // 新しいファイルには前置きしか無く、古いほうに本物の指示がある
    rollout('a', 'thread-1', [userMsg('誤って削除した場合に元に戻せないため')], 1_000);
    rollout('b', 'thread-1', [userMsg('The following is the Codex agent history')], 2_000);

    assert.match(list()[0]!.title, /誤って削除した場合/);
  });

  test('再開時に差し込まれる前置きを見出しにしない', () => {
    rollout('a', 'thread-1', [userMsg('The following is the Codex agent history of...')], 1_000);
    rollout('b', 'thread-2', [userMsg('<user_instructions>\n何か\n</user_instructions>')], 2_000);

    for (const s of list()) {
      assert.equal(s.title.startsWith('The following'), false, s.title);
      assert.equal(s.title.startsWith('<'), false, s.title);
    }
  });

  test('発話が注入物だけなら本人の返事を見出しにする', () => {
    rollout(
      'a',
      'thread-1',
      [userMsg('# AGENTS.md instructions for /ws'), assistantMsg('設定を確認しました。')],
      1_000,
    );

    assert.equal(list()[0]!.title, '設定を確認しました。');
  });

  test('ツールへ渡す JSON は見出しにしない', () => {
    rollout(
      'a',
      'thread-1',
      [userMsg('<environment_context>x</environment_context>'), assistantMsg('{"risk_level":"low"}')],
      1_000,
    );

    assert.equal(list()[0]!.title, '（内容不明）', 'ここは無題のほうがまし');
  });

  test('別スレッドはまとめない', () => {
    rollout('a', 'thread-1', [userMsg('ひとつ目')], 1_000);
    rollout('b', 'thread-2', [userMsg('ふたつ目')], 2_000);

    const found = list();
    assert.equal(found.length, 2);
    assert.deepEqual(
      found.map((s) => s.title).sort(),
      ['ひとつ目', 'ふたつ目'],
    );
  });

  test('resume で分かれた過去ログを古い順に読み合わせる', () => {
    const id = '019f0000-0000-7000-8000-000000000077';
    rollout('2026-09-01T10-00-00', id, [userMsg('最初の依頼'), agentMsg('最初の回答')], 1_000);
    rollout('2026-09-02T10-00-00', id, [userMsg('続きの依頼'), agentMsg('続きの回答')], 2_000);

    const source = findExistingSession('codex', id, {
      codexRoot: dir,
      claudeRoot: join(dir, 'none'),
    });
    assert.ok(source);
    assert.equal(source.paths?.length, 2);
    const transcript = readSessionTranscript(source!);
    assert.deepEqual(
      transcript.items.map((item) => (item.t === 'tool' ? item.detail : item.text)),
      ['最初の依頼', '最初の回答', '続きの依頼', '続きの回答'],
    );
  });
});
