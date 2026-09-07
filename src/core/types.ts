/**
 * ドメインモデル。CLI セッション 1 本を Session として扱う。
 * Node のネイティブ型ストリッピングで動かすため enum は使わない。
 */

export type AgentKind = 'claude' | 'codex';

export type SessionState =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'delegating'
  | 'blocked'
  | 'reconnecting'
  | 'error'
  | 'resting'
  | 'offline';

/** 稼働時間に算入する状態。blocked は承認待ちで止まっているだけなので含めない。 */
export const ACTIVE_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'thinking',
  'working',
  'delegating',
  'reconnecting',
]);

/** 新しいプロンプトを受け付けられない状態 */
export const BUSY_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'thinking',
  'working',
  'delegating',
  'reconnecting',
]);

/** システムプロンプトに追記する役割の型。見た目ではなく実挙動に効く。 */
export type Role = 'backend' | 'frontend' | 'infra' | 'research' | 'qa' | 'general';

export interface Draft {
  id: string;
  text: string;
  updatedAt: number;
}

export interface Workspace {
  requestedCwd: string;
  actualCwd: string;
  isolation: 'none' | 'worktree';
  branch: string | null;
  /** codex のみ。作成時に固定され resume では変更できない */
  sandbox: string | null;
}

/** 承認待ちの操作。claude の result.permission_denials[] から生成する。 */
export interface ApprovalRequest {
  id: string;
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  message: string;
  requestedAt: number;
  taskId: string;
}

/** サブエージェント。claude の system/task_* から生成する。 */
export interface Subagent {
  taskId: string;
  toolUseId: string;
  agentType: string;
  name: string;
  description: string;
  currentAction: string;
  lastToolName: string;
  totalTokens: number;
  toolUses: number;
  durationMs: number;
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;
  lastText: string;
}

export type TaskStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'blocked';

export interface Task {
  id: string;
  sessionId: string;
  prompt: string;
  startedAt: number;
  endedAt: number | null;
  status: TaskStatus;
  events: AgentEvent[];
  summary: string | null;
  recoveredFrom: string | null;
}

export interface ContextInfo {
  usedTokens: number;
  windowTokens: number;
  ratio: number;
  /** codex は常に true。ゲージに概算の印を出す。 */
  estimated: boolean;
  /** codex の差分計算用。累計トークンの前回値 */
  prevInputTokens: number;
  prevOutputTokens: number;
}

export interface Uptime {
  startedAt: number;
  activeMs: number;
  lastActiveAt: number;
}

export interface SessionStats {
  tasksCompleted: number;
  tasksFailed: number;
  tasksInterrupted: number;
  filesEdited: number;
  commandsRun: number;
  subagentsSpawned: number;
  approvalsRequested: number;
  approvalsGranted: number;
  reconnects: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface Recovery {
  attempts: number;
  lastError: string | null;
  interruptedTaskId: string | null;
  networkFingerprintAtStart: string | null;
}

export interface Session {
  id: string;
  /** CLI 側のセッション ID。--resume に渡す。 */
  agentSessionId: string | null;
  kind: AgentKind;
  /** 一覧での並び順 */
  slot: number;
  model: string | null;
  /** claude のみ。null なら CLI の既定に従う。 */
  permissionMode: string | null;

  /** 一覧に出す短い識別名（例 'claude-1'） */
  name: string;
  /** 一覧で見分けるための色。意味は持たない。 */
  color: string;
  role: Role;

  state: SessionState;
  currentTask: Task | null;
  subagents: Subagent[];
  pendingApprovals: ApprovalRequest[];

  workspace: Workspace;
  recovery: Recovery;

  /**
   * 次に送るプロンプトの控え。順番は持たない。
   * 送るのは選んで送ったときだけで、勝手には出て行かない。
   */
  drafts: Draft[];

  /**
   * まだ見ていない結果。ターンが終わると付き、会話を開くと消える。
   * 一覧を眺めているだけで「終わったもの」が拾えるようにするため。
   */
  unseenResult: 'done' | 'failed' | null;

  /** 思考量のライブ値。claude の thinking_tokens 由来。 */
  thinkingTokens: number;

  context: ContextInfo;
  uptime: Uptime;
  stats: SessionStats;

  lastError: string | null;
  archived: boolean;
}

export interface RateLimitInfo {
  status: string;
  /** 枠がリセットされる時刻（秒） */
  resetsAt: number;
  /** 'five_hour' など */
  rateLimitType: string;
  isUsingOverage: boolean;
  overageStatus?: string;
  overageResetsAt?: number;
}

export interface Dashboard {
  title: string;
  /** 並べるスロット数 */
  slotCount: number;
  sessions: Session[];
  /** claude の rate_limit_event 由来 */
  rateLimit: RateLimitInfo | null;
}

// ---------------------------------------------------------------------------
// ドライバが正規化して吐く共通イベント
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { t: 'session_started'; sessionId: string; model: string }
  | { t: 'requesting' }
  | { t: 'thinking'; estimatedTokens: number }
  | { t: 'text'; delta: string; parentToolUseId?: string }
  | {
      t: 'tool_start';
      name: string;
      detail: string;
      toolUseId: string;
      parentToolUseId?: string;
    }
  | {
      t: 'tool_end';
      name: string;
      ok: boolean;
      toolUseId: string;
      parentToolUseId?: string;
    }
  | {
      t: 'subagent_start';
      taskId: string;
      toolUseId: string;
      agentType: string;
      description: string;
    }
  | {
      t: 'subagent_progress';
      taskId: string;
      description: string;
      lastToolName: string;
      totalTokens: number;
      toolUses: number;
      durationMs: number;
    }
  | { t: 'subagent_end'; taskId: string; ok: boolean; summary: string }
  | { t: 'file_edited'; path: string; kind: 'add' | 'update' | 'delete' }
  | { t: 'command_run'; cmd: string; exitCode: number | null }
  | {
      t: 'permission_denied';
      toolName: string;
      toolUseId: string;
      toolInput: Record<string, unknown>;
      message: string;
    }
  | {
      t: 'usage';
      contextTokens: number;
      estimated: boolean;
      /** このターンで消費した分（累計ではない） */
      inputTokens: number;
      outputTokens: number;
      /** codex のみ。次ターンの差分計算のために持ち回す。 */
      cumulativeInputTokens?: number;
      cumulativeOutputTokens?: number;
    }
  | {
      t: 'rate_limit';
      status: string;
      resetsAt: number;
      rateLimitType: string;
      isUsingOverage: boolean;
      overageStatus?: string;
      overageResetsAt?: number;
    }
  | { t: 'turn_end'; ok: boolean; result: string }
  | { t: 'error'; message: string };
