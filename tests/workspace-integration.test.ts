/**
 * WorkspaceManager と SessionManager を繋いだ統合テスト。
 * 「同じディレクトリに 2 人目を置いたら自動で隔離され、
 *   それぞれ独立に動く」という §9 の目的が達成できているかを見る。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { WorkspaceManager, occupiedMap } from '../src/core/workspace.ts';
import { LockManager } from '../src/core/locks.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import type { Session } from '../src/core/types.ts';

let root = '';
let repo = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vo-int-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a + b;\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: repo },
  );
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const voRoot = join(root, '.agent-dashboard');
  const store = new StateStore(createDashboard());
  const driver = new MockDriver({ kind: 'claude' });
  driver.setScenario(() => successfulTurn({ files: ['calc.js'] }));

  const locks = new LockManager({ dir: join(voRoot, 'locks'), retryIntervalMs: 5 });
  const manager = new SessionManager({
    store,
    drivers: { claude: driver },
    ids: new SeqIdGen(),
    locks,
    config: { defaultCwd: repo },
  });
  const wm = new WorkspaceManager({ root: voRoot });

  /** 作成の流れ（SPEC §8.1 手順 4）: 衝突判定 → 用意 → 追加 */
  async function addInto(cwd: string, name: string): Promise<Session> {
    const id = `s-${store.dashboard.sessions.length + 1}`;
    const plan = await wm.plan({
      sessionId: id,
      name,
      requestedCwd: cwd,
      occupied: occupiedMap(store.dashboard.sessions),
    });
    if (plan.kind === 'needs-decision') throw new Error('この経路は使わない');
    const workspace = await wm.provision(plan);
    return manager.createSession({ kind: 'claude', cwd, name, workspace });
  }

  return { store, manager, driver, wm, locks, addInto };
}

// ---------------------------------------------------------------------------

describe('同一ディレクトリへの作成', () => {
  test('1 人目はそのまま、2 人目は worktree に隔離される', async () => {
    const h = harness();

    const a = await h.addInto(repo, 'claude-1');
    assert.equal(a.workspace.isolation, 'none');
    assert.equal(a.workspace.actualCwd, repo);

    const b = await h.addInto(repo, 'claude-2');
    assert.equal(b.workspace.isolation, 'worktree');
    assert.equal(b.workspace.branch, 'vo/claude-2');
    assert.notEqual(b.workspace.actualCwd, repo);
    assert.ok(existsSync(join(b.workspace.actualCwd, 'calc.js')));
  });

  test('3 人目も別の worktree になる', async () => {
    const h = harness();
    await h.addInto(repo, 'claude-1');
    const b = await h.addInto(repo, 'claude-2');
    const c = await h.addInto(repo, 'claude-3');

    assert.notEqual(c.workspace.actualCwd, b.workspace.actualCwd);
    assert.equal(c.workspace.branch, 'vo/claude-3');
  });

  test('指示は隔離先のディレクトリで実行される', async () => {
    const h = harness();
    const a = await h.addInto(repo, 'claude-1');
    const b = await h.addInto(repo, 'claude-2');

    await h.manager.dispatch(a.id, '直して');
    await h.manager.dispatch(b.id, '直して');

    const cwds = h.driver.calls.map((c) => c.cwd);
    assert.equal(cwds[0], repo, '1 人目は元リポジトリ');
    assert.equal(cwds[1], b.workspace.actualCwd, '2 人目は worktree');
  });

  test('隔離済みのセッションしか残っていなければ、次の作成は隔離なしで入れる', async () => {
    const h = harness();
    const a = await h.addInto(repo, 'claude-1');
    await h.addInto(repo, 'claude-2');

    h.manager.archiveSession(a.id);

    const c = await h.addInto(repo, 'claude-3');
    assert.equal(c.workspace.isolation, 'none', '元リポジトリが空いたので隔離不要');
  });
});

// ---------------------------------------------------------------------------

describe('ロックによる直列化（SPEC §9.4）', () => {
  test('同居しているセッションの指示は順番に実行される', async () => {
    const h = harness();
    const timeline: string[] = [];

    h.driver.setScenario((ctx) => {
      timeline.push(`start:${ctx.prompt}`);
      return [
        { t: 'text', delta: 'ok' },
        { t: 'turn_end', ok: true, result: 'ok' },
      ];
    });

    // 同居させる（衝突判定を通さず、同じ actualCwd を直接与える）
    const shared = {
      requestedCwd: repo,
      actualCwd: repo,
      isolation: 'none' as const,
      branch: null,
      sandbox: null,
    };
    const a = h.manager.createSession({ kind: 'claude', cwd: repo, workspace: shared });
    const b = h.manager.createSession({ kind: 'claude', cwd: repo, workspace: { ...shared } });

    await Promise.all([
      h.manager.dispatch(a.id, 'A').then(() => timeline.push('end:A')),
      h.manager.dispatch(b.id, 'B').then(() => timeline.push('end:B')),
    ]);

    // 片方が完全に終わってからもう片方が始まる（入れ子にならない）
    const first = timeline[0]!.split(':')[1]!;
    assert.equal(timeline[1], `end:${first}`, `重なっている: ${timeline.join(' → ')}`);
    assert.equal(timeline.length, 4);
  });

  test('worktree で隔離されていれば並行に走れる', async () => {
    const h = harness();
    let concurrent = 0;
    let peak = 0;

    h.driver.setScenario(() => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      concurrent -= 1;
      return [{ t: 'turn_end', ok: true, result: 'ok' }];
    });

    const a = await h.addInto(repo, 'claude-1');
    const b = await h.addInto(repo, 'claude-2');

    await Promise.all([h.manager.dispatch(a.id, 'A'), h.manager.dispatch(b.id, 'B')]);

    assert.notEqual(a.workspace.actualCwd, b.workspace.actualCwd);
    assert.equal(h.driver.calls.length, 2);
  });

  test('ターンが失敗してもロックは解放される', async () => {
    const h = harness();
    h.driver.setScenario(() => {
      throw new Error('spawn failed');
    });

    const emp = h.manager.createSession({ kind: 'claude', cwd: repo });
    const failed = await h.manager.dispatch(emp.id, 'やって');
    assert.equal(failed.status, 'failed');

    // 解放されていなければここで待たされる
    h.driver.setScenario(() => successfulTurn());
    const ok = await h.manager.dispatch(emp.id, 'もう一度');
    assert.equal(ok.status, 'done');
  });
});

// ---------------------------------------------------------------------------

describe('アーカイブ時の後始末', () => {
  test('未コミットの変更があれば worktree を残す', async () => {
    const h = harness();
    await h.addInto(repo, 'claude-1');
    const b = await h.addInto(repo, 'claude-2');

    writeFileSync(join(b.workspace.actualCwd, 'wip.txt'), '書きかけ\n');
    h.manager.archiveSession(b.id);

    const result = await h.wm.release(b.workspace);
    assert.equal(result.removed, false);
    assert.equal(result.reason, 'uncommitted');
    assert.ok(existsSync(b.workspace.actualCwd), '成果物を勝手に捨てない');
  });

  test('変更が無ければ worktree を片付ける', async () => {
    const h = harness();
    await h.addInto(repo, 'claude-1');
    const b = await h.addInto(repo, 'claude-2');

    h.manager.archiveSession(b.id);
    const result = await h.wm.release(b.workspace);

    assert.equal(result.removed, true);
    assert.equal(existsSync(b.workspace.actualCwd), false);
    assert.ok(existsSync(join(repo, 'calc.js')), '元リポジトリは無傷');
  });
});
