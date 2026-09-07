/** テストとデモで使う見本のダッシュボード。 */

import { SessionManager } from '../../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../../src/core/store.ts';
import { MockDriver } from '../../src/core/drivers/mock.ts';
import { SeqIdGen, FakeClock } from '../../src/core/clock.ts';
import type { Dashboard, Session } from '../../src/core/types.ts';

export const FIXTURE_NOW = 1_700_003_600_000;

export function sampleDashboard(): Dashboard {
  const clock = new FakeClock(FIXTURE_NOW - 4_400_000);
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const manager = new SessionManager({
    store,
    drivers: {
      claude: new MockDriver({ kind: 'claude' }),
      codex: new MockDriver({ kind: 'codex' }),
    },
    clock,
    ids: new SeqIdGen(),
    config: { defaultCwd: '/home/dev/project' },
  });

  const a = manager.createSession({ kind: 'codex', role: 'backend' });
  const b = manager.createSession({ kind: 'claude', role: 'frontend' });
  const c = manager.createSession({ kind: 'claude', role: 'qa', cwd: '/home/dev/api' });

  decorate(a, {
    state: 'working',
    ratio: 0.78,
    estimated: true,
    activeMs: 2_700_000,
    tasks: 16,
    edits: 36,
    commands: 80,
    tokens: 420_000,
    worktree: 'vo/codex-1',
  });
  decorate(b, {
    state: 'delegating',
    ratio: 0.42,
    activeMs: 900_000,
    tasks: 8,
    edits: 12,
    commands: 40,
    tokens: 180_000,
  });
  decorate(c, {
    state: 'idle',
    ratio: 0.12,
    activeMs: 120_000,
    tasks: 2,
    edits: 1,
    commands: 6,
    tokens: 24_000,
    draft: 'テストを追加してからドキュメントも更新する',
  });

  a.currentTask = {
    id: 'task-14',
    sessionId: a.id,
    prompt: '認証まわりのリファクタ',
    startedAt: FIXTURE_NOW - 252_000,
    endedAt: null,
    status: 'running',
    events: [
      { t: 'tool_start', name: 'Edit', detail: 'src/auth/session.ts', toolUseId: 't1' },
      { t: 'tool_start', name: 'Bash', detail: 'npm test -- auth', toolUseId: 't2' },
    ],
    summary: null,
    recoveredFrom: null,
  };

  b.subagents = [
    {
      taskId: 'a1',
      toolUseId: 'tu1',
      agentType: 'Explore',
      name: 'claude-2/1',
      description: '認証の周辺コードを調査',
      currentAction: 'src/auth 配下を確認',
      lastToolName: 'Bash',
      totalTokens: 8_217,
      toolUses: 3,
      durationMs: 3_768,
      startedAt: FIXTURE_NOW - 4_000,
      status: 'running',
      summary: null,
      lastText: '',
    },
  ];

  store.dashboard.rateLimit = {
    status: 'allowed',
    resetsAt: Math.floor(FIXTURE_NOW / 1000) + 8_040,
    rateLimitType: 'five_hour',
    isUsingOverage: false,
  };

  return store.dashboard;
}

interface Decoration {
  state: Session['state'];
  ratio: number;
  estimated?: boolean;
  activeMs: number;
  tasks: number;
  edits: number;
  commands: number;
  tokens: number;
  draft?: string;
  worktree?: string;
}

function decorate(session: Session, d: Decoration): void {
  session.state = d.state;
  session.context.ratio = d.ratio;
  session.context.usedTokens = Math.round(d.ratio * session.context.windowTokens);
  session.context.estimated = d.estimated ?? session.kind === 'codex';
  session.stats.tasksCompleted = d.tasks;
  session.stats.filesEdited = d.edits;
  session.stats.commandsRun = d.commands;
  session.stats.totalTokensIn = Math.round(d.tokens * 0.9);
  session.stats.totalTokensOut = Math.round(d.tokens * 0.1);
  session.uptime.activeMs = d.activeMs;
  if (d.draft) session.drafts = [{ id: `draft-${session.id}`, text: d.draft, updatedAt: 0 }];
  if (d.worktree) {
    session.workspace.isolation = 'worktree';
    session.workspace.branch = d.worktree;
    session.workspace.actualCwd = `/home/dev/.agent-dashboard/worktrees/${session.id}`;
  }
}
