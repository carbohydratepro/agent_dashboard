/**
 * 起動シーケンス（SPEC §14.3）。
 * 保存されたゲーム層を読み戻し、周辺の道具を組み立てて返す。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import { Persistence } from './persistence.ts';
import { defaultConfig, migrateLegacyRoot } from './config.ts';
import type { DashboardConfig } from './config.ts';
import { StateStore, createDashboard } from './store.ts';
import { SessionManager } from './session-manager.ts';
import { LockManager } from './locks.ts';
import { WorkspaceManager } from './workspace.ts';
import { NetworkMonitor } from './network.ts';
import { RecoveryCoordinator } from './recovery.ts';
import { ClaudeDriver } from './drivers/claude.ts';
import { CodexDriver } from './drivers/codex.ts';
import { attachAutosave } from './autosave.ts';
import { closeMonthsIfNeeded } from './analytics.ts';
import { UsageMonitor } from './usage-monitor.ts';
import { ClaudeUsageProbe, CodexUsageProbe } from './usage.ts';
import type { UsageProbe } from './usage.ts';
import type { History } from './analytics.ts';
import type { AgentDriver } from './drivers/driver.ts';
import type { AgentKind } from './types.ts';
import { childEnv } from './drivers/process.ts';

/** フェーズ 0 で挙動を確認したバージョン。ここから離れたら警告する。 */
export const VERIFIED_VERSIONS: Record<AgentKind, string> = {
  claude: '2.1.228',
  codex: '0.147.0',
};

export interface BootstrapResult {
  config: DashboardConfig;
  history: History;
  persistence: Persistence;
  store: StateStore;
  manager: SessionManager;
  locks: LockManager;
  workspace: WorkspaceManager;
  monitor: NetworkMonitor;
  recovery: RecoveryCoordinator;
  usage: UsageMonitor;
  warnings: string[];
  /** ドライバが揃っている AI 種別 */
  availableKinds: AgentKind[];
  detachAutosave: () => void;
}

export interface BootstrapOptions {
  root: string;
  cwd?: string;
  /** テスト用にドライバを差し替える */
  drivers?: Partial<Record<AgentKind, AgentDriver>>;
  /** テスト用にバージョン確認を飛ばす */
  skipVersionCheck?: boolean;
  /**
   * 旧名の保存先。渡されたときだけ引っ越しを試みる。
   * 既定値にせず呼び出し側に持たせるのは、テストが一時ディレクトリを root にするため。
   * 既定にすると利用者の本物のディレクトリを一時ディレクトリへ移してしまう。
   */
  legacyRoot?: string;
  now?: () => number;
}

function runVersion(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ['--version'],
      { env: childEnv(), timeout: 5_000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim()),
    );
    child.on('error', () => resolve(null));
  });
}

