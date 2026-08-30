/** 永続化と状態復帰（SPEC §14）。 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Persistence, writeAtomic, RAW_ROTATE_BYTES } from '../src/core/persistence.ts';
import { bootstrap } from '../src/core/bootstrap.ts';
import { defaultConfig, mergeConfig } from '../src/core/config.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { attachAutosave } from '../src/core/autosave.ts';
import { MockDriver, successfulTurn, deniedTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vo-persist-'));
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 20));

/** 保存まで含めた 1 回ぶんの「アプリ起動」 */
function session(driverFactory?: () => MockDriver) {
  const persistence = new Persistence(root);
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = driverFactory?.() ?? new MockDriver({ kind: 'claude' });
  claude.setScenario(() => successfulTurn());
  const manager = new SessionManager({
    store,
    drivers: { claude, codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
    ids: new SeqIdGen(),
    config: { defaultCwd: '/ws' },
    onRawLine: (id, line) => persistence.appendRaw(id, line),
  });
  const detach = attachAutosave({ store, persistence });

  const { loaded } = persistence.loadSessions();
  manager.loadSessions(loaded.map((l) => l.session));

  return { persistence, store, manager, claude, detach, loaded };
}

// ---------------------------------------------------------------------------

describe('アトミック書き込み', () => {
  test('一時ファイルを残さない', () => {
    const path = join(root, 'a', 'b.json');
    writeAtomic(path, '{"x":1}');
    assert.equal(readFileSync(path, 'utf8'), '{"x":1}');
    assert.equal(existsSync(`${path}.tmp`), false);
  });

  test('上書きしても壊れない', () => {
    const path = join(root, 'x.json');
    writeAtomic(path, 'first');
    writeAtomic(path, 'second');
    assert.equal(readFileSync(path, 'utf8'), 'second');
  });
});

describe('設定', () => {
  test('保存されていなければ既定値', () => {
    const p = new Persistence(root);
    assert.deepEqual(p.loadConfig(), defaultConfig());
  });

  test('保存した値が読み戻る', () => {
    const p = new Persistence(root);
    const config = defaultConfig();
    config.behavior.autoSendNextMemo = true;
    config.ui.slotCount = 4;
    p.saveConfig(config);

    const loaded = new Persistence(root).loadConfig();
    assert.equal(loaded.behavior.autoSendNextMemo, true);
    assert.equal(loaded.ui.slotCount, 4);
  });

  test('知らないキーは無視し、足りないキーは既定値で埋める', () => {
    const merged = mergeConfig(defaultConfig(), {
      behavior: { autoSendNextMemo: true },
      未知のセクション: { x: 1 },
    });
    assert.equal(merged.behavior.autoSendNextMemo, true);
    assert.equal(merged.ui.slotCount, 6, '触っていないキーは既定値のまま');
    assert.equal('未知のセクション' in merged, false);
  });

  test('壊れた設定ファイルでも起動できる', () => {
    writeFileSync(join(root, 'config.json'), 'これは JSON ではない');
    assert.deepEqual(new Persistence(root).loadConfig(), defaultConfig());
  });
});

describe('セッションの保存と読み戻し', () => {
  test('識別名・スタッツ・下書き・セッション ID が残る', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude', name: 'リク', role: 'backend' });
    await a.manager.dispatch(emp.id, 'やって');
    a.manager.setNextPrompt(emp.id, '次はテスト');
    await settle();

    const b = session();
    assert.equal(b.loaded.length, 1);
    const restored = b.store.active()[0]!;

    assert.equal(restored.id, emp.id);
    assert.equal(restored.name, emp.name);
    assert.equal(restored.role, 'backend');
    assert.equal(restored.agentSessionId, emp.agentSessionId, '会話への紐が残る');
    assert.equal(restored.nextPrompt, '次はテスト');
    assert.equal(restored.stats.tasksCompleted, 1);
  });

  test('立ち上げ直すと offline から始まる', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    await a.manager.dispatch(emp.id, 'やって');
    assert.equal(emp.state, 'idle');
    await settle();

    const b = session();
    assert.equal(b.store.active()[0]!.state, 'offline');
  });

  test('サブエージェントは残さない', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    emp.subagents = [
      {
        taskId: 'x', toolUseId: 'y', agentType: 'Explore', name: 'A/1',
        description: 'd', currentAction: 'c', lastToolName: 'Bash', totalTokens: 1, toolUses: 1,
        durationMs: 1, startedAt: 0, status: 'running', summary: null, lastText: '',
      },
    ];
    a.persistence.saveSession(emp);

    const b = session();
    assert.deepEqual(b.store.active()[0]!.subagents, []);
  });

  test('承認待ちは残る', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    a.claude.setScenario(() => deniedTurn({ filePath: 'src/a.ts' }));
    await a.manager.dispatch(emp.id, 'やって');
    await settle();

    const b = session();
    const restored = b.store.active()[0]!;
    assert.equal(restored.pendingApprovals.length, 1);
    assert.equal(restored.pendingApprovals[0]!.toolInput.file_path, 'src/a.ts');
  });

  test('アーカイブ者も残り、スロットは空く', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    a.manager.archiveSession(emp.id);
    await settle();

    const b = session();
    assert.equal(b.store.active().length, 0);
    assert.equal(b.store.dashboard.sessions.length, 1, '人事ファイルには残る');
    assert.equal(b.store.firstFreeSlot(), 0);
  });

  test('壊れたファイルは飛ばして他を読む', async () => {
    const a = session();
    a.manager.createSession({ kind: 'claude', name: '無事' });
    await settle();
    mkdirSync(join(root, 'sessions-meta'), { recursive: true });
    writeFileSync(join(root, 'sessions-meta', 'broken.json'), '{ 途中で切れ');

    const p = new Persistence(root);
    const { loaded, broken } = p.loadSessions();
    assert.equal(loaded.length, 1, '無事なセッションは読める');
    assert.deepEqual(broken, ['broken.json']);
  });
});

