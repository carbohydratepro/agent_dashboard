/** git の薄いラッパ。差し替え可能にして、テストでは実 git を叩く。 */

import { execFile } from 'node:child_process';
import { childEnv } from './drivers/process.ts';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], cwd: string): Promise<GitResult>;
}

export const systemGit: GitRunner = {
  run(args, cwd) {
    return new Promise<GitResult>((resolve) => {
      execFile(
        'git',
        args,
        { cwd, env: childEnv(), maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  },
};

export async function isGitRepo(git: GitRunner, dir: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--is-inside-work-tree'], dir);
  return r.ok && r.stdout.trim() === 'true';
}

/** リポジトリのルート。worktree の中から呼ぶと、その worktree のルートが返る点に注意。 */
export async function repoRoot(git: GitRunner, dir: string): Promise<string | null> {
  const r = await git.run(['rev-parse', '--show-toplevel'], dir);
  return r.ok ? r.stdout.trim() || null : null;
}

export async function branchExists(git: GitRunner, dir: string, branch: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], dir);
  return r.ok && r.stdout.trim() !== '';
}

/** 消えた worktree の登録を掃除する。add の前に呼ぶ。 */
export async function pruneWorktrees(git: GitRunner, dir: string): Promise<void> {
  await git.run(['worktree', 'prune'], dir);
}

export async function addWorktree(
  git: GitRunner,
  repo: string,
  path: string,
  branch: string,
): Promise<GitResult> {
  return git.run(['worktree', 'add', path, '-b', branch], repo);
}

export async function removeWorktree(
  git: GitRunner,
  repo: string,
  path: string,
  force: boolean,
): Promise<GitResult> {
  const args = ['worktree', 'remove', path];
  if (force) args.push('--force');
  return git.run(args, repo);
}

export interface DirtyState {
  count: number;
  files: string[];
}

/**
 * 未コミットの変更。未追跡ファイルも数える。
 * アーカイブ時にこれが空でなければ worktree を消さない（SPEC §9.3）。
 */
export async function uncommittedChanges(git: GitRunner, dir: string): Promise<DirtyState> {
  const r = await git.run(['status', '--porcelain'], dir);
  if (!r.ok) return { count: 0, files: [] };
  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.slice(l.indexOf(' ') + 1).trim());
  return { count: files.length, files };
}
