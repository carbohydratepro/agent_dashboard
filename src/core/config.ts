/** 設定ファイル（SPEC §18）。null は「CLI の既定に従う」を意味する。 */

import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DashboardConfig {
  title: string;
  defaults: {
    claude: { permissionMode: string | null; model: string | null; contextWindow: number };
    codex: { sandbox: string | null; model: string | null; contextWindow: number };
    cwd: string;
  };
  approvals: { alwaysAllow: string[] };
  workspace: { autoWorktree: boolean; worktreeBranchPrefix: string };
  network: {
    watch: boolean;
    pollIntervalMs: number;
    stabilizeMs: number;
    maxWaitMs: number;
    maxRetries: number;
    sleepDetectThresholdMs: number;
    autoRecover: boolean;
  };
  notifications: { bell: boolean };

  ui: {
    animations: boolean;
    fps: number;
    ascii: boolean;
    theme: string;
    slotCount: number;
    showSubordinates: boolean;
    showRateLimitBar: boolean;
  };
  thresholds: { contextWarn: number; contextRest: number };
}

/** 保存先のディレクトリ名。旧称は仮想オフィスだった頃の名残。 */
export const ROOT_NAME = '.agent-dashboard';
export const LEGACY_ROOT_NAME = '.virtual-office';

export function defaultRoot(): string {
  // VO_HOME は旧名。既に設定している人の環境を壊さないよう受け付け続ける
  return process.env.AGENT_DASHBOARD_HOME ?? process.env.VO_HOME ?? join(homedir(), ROOT_NAME);
}

export function legacyDefaultRoot(): string {
  return join(homedir(), LEGACY_ROOT_NAME);
}

/**
 * 旧名のディレクトリを一度だけ引っ越す。
 *
 * 引っ越し前のダッシュボードが動いたままだと、そちらは終了時に旧名へ書き戻す。
 * 先に移してしまうと新しい方が古い状態で上書きされるので、
 * 「移すのは新しい方がまだ無いときだけ」を厳守する。両方あるときは触らず報告する。
 *
 * 戻り値は利用者に見せる 1 行。何もしなかったときは null。
 */
export function migrateLegacyRoot(root: string, legacy: string): string | null {
  if (!existsSync(legacy)) return null;
  if (existsSync(root)) {
    return `旧: ${legacy} が残っています。${root} を使うので読んでいません。不要なら削除してください。`;
  }
  try {
    renameSync(legacy, root);
    return `保存先を ${legacy} から ${root} へ移しました。`;
  } catch (err) {
    return `保存先を ${legacy} から移せませんでした: ${(err as Error).message}`;
  }
}

export function defaultConfig(): DashboardConfig {
  return {
    title: 'AGENT DASHBOARD',
    defaults: {
      claude: { permissionMode: null, model: null, contextWindow: 200_000 },
      codex: { sandbox: null, model: null, contextWindow: 200_000 },
      cwd: process.cwd(),
    },
    approvals: { alwaysAllow: [] },
    workspace: { autoWorktree: true, worktreeBranchPrefix: 'vo/' },
    network: {
      watch: true,
      pollIntervalMs: 5_000,
      stabilizeMs: 3_000,
      maxWaitMs: 60_000,
      maxRetries: 3,
      sleepDetectThresholdMs: 60_000,
      autoRecover: true,
    },
    notifications: { bell: true },

    ui: {
      animations: true,
      fps: 8,
      ascii: false,
      theme: 'office-green',
      slotCount: 8,
      showSubordinates: true,
      showRateLimitBar: true,
    },
    thresholds: { contextWarn: 0.75, contextRest: 0.85 },
  };
}

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 保存されている設定を既定値に重ねる。知らないキーは無視する。 */
export function mergeConfig(base: DashboardConfig, patch: unknown): DashboardConfig {
  if (!isPlainObject(patch)) return base;
  const out = structuredClone(base) as unknown as Plain;

  const walk = (target: Plain, source: Plain): void => {
    for (const [key, value] of Object.entries(source)) {
      if (!(key in target)) continue;
      const current = target[key];
      if (isPlainObject(current) && isPlainObject(value)) walk(current, value);
      else if (value !== undefined && typeof value === typeof current) target[key] = value;
      else if (Array.isArray(current) && Array.isArray(value)) target[key] = value;
    }
  };
  walk(out, patch);
  return out as unknown as DashboardConfig;
}