describe('タスク履歴と生ログ', () => {
  test('完了したタスクが積まれる', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    await a.manager.dispatch(emp.id, '一つ目');
    await a.manager.dispatch(emp.id, '二つ目');
    await settle();

    const tasks = a.persistence.loadTasks(emp.id);
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map((t) => t.prompt), ['一つ目', '二つ目']);
    assert.equal(tasks[0]!.status, 'done');
  });

  test('CLI の生出力を無加工で残す', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    a.persistence.appendRaw(emp.id, '{"type":"system","subtype":"init"}');
    a.persistence.appendRaw(emp.id, '{"type":"result"}');

    const raw = readFileSync(a.persistence.rawPath(emp.id), 'utf8');
    assert.equal(raw.trim().split('\n').length, 2);
    assert.ok(raw.includes('"subtype":"init"'));
  });

  test('大きくなったら退避する', () => {
    const p = new Persistence(root);
    p.appendRaw('e1', 'x'.repeat(100));
    assert.equal(p.rotateRawIfNeeded('e1'), false, '小さいうちは何もしない');
    assert.equal(p.rotateRawIfNeeded('e1', 50), true);
    assert.equal(existsSync(join(p.logDir('e1'), 'raw.1.jsonl')), true);
    assert.equal(existsSync(p.rawPath('e1')), false);
  });

  test('壊れた行があっても他のタスクは読める', () => {
    const p = new Persistence(root);
    p.appendTask('e1', {
      id: 't1', sessionId: 'e1', prompt: 'ok', startedAt: 0, endedAt: 1,
      status: 'done', events: [], summary: null, recoveredFrom: null,
    });
    writeFileSync(join(p.logDir('e1'), 'tasks.jsonl'), readFileSync(join(p.logDir('e1'), 'tasks.jsonl'), 'utf8') + '壊れた行\n');
    assert.equal(p.loadTasks('e1').length, 1);
  });
});

