/**
 * 作業ディレクトリの衝突回避（SPEC §9）。
 *
 * 作成の流れは 2 段階に分かれる:
 *   plan()      … 判定だけ。衝突していて git でもない場合はユーザーの判断を仰ぐ
 *   provision() … 実際に worktree を切って Workspace を作る
 *
 * 分けてあるのは、非 git の衝突が本質的に対話的だから（SPEC §9.1 のダイアログ）。
 * 判定ロジックは core に置いたまま、選択だけを UI に委ねられる。
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import type { Workspace } from './types.ts';
import type { GitRunner } from './git.ts';
import {
  addWorktree,
  branchExists,
  isGitRepo,
  pruneWorktrees,
  removeWorktree,
  repoRoot,
  systemGit,
  uncommittedChanges,
} from './git.ts';

/** 非 git の衝突で選べる選択肢（SPEC §9.1） */
export type ConflictChoice = 'separate-dir' | 'read-only' | 'share';

export interface PlanRequest {
  sessionId: string;
  name: string;
  requestedCwd: string;
  /** 既に使われている実ディレクトリ → 使っているセッション名 */
  occupied: ReadonlyMap<string, readonly string[]>;
}

export type WorkspacePlan =
  /** 誰とも被っていない。そのまま使う */
  | { kind: 'none'; requestedCwd: string; actualCwd: string }
  /** 衝突したが git なので worktree で隔離できる */
  | {
      kind: 'worktree';
      requestedCwd: string;
      actualCwd: string;
      branch: string;
      repoRoot: string;
    }
  /** 衝突したうえ git でもない。ユーザーの判断が要る */
  | {
      kind: 'needs-decision';
      requestedCwd: string;
      occupiedBy: readonly string[];
    };

export type ReleaseResult =
  | { removed: true }
  | { removed: false; reason: 'not-isolated' }
  | { removed: false; reason: 'uncommitted'; count: number; files: string[] }
  | { removed: false; reason: 'failed'; message: string };

export interface WorkspaceManagerOptions {
  /** データ置き場のルート */
  root: string;
  git?: GitRunner;
  branchPrefix?: string;
  /** false なら衝突しても worktree を切らず、常にユーザーの判断を仰ぐ */
  autoWorktree?: boolean;
}

export class WorkspaceManager {
  #root: string;
  #git: GitRunner;
  #branchPrefix: string;
  #autoWorktree: boolean;

  constructor(opts: WorkspaceManagerOptions) {
    this.#root = opts.root;
    this.#git = opts.git ?? systemGit;
    this.#branchPrefix = opts.branchPrefix ?? 'vo/';
    this.#autoWorktree = opts.autoWorktree ?? true;
  }