export async function bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
  const warnings: string[] = [];
  const now = opts.now ?? (() => Date.now());

  // 0. 旧名からの引っ越し。読み書きを始める前に済ませる
  if (opts.legacyRoot !== undefined) {
    const note = migrateLegacyRoot(opts.root, opts.legacyRoot);
    if (note !== null) warnings.push(note);
  }

  // 1. 設定と会社情報
  const persistence = new Persistence(opts.root);
  // 設定で変えられる項目があることが分かるよう、無ければ既定値で書き出しておく
  if (persistence.ensureConfigFile()) {
    warnings.push(`設定ファイルを作りました: ${persistence.configPath}`);
  }
  const config = persistence.loadConfig();
  if (opts.cwd) config.defaults.cwd = opts.cwd;

  const savedDashboard = persistence.loadDashboard();
  const store = new StateStore(
    createDashboard({
      title: savedDashboard?.title ?? config.title,
      // スロット数は config.json だけを見る。保存側にも持たせると、
      // 設定を書き換えても保存値に上書きされて効かない
      slotCount: config.ui.slotCount,
      rateLimit: savedDashboard?.rateLimit ?? null,
    }),
  );

  // 5. CLI の存在とバージョン
  const drivers: Partial<Record<AgentKind, AgentDriver>> = {};
  if (opts.drivers) {
    Object.assign(drivers, opts.drivers);
  } else {
    for (const kind of ['claude', 'codex'] as const) {
      const version = opts.skipVersionCheck ? VERIFIED_VERSIONS[kind] : await runVersion(kind);
      if (version === null) {
        warnings.push(`${kind} が見つかりません。この種別の作成は無効です。`);
        continue;
      }
      if (!version.includes(VERIFIED_VERSIONS[kind])) {
        warnings.push(
          `${kind} のバージョンが検証済み (${VERIFIED_VERSIONS[kind]}) と違います: ${version}`,
        );
      }
      drivers[kind] = kind === 'claude' ? new ClaudeDriver() : new CodexDriver();
    }
  }

  // 3. 死んだロックの掃除
  const locks = new LockManager({ dir: persistence.locksDir });
  const removed = locks.cleanupStale();
  if (removed > 0) warnings.push(`古いロックを ${removed} 件片付けました。`);

  const workspace = new WorkspaceManager({
    root: persistence.worktreesRoot,
    branchPrefix: config.workspace.worktreeBranchPrefix,
    autoWorktree: config.workspace.autoWorktree,
  });

  const manager = new SessionManager({
    store,
    drivers,
    locks,
    config: {
      contextWindow: config.defaults.claude.contextWindow,
      contextRestThreshold: config.thresholds.contextRest,
      autoSendNextMemo: config.behavior.autoSendNextMemo,
      defaultCwd: config.defaults.cwd,
      alwaysAllowedTools: [...config.approvals.alwaysAllow],
    },
    onRawLine: (sessionId, line) => persistence.appendRaw(sessionId, line),
  });

  // 2. セッションをスロットに戻す
  const { loaded, broken } = persistence.loadSessions();
  if (broken.length > 0) warnings.push(`読めなかったセッションファイル: ${broken.join(', ')}`);

  for (const { session, unfinishedPrompt } of loaded) {
    // 4. worktree の実在確認
    const check = workspace.verify(session.workspace);
    if (!check.ok && check.repaired) {
      session.workspace = check.repaired;
      warnings.push(`${session.name} の worktree が見つかりません。隔離を解除しました。`);
    }
    // 6. 前回の作業を中断扱いにし、プロンプトを下書きへ戻す
    if (unfinishedPrompt) {
      session.stats.tasksInterrupted += 1;
      if (session.nextPrompt.trim() === '') session.nextPrompt = unfinishedPrompt;
    }
  }
  manager.loadSessions(loaded.map((l) => l.session));

  // 7. ネットワーク監視
  const monitor = new NetworkMonitor({
    pollIntervalMs: config.network.pollIntervalMs,
    stabilizeMs: config.network.stabilizeMs,
    sleepDetectThresholdMs: config.network.sleepDetectThresholdMs,
  });
  const recovery = new RecoveryCoordinator({
    store,
    manager,
    monitor,
    options: {
      maxRetries: config.network.maxRetries,
      maxWaitMs: config.network.maxWaitMs,
      autoRecover: config.network.autoRecover,
    },
  });

  // 8. 月次の締め（SPEC §13.3）
  const loadedHistory = persistence.loadHistory(now());
  const { history, closed } = closeMonthsIfNeeded(loadedHistory, store.dashboard.sessions, now());
  if (closed.length > 0) {
    persistence.saveHistory(history);
    const idle = closed.filter((m) => m.idle).length;
    warnings.push(
      idle > 0
        ? `${closed.length} か月ぶんを締めました（うち休業 ${idle} か月）。`
        : `${closed[0]!.month} を締めました。`,
    );
  } else if (Object.keys(history.baseline).length === 0 && store.dashboard.sessions.length > 0) {
    // 初回。今いるセッションを月初の基準にする
    for (const emp of store.dashboard.sessions) {
      history.baseline[emp.id] = {
        tasksCompleted: emp.stats.tasksCompleted,
        tasksFailed: emp.stats.tasksFailed,
        tokensIn: emp.stats.totalTokensIn,
        tokensOut: emp.stats.totalTokensOut,
      };
    }
    persistence.saveHistory(history);
  }

  // 使用量の取得。導入されている CLI のぶんだけ
  const probes: UsageProbe[] = [];
  if (drivers.claude) probes.push(new ClaudeUsageProbe());
  if (drivers.codex) probes.push(new CodexUsageProbe());
  const usage = new UsageMonitor({ probes, store });

  const detachAutosave = attachAutosave({ store, persistence });
  persistence.saveDashboard(store.dashboard, now());

  return {
    config,
    history,
    persistence,
    store,
    manager,
    locks,
    workspace,
    monitor,
    recovery,
    usage,
    warnings,
    availableKinds: Object.keys(drivers) as AgentKind[],
    detachAutosave,
  };
}

/** 設定ファイルが無ければ既定値で作る。初回起動用。 */
export function ensureConfig(root: string): DashboardConfig {
  const persistence = new Persistence(root);
  const path = `${root}/config.json`;
  if (!existsSync(path)) {
    const config = defaultConfig();
    persistence.saveConfig(config);
    return config;
  }
  return persistence.loadConfig();
}