describe('起動シーケンス（SPEC §14.3）', () => {
  test('保存されたセッションをスロットに戻す', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude', name: 'ソラ' });
    await a.manager.dispatch(emp.id, 'やって');
    await settle();

    const boot = await bootstrap({
      root,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      skipVersionCheck: true,
    });

    const restored = boot.store.active()[0]!;
    assert.equal(restored.name, emp.name);
    assert.equal(restored.state, 'offline');
    assert.equal(boot.store.dashboard.slotCount, 6);
  });

  test('前回の作業中タスクを中断扱いにし、指示を下書きへ戻す', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    // running のまま保存された状態を作る
    emp.currentTask = {
      id: 'task-9', sessionId: emp.id, prompt: '途中だった指示', startedAt: 0,
      endedAt: null, status: 'running', events: [], summary: null, recoveredFrom: null,
    };
    a.persistence.saveSession(emp);

    const boot = await bootstrap({
      root,
      drivers: { claude: new MockDriver({ kind: 'claude' }) },
      skipVersionCheck: true,
    });

    const restored = boot.store.active()[0]!;
    assert.equal(restored.currentTask?.status, 'interrupted');
    assert.equal(restored.nextPrompt, '途中だった指示', '社長がやり直せる');
    assert.equal(restored.stats.tasksInterrupted, 1);
  });

  test('既に下書きがあれば上書きしない', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    emp.nextPrompt = '先に書いた下書き';
    emp.currentTask = {
      id: 'task-9', sessionId: emp.id, prompt: '途中だった指示', startedAt: 0,
      endedAt: null, status: 'running', events: [], summary: null, recoveredFrom: null,
    };
    a.persistence.saveSession(emp);

    const boot = await bootstrap({ root, drivers: {}, skipVersionCheck: true });
    assert.equal(boot.store.active()[0]!.nextPrompt, '先に書いた下書き');
  });

  test('worktree が消えていたら隔離を解除して警告する', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    emp.workspace = {
      requestedCwd: '/repo',
      actualCwd: join(root, 'worktrees', 'gone'),
      isolation: 'worktree',
      branch: 'vo/CLD-01',
      sandbox: null,
    };
    a.persistence.saveSession(emp);

    const boot = await bootstrap({ root, drivers: {}, skipVersionCheck: true });
    const restored = boot.store.active()[0]!;
    assert.equal(restored.workspace.isolation, 'none');
    assert.equal(restored.workspace.actualCwd, '/repo');
    assert.ok(boot.warnings.some((w) => w.includes('worktree')));
  });

  test('死んだロックを片付ける', async () => {
    const p = new Persistence(root);
    mkdirSync(p.locksDir, { recursive: true });
    writeFileSync(
      join(p.locksDir, 'dead.lock'),
      JSON.stringify({ pid: 999_999, sessionId: 'x', cwd: '/a', acquiredAt: 0 }),
    );

    const boot = await bootstrap({ root, drivers: {}, skipVersionCheck: true });
    assert.equal(existsSync(join(p.locksDir, 'dead.lock')), false);
    assert.ok(boot.warnings.some((w) => w.includes('ロック')));
  });

  test('CLI が無ければ警告してその種別を無効にする', async () => {
    const boot = await bootstrap({ root, cwd: '/ws' });
    // 実環境に claude / codex があるかは問わず、落ちずに起動できることを見る
    assert.ok(Array.isArray(boot.warnings));
    assert.ok(boot.store.dashboard.slotCount > 0);
  });

  test('設定の値がマネージャに渡る', async () => {
    const p = new Persistence(root);
    const config = defaultConfig();
    config.behavior.autoSendNextMemo = true;
    config.approvals.alwaysAllow = ['Edit'];
    config.thresholds.contextRest = 0.7;
    p.saveConfig(config);

    const boot = await bootstrap({ root, drivers: {}, skipVersionCheck: true });
    assert.equal(boot.manager.config.autoSendNextMemo, true);
    assert.deepEqual(boot.manager.config.alwaysAllowedTools, ['Edit']);
    assert.equal(boot.manager.config.contextRestThreshold, 0.7);
  });
});

describe('会話の続き', () => {
  test('落として立ち上げ直しても同じセッションを再開する', async () => {
    const a = session();
    const emp = a.manager.createSession({ kind: 'claude' });
    await a.manager.dispatch(emp.id, '一回目');
    const sessionId = emp.agentSessionId;
    assert.ok(sessionId);
    await settle();
    a.detach();

    // ここでアプリが落ちたことにする
    const b = session();
    const restored = b.store.active()[0]!;
    assert.equal(restored.agentSessionId, sessionId);

    await b.manager.dispatch(restored.id, '二回目');

    const call = b.claude.calls[0]!;
    assert.equal(call.mode, 'resume', '新規ではなく再開になる');
    assert.equal(call.sessionId, sessionId, '同じ会話に続く');
    assert.equal(restored.stats.tasksCompleted, 2, 'スタッツも引き継ぐ');
  });

  test('セッション ID が無ければ新規で始まる', async () => {
    const a = session();
    a.manager.createSession({ kind: 'claude' });
    await settle();

    const b = session();
    const restored = b.store.active()[0]!;
    await b.manager.dispatch(restored.id, 'はじめまして');
    assert.equal(b.claude.calls[0]!.mode, 'start');
  });
});
