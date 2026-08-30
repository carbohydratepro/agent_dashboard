/** 設定ファイル（SPEC §18）。null は「CLI の既定に従う」を意味する。 */

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
  behavior: { autoSendNextMemo: boolean };
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

export function defaultRoot(): string {
  return process.env.VO_HOME ?? join(homedir(), '.virtual-office');
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
    behavior: { autoSendNextMemo: false },
    notifications: { bell: true },

    ui: {
      animations: true,
      fps: 8,
      ascii: false,
      theme: 'office-green',
      slotCount: 6,
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
