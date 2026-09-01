/**
 * 作業ディレクトリの衝突回避（SPEC §9）のテスト。
 * git はモックせず、tmpdir に本物のリポジトリを作って叩く。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceManager, occupiedMap } from '../src/core/workspace.ts';
import type { WorkspacePlan } from '../src/core/workspace.ts';
import { systemGit, uncommittedChanges } from '../src/core/git.ts';
import type { Workspace } from '../src/core/types.ts';

let root = '';
let repo = '';
let plainDir = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vo-ws-'));
  repo = join(root, 'repo');
  plainDir = join(root, 'plain');
  mkdirSync(repo);
  mkdirSync(plainDir);

  writeFileSync(join(repo, 'calc.js'), 'export const add = (a, b) => a + b;\n');
  git(['init', '-q', '-b', 'main'], repo);
  git(['add', '-A'], repo);
  git(['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-qm', 'init'], repo);

  writeFileSync(join(plainDir, 'notes.txt'), 'hello\n');
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

function manager(opts: { autoWorktree?: boolean } = {}) {
  return new WorkspaceManager({ root: join(root, '.agent-dashboard'), ...opts });
}

function occupied(entries: Array<[string, string[]]>): Map<string, string[]> {
  return new Map(entries);
}

// ---------------------------------------------------------------------------

describe('plan — 衝突判定', () => {
  test('誰も使っていなければ隔離しない', async () => {
    const plan = await manager().plan({
      sessionId: 'e1',
      name: 'claude-1',
      requestedCwd: repo,
      occupied: occupied([]),
    });

    assert.equal(plan.kind, 'none');
    assert.equal(plan.actualCwd, repo);
  });

  test('git リポジトリで衝突したら worktree を提案する', async () => {
    const plan = await manager().plan({
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    });

    assert.equal(plan.kind, 'worktree');
    assert.equal(plan.branch, 'vo/claude-2');
    assert.match(plan.actualCwd, /worktrees[/\\]e2$/);
    assert.equal(plan.repoRoot, repo);
  });

  test('git でないディレクトリで衝突したらユーザーの判断を仰ぐ', async () => {
    const plan = await manager().plan({
      sessionId: 'e2',
      name: 'codex-2',
      requestedCwd: plainDir,
      occupied: occupied([[plainDir, ['claude-1']]]),
    });

    assert.equal(plan.kind, 'needs-decision');
    assert.deepEqual(plan.occupiedBy, ['claude-1']);
  });

  test('autoWorktree を切ると git でも判断を仰ぐ', async () => {
    const plan = await manager({ autoWorktree: false }).plan({
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    });
    assert.equal(plan.kind, 'needs-decision');
  });

  test('ブランチ名が埋まっていたら連番で避ける（再作成・復職）', async () => {
    git(['branch', 'vo/claude-2'], repo);
    const plan = await manager().plan({
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    });

    assert.equal(plan.kind, 'worktree');
    assert.equal(plan.branch, 'vo/claude-2-2');
  });
});

// ---------------------------------------------------------------------------

describe('provision — worktree を実際に切る', () => {
  test('worktree が作られ、ブランチが切られ、中身が見える', async () => {
    const wm = manager();
    const plan = await wm.plan({
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    });

    const ws = await wm.provision(plan);

    assert.equal(ws.isolation, 'worktree');
    assert.equal(ws.branch, 'vo/claude-2');
    assert.equal(ws.requestedCwd, repo);
    assert.ok(existsSync(join(ws.actualCwd, 'calc.js')), '元リポジトリの中身が見える');

    const head = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ws.actualCwd,
      encoding: 'utf8',
    }).trim();
    assert.equal(head, 'vo/claude-2');
  });

  test('2 人が同じリポジトリを触っても編集がぶつからない', async () => {
    const wm = manager();

    const p2 = await wm.plan({
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    });
    const ws2 = await wm.provision(p2);

    const p3 = await wm.plan({
      sessionId: 'e3',
      name: 'claude-3',
      requestedCwd: repo,
      occupied: occupied([
        [repo, ['claude-1']],
        [ws2.actualCwd, ['claude-2']],
      ]),
    });
    const ws3 = await wm.provision(p3);

    assert.notEqual(ws2.actualCwd, ws3.actualCwd);
    assert.notEqual(ws2.branch, ws3.branch);

    // それぞれが同じファイルを別内容に書き換える
    writeFileSync(join(ws2.actualCwd, 'calc.js'), '// CLD-02 の変更\n');
    writeFileSync(join(ws3.actualCwd, 'calc.js'), '// CLD-03 の変更\n');

    assert.match(readFileSync(join(ws2.actualCwd, 'calc.js'), 'utf8'), /CLD-02/);
    assert.match(readFileSync(join(ws3.actualCwd, 'calc.js'), 'utf8'), /CLD-03/);
    assert.match(
      readFileSync(join(repo, 'calc.js'), 'utf8'),
      /export const add/,
      '元リポジトリは無傷',
    );
  });

  test('判断待ちの計画は provision できない', async () => {
    const wm = manager();
    const plan: WorkspacePlan = {
      kind: 'needs-decision',
      requestedCwd: plainDir,
      occupiedBy: ['claude-1'],
    };
    await assert.rejects(() => wm.provision(plan), /判断が必要/);
  });

  test('前回の残骸があっても作り直せる', async () => {
    const wm = manager();
    const req = {
      sessionId: 'e2',
      name: 'claude-2',
      requestedCwd: repo,
      occupied: occupied([[repo, ['claude-1']]]),
    };

    const ws = await wm.provision(await wm.plan(req));
    // ディレクトリだけ残して git の登録と食い違わせる
    rmSync(join(ws.actualCwd, 'calc.js'));
    writeFileSync(join(ws.actualCwd, 'leftover.txt'), 'stale\n');

    const again = await wm.provision(await wm.plan(req));
    assert.ok(existsSync(join(again.actualCwd, 'calc.js')));
    assert.equal(existsSync(join(again.actualCwd, 'leftover.txt')), false);
  });
});

// ---------------------------------------------------------------------------

describe('release — アーカイブ時の後始末（SPEC §9.3）', () => {
  async function provisioned(): Promise<{ wm: WorkspaceManager; ws: Workspace }> {
    const wm = manager();
    const ws = await wm.provision(
      await wm.plan({
        sessionId: 'e2',
        name: 'claude-2',
        requestedCwd: repo,
        occupied: occupied([[repo, ['claude-1']]]),
      }),
    );
    return { wm, ws };
  }

  test('変更が無ければ削除する', async () => {
    const { wm, ws } = await provisioned();
    const result = await wm.release(ws);

    assert.equal(result.removed, true);
    assert.equal(existsSync(ws.actualCwd), false);
  });

  test('未コミットの変更があれば削除せず、件数と内訳を返す', async () => {
    const { wm, ws } = await provisioned();
    writeFileSync(join(ws.actualCwd, 'calc.js'), '// 作業途中\n');
    writeFileSync(join(ws.actualCwd, 'draft.md'), '書きかけ\n');

    const result = await wm.release(ws);

    assert.equal(result.removed, false);
    assert.equal(result.reason, 'uncommitted');
    assert.equal(result.count, 2, '変更 1 件 + 未追跡 1 件');
    assert.ok(result.files.some((f) => f.includes('draft.md')));
    assert.ok(existsSync(ws.actualCwd), '既定は「残す」');
  });

  test('force を付ければ変更ごと削除する', async () => {
    const { wm, ws } = await provisioned();
    writeFileSync(join(ws.actualCwd, 'calc.js'), '// 作業途中\n');

    const result = await wm.release(ws, { force: true });
    assert.equal(result.removed, true);
    assert.equal(existsSync(ws.actualCwd), false);
  });

  test('隔離していないセッションは何も消さない', async () => {
    const wm = manager();
    const ws: Workspace = {
      requestedCwd: repo,
      actualCwd: repo,
      isolation: 'none',
      branch: null,
      sandbox: null,
    };
    const result = await wm.release(ws);

    assert.equal(result.removed, false);
    assert.equal(result.reason, 'not-isolated');
    assert.ok(existsSync(repo), '元リポジトリは絶対に消さない');
  });
});

// ---------------------------------------------------------------------------

describe('verify — 起動時の実在確認（SPEC §14.3）', () => {
  test('worktree が消えていたら隔離なしに戻す', () => {
    const wm = manager();
    const ws: Workspace = {
      requestedCwd: repo,
      actualCwd: join(root, '.agent-dashboard', 'worktrees', 'gone'),
      isolation: 'worktree',
      branch: 'vo/claude-2',
      sandbox: null,
    };

    const { ok, repaired } = wm.verify(ws);
    assert.equal(ok, false);
    assert.equal(repaired?.isolation, 'none');
    assert.equal(repaired?.actualCwd, repo);
    assert.equal(repaired?.branch, null);
  });

  test('存在していればそのまま', async () => {
    const wm = manager();
    const ws = await wm.provision(
      await wm.plan({
        sessionId: 'e2',
        name: 'claude-2',
        requestedCwd: repo,
        occupied: occupied([[repo, ['claude-1']]]),
      }),
    );
    assert.deepEqual(wm.verify(ws), { ok: true, repaired: null });
  });
});

// ---------------------------------------------------------------------------

describe('resolveDecision / occupiedMap', () => {
  test('読み取り専用を選ぶとサンドボックスで縛る', () => {
    const ws = manager().resolveDecision(
      { kind: 'needs-decision', requestedCwd: plainDir, occupiedBy: ['claude-1'] },
      'read-only',
    );
    assert.equal(ws.sandbox, 'read-only');
    assert.equal(ws.isolation, 'none');
  });

  test('同居を選ぶとサンドボックスは付けない', () => {
    const ws = manager().resolveDecision(
      { kind: 'needs-decision', requestedCwd: plainDir, occupiedBy: ['claude-1'] },
      'share',
    );
    assert.equal(ws.sandbox, null);
  });

  test('隔離済みのセッションは元ディレクトリを占有しない', () => {
    const map = occupiedMap([
      {
        archived: false,
        name: 'claude-2',
        workspace: {
          requestedCwd: repo,
          actualCwd: '/wt/e2',
          isolation: 'worktree',
          branch: 'vo/claude-2',
          sandbox: null,
        },
      },
    ]);

    assert.equal(map.get(repo), undefined, '元リポジトリは空いている');
    assert.deepEqual(map.get('/wt/e2'), ['claude-2']);
  });

  test('アーカイブ者は数えない', () => {
    const map = occupiedMap([
      {
        archived: true,
        name: 'アーカイブ者',
        workspace: {
          requestedCwd: repo,
          actualCwd: repo,
          isolation: 'none',
          branch: null,
          sandbox: null,
        },
      },
    ]);
    assert.equal(map.size, 0);
  });
});

// ---------------------------------------------------------------------------

describe('git ヘルパー', () => {
  test('未コミットの変更を数える', async () => {
    assert.deepEqual(await uncommittedChanges(systemGit, repo), { count: 0, files: [] });

    writeFileSync(join(repo, 'calc.js'), 'changed\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');

    const dirty = await uncommittedChanges(systemGit, repo);
    assert.equal(dirty.count, 2);
  });

  test('git 以外のディレクトリでも落ちない', async () => {
    assert.deepEqual(await uncommittedChanges(systemGit, plainDir), { count: 0, files: [] });
  });
});
