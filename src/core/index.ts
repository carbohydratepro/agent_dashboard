/** core の公開 API。UI（TUI / Web）はここだけを見る。 */

export type {
  AgentEvent,
  AgentKind,
  ApprovalRequest,
  ContextInfo,
  Session,
  SessionState,
  Dashboard,
  RateLimitInfo,
  Role,
  SessionStats,
  Subagent,
  Task,
  TaskStatus,
  Uptime,
  Workspace,
} from './types.ts';

export { ACTIVE_STATES, BUSY_STATES } from './types.ts';

export type { AgentDriver, StartOpts, TurnOpts } from './drivers/driver.ts';
export { MockDriver } from './drivers/mock.ts';
export type { Scenario, TurnContext } from './drivers/mock.ts';

export { ClaudeDriver } from './drivers/claude.ts';
export type { ClaudeDriverOptions } from './drivers/claude.ts';
export { CodexDriver } from './drivers/codex.ts';
export type { CodexDriverOptions } from './drivers/codex.ts';
export { ClaudeParser } from './drivers/claude-parser.ts';
export { CodexParser } from './drivers/codex-parser.ts';
export { childEnv, runProcess } from './drivers/process.ts';
export type { ProcEvent, RunOpts } from './drivers/process.ts';

export { NetworkMonitor, snapshotOf } from './network.ts';
export type {
  IfaceInfo,
  NetworkEvent,
  NetworkMonitorOptions,
  ReadInterfaces,
  Snapshot,
} from './network.ts';

export { RecoveryCoordinator, defaultRecoveryPrompt } from './recovery.ts';
export type {
  RecoveryCoordinatorDeps,
  RecoveryOptions,
  RecoveryReport,
} from './recovery.ts';

export { WorkspaceManager, occupiedMap } from './workspace.ts';
export type {
  ConflictChoice,
  PlanRequest,
  ReleaseResult,
  WorkspaceManagerOptions,
  WorkspacePlan,
} from './workspace.ts';

export { LockManager, lockFileName } from './locks.ts';
export type { LockHandle, LockInfo, LockManagerOptions } from './locks.ts';

export { systemGit, uncommittedChanges } from './git.ts';
export type { GitRunner, GitResult } from './git.ts';

export {
  ClaudeUsageProbe,
  CodexUsageProbe,
  labelForWindowMinutes,
  parseClaudeUsage,
  parseCodexRollout,
  parseResetTime,
  readTail,
} from './usage.ts';
export type { UsageProbe, UsageSnapshot, UsageWindow } from './usage.ts';
export { UsageMonitor } from './usage-monitor.ts';
export type { UsageMonitorOptions } from './usage-monitor.ts';

export {
  listExistingSessions,
  parseClaudeSession,
  parseCodexSession,
  readHead,
  toTitle,
} from './sessions.ts';
export type { ExistingSession, ListSessionsOptions } from './sessions.ts';

export { StateStore, createDashboard } from './store.ts';
export type { NotifyReason, StoreEvent } from './store.ts';

export { SessionManager } from './session-manager.ts';
export type {
  DispatchOpts,
  CreateOpts,
  InterruptReason,
  ManagerConfig,
  SessionManagerDeps,
} from './session-manager.ts';

export { FakeClock, Rng, SeqIdGen, systemClock, systemIdGen } from './clock.ts';
export type { Clock, IdGen } from './clock.ts';

export { createStats, tokensPerTask, utilization } from './stats.ts';

export { colorForSlot, nextName, ROLE_LABEL, ROLE_PROMPT, ROLES } from './naming.ts';