  get worktreesDir(): string {
    return join(this.#root, 'worktrees');
  }

  worktreePathFor(sessionId: string): string {
    return join(this.worktreesDir, sessionId);
  }

  /** 衝突を判定する。副作用なし。 */
  async plan(req: PlanRequest): Promise<WorkspacePlan> {
    const occupiedBy = req.occupied.get(req.requestedCwd) ?? [];

    if (occupiedBy.length === 0) {
      return { kind: 'none', requestedCwd: req.requestedCwd, actualCwd: req.requestedCwd };
    }
    if (!this.#autoWorktree || !(await isGitRepo(this.#git, req.requestedCwd))) {
      return { kind: 'needs-decision', requestedCwd: req.requestedCwd, occupiedBy };
    }

    const root = (await repoRoot(this.#git, req.requestedCwd)) ?? req.requestedCwd;
    const branch = await this.#freeBranchName(root, req.name);

    return {
      kind: 'worktree',
      requestedCwd: req.requestedCwd,
      actualCwd: this.worktreePathFor(req.sessionId),
      branch,
      repoRoot: root,
    };
  }

  /**
   * ダイアログで選ばれた結果を Plan に落とす。
   * `separate-dir` は新しい cwd が要るので、呼び出し側で plan() をやり直す。
   */
  resolveDecision(
    plan: Extract<WorkspacePlan, { kind: 'needs-decision' }>,
    choice: Exclude<ConflictChoice, 'separate-dir'>,
  ): Workspace {
    return {
      requestedCwd: plan.requestedCwd,
      actualCwd: plan.requestedCwd,
      isolation: 'none',
      branch: null,
      // 読み取り専用を選んだら codex 側はサンドボックスで縛る（SPEC §9.1）
      sandbox: choice === 'read-only' ? 'read-only' : null,
    };
  }

  /** Plan を実行して Workspace を作る。worktree ならここで実際に切る。 */
  async provision(plan: WorkspacePlan, sandbox: string | null = null): Promise<Workspace> {
    if (plan.kind === 'needs-decision') {
      throw new Error('判断が必要な計画は provision できません');
    }
    if (plan.kind === 'none') {
      return {
        requestedCwd: plan.requestedCwd,
        actualCwd: plan.actualCwd,
        isolation: 'none',
        branch: null,
        sandbox,
      };
    }

    mkdirSync(this.worktreesDir, { recursive: true });
    // 前回の残骸があると add が失敗する
    await pruneWorktrees(this.#git, plan.repoRoot);
    if (existsSync(plan.actualCwd)) {
      rmSync(plan.actualCwd, { recursive: true, force: true });
      await pruneWorktrees(this.#git, plan.repoRoot);
    }

    const r = await addWorktree(this.#git, plan.repoRoot, plan.actualCwd, plan.branch);
    if (!r.ok) {
      throw new Error(`worktree を作成できません: ${r.stderr.trim() || r.stdout.trim()}`);
    }

    return {
      requestedCwd: plan.requestedCwd,
      actualCwd: plan.actualCwd,
      isolation: 'worktree',
      branch: plan.branch,
      sandbox,
    };
  }

  /**
   * アーカイブ時の後始末（SPEC §9.3）。
   * 未コミットの変更があれば消さない。既定は「残す」。
   */
  async release(ws: Workspace, opts: { force?: boolean } = {}): Promise<ReleaseResult> {
    if (ws.isolation !== 'worktree') return { removed: false, reason: 'not-isolated' };
    if (!existsSync(ws.actualCwd)) {
      await pruneWorktrees(this.#git, ws.requestedCwd);
      return { removed: true };
    }

    if (!opts.force) {
      const dirty = await uncommittedChanges(this.#git, ws.actualCwd);
      if (dirty.count > 0) {
        return { removed: false, reason: 'uncommitted', count: dirty.count, files: dirty.files };
      }
    }

    const r = await removeWorktree(this.#git, ws.requestedCwd, ws.actualCwd, opts.force ?? false);
    if (!r.ok) {
      return { removed: false, reason: 'failed', message: r.stderr.trim() || r.stdout.trim() };
    }
    return { removed: true };
  }

  /**
   * 起動時の実在確認（SPEC §14.3 手順 4）。
   * worktree が消えていたら隔離なしに戻す。
   */
  verify(ws: Workspace): { ok: boolean; repaired: Workspace | null } {
    if (ws.isolation !== 'worktree') return { ok: true, repaired: null };
    if (existsSync(ws.actualCwd)) return { ok: true, repaired: null };
    return {
      ok: false,
      repaired: {
        ...ws,
        actualCwd: ws.requestedCwd,
        isolation: 'none',
        branch: null,
      },
    };
  }

  /** 既に使われているブランチ名を避ける（復元や再作成で衝突しうる） */
  async #freeBranchName(repo: string, name: string): Promise<string> {
    const base = `${this.#branchPrefix}${name}`;
    if (!(await branchExists(this.#git, repo, base))) return base;
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`;
      if (!(await branchExists(this.#git, repo, candidate))) return candidate;
    }
    return `${base}-${Date.now()}`;
  }
}

/** 「使用中の実ディレクトリ → セッション名」を作る */
export function occupiedMap(
  sessions: ReadonlyArray<{ workspace: Workspace; name: string; archived: boolean }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const e of sessions) {
    if (e.archived) continue;
    // 占有しているのは「実際に書き込む場所」。
    // worktree に隔離されたセッションは元ディレクトリを占有していないので、
    // それしか残っていなければ次は隔離なしで入れる。
    const list = map.get(e.workspace.actualCwd) ?? [];
    list.push(e.name);
    map.set(e.workspace.actualCwd, list);
  }
  return map;
}
