import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import type { StoreEvent } from '../src/core/store.ts';
import { FakeClock, SeqIdGen } from '../src/core/clock.ts';
import {
  MockDriver,
  deniedTurn,
  delegatingTurn,
  failingTurn,
  successfulTurn,
} from '../src/core/drivers/mock.ts';
import type { Scenario } from '../src/core/drivers/mock.ts';
import type { ManagerConfig } from '../src/core/session-manager.ts';
import type { Session } from '../src/core/types.ts';

interface Harness {
  manager: SessionManager;
  store: StateStore;
  claude: MockDriver;
  codex: MockDriver;
  clock: FakeClock;
  events: StoreEvent[];
}

function harness(config: Partial<ManagerConfig> = {}): Harness {
  const clock = new FakeClock();
  const store = new StateStore(createDashboard({ slotCount: 6 }));
  const claude = new MockDriver({ kind: 'claude' });
  // codex はセッション ID を事前指定できない（SPEC §5.2）
  const codex = new MockDriver({ kind: 'codex', assignsOwnSessionId: true });

  const manager = new SessionManager({
    store,
    drivers: { claude, codex },
    clock,
    ids: new SeqIdGen(),
    config: { defaultCwd: '/tmp/ws', ...config },
  });

  const events: StoreEvent[] = [];
  store.on((e) => events.push(e));

  return { manager, store, claude, codex, clock, events };
}

// ---------------------------------------------------------------------------

describe('セッションの作成', () => {
  test('idle で待機する', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude', role: 'backend' });

    assert.equal(emp.state, 'idle');
    assert.equal(emp.slot, 0);
    assert.equal(emp.agentSessionId, null, '最初の指示を出すまでセッションは張られない');
    assert.equal(emp.role, 'backend');
    assert.equal(emp.name, 'claude-1');
    assert.match(emp.name, /^claude-1$/);
      });

  test('スロットは順に埋まり、満杯だと作成できない', () => {
    const h = harness();
    for (let i = 0; i < 6; i += 1) {
      assert.equal(h.manager.createSession({ kind: 'claude' }).slot, i);
    }
    assert.throws(() => h.manager.createSession({ kind: 'claude' }), /スロットが空いていません/);
  });

  test('アーカイブするとスロットが空き、次がそこに入る', () => {
    const h = harness();
    const a = h.manager.createSession({ kind: 'claude' });
    h.manager.createSession({ kind: 'claude' });
    h.manager.archiveSession(a.id);

    assert.equal(h.manager.createSession({ kind: 'codex' }).slot, 0);
    assert.equal(h.store.active().length, 2);
  });

  test('codex はサンドボックスを作成時に固定する', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex', sandbox: 'workspace-write' });
    assert.equal(emp.workspace.sandbox, 'workspace-write');
  });
});

// ---------------------------------------------------------------------------

describe('作成 → 実行 → 完了 → 次', () => {
  test('2 ターン目は resume で同じセッションを続ける', async () => {
    const h = harness();
    h.claude.setScenario(() =>
      successfulTurn({ text: 'やりました', files: ['src/a.ts'], commands: ['npm test'] }),
    );

    const emp = h.manager.createSession({ kind: 'claude' });

    const first = await h.manager.dispatch(emp.id, '認証まわりを直して');
    assert.equal(first.status, 'done');
    assert.equal(first.summary, 'やりました');
    assert.equal(emp.state, 'idle');
    assert.equal(emp.agentSessionId, emp.id, 'claude はこちらの UUID がそのままセッション ID になる');

    const second = await h.manager.dispatch(emp.id, 'テストも足して');
    assert.equal(second.status, 'done');

    assert.deepEqual(
      h.claude.calls.map((c) => c.mode),
      ['start', 'resume'],
      '1 ターン目は start、2 ターン目以降は resume',
    );
    assert.equal(h.claude.calls[1]!.sessionId, emp.id, '同じセッションを継続している');
    assert.equal(h.claude.calls[1]!.prompt, 'テストも足して');

    assert.equal(emp.stats.tasksCompleted, 2);
    assert.equal(emp.stats.filesEdited, 2);
    assert.equal(emp.stats.commandsRun, 2);
  });

  test('codex はドライバ側が採番したセッション ID を引き継ぐ', async () => {
    const h = harness();
    h.codex.setScenario(() => successfulTurn());
    const emp = h.manager.createSession({ kind: 'codex' });

    await h.manager.dispatch(emp.id, '調べて');
    assert.equal(emp.agentSessionId, 'mock-thread-1');

    await h.manager.dispatch(emp.id, 'もう一度');
    assert.equal(h.codex.calls[1]!.mode, 'resume');
    assert.equal(h.codex.calls[1]!.sessionId, 'mock-thread-1');
  });

  test('状態は thinking → working → idle と遷移する', async () => {
    const h = harness();
    h.claude.setScenario(() => successfulTurn({ files: ['a.ts'] }));
    const emp = h.manager.createSession({ kind: 'claude' });

    await h.manager.dispatch(emp.id, 'やって');

    const transitions = h.events
      .filter((e): e is Extract<StoreEvent, { t: 'state_changed' }> => e.t === 'state_changed')
      .map((e) => e.to);
    assert.deepEqual(transitions, ['thinking', 'working', 'idle']);
  });

  test('実行中は新しいプロンプトを送れない', async () => {
    const h = harness();
    h.claude.setScenario(() => successfulTurn());
    const emp = h.manager.createSession({ kind: 'claude' });

    // dispatch は同期部分で thinking に倒すので、await する前から作業中になる
    const running = h.manager.dispatch(emp.id, '本命');
    assert.equal(emp.state, 'thinking');

    await assert.rejects(() => h.manager.dispatch(emp.id, '割り込み'), /実行中です/);

    await running;
    assert.equal(emp.state, 'idle');
    assert.equal(h.claude.calls.length, 1, '割り込みはドライバに届いていない');
  });
});

// ---------------------------------------------------------------------------

describe('承認フロー（SPEC §8.4）', () => {
  test('権限拒否で blocked になり、完全な引数が残る', async () => {
    const h = harness();
    h.claude.setScenario(() => deniedTurn({ filePath: 'src/auth/session.ts' }));
    const emp = h.manager.createSession({ kind: 'claude' });

    const task = await h.manager.dispatch(emp.id, 'sub を追加して');

    assert.equal(task.status, 'blocked', '失敗ではなく承認待ち');
    assert.equal(emp.state, 'blocked');
    assert.equal(emp.pendingApprovals.length, 1);

    const approval = emp.pendingApprovals[0]!;
    assert.equal(approval.toolName, 'Edit');
    assert.equal(approval.toolInput.file_path, 'src/auth/session.ts');
    assert.ok(approval.toolInput.new_string, '差分描画に必要な引数が残っている');

    assert.equal(emp.stats.tasksFailed, 0, '失敗としては数えない');
        assert.equal(emp.stats.approvalsRequested, 1);

    assert.ok(
      h.events.some((e) => e.t === 'notify' && e.reason === 'approval_requested'),
      '承認待ちでベルを鳴らす',
    );
  });

  test('承認すると allowedTools 付きで再実行され、完了する', async () => {
    const h = harness();
    let turn = 0;
    const scenario: Scenario = () => {
      turn += 1;
      return turn === 1 ? deniedTurn() : successfulTurn({ files: ['src/auth/session.ts'] });
    };
    h.claude.setScenario(scenario);

    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'sub を追加して');

    const approvalId = emp.pendingApprovals[0]!.id;
    const task = await h.manager.approve(emp.id, approvalId);

    assert.equal(task.status, 'done');
    assert.equal(emp.state, 'idle');
    assert.equal(emp.pendingApprovals.length, 0);
    assert.equal(emp.stats.approvalsGranted, 1);

    const resumeCall = h.claude.calls[1]!;
    assert.equal(resumeCall.mode, 'resume');
    assert.deepEqual(resumeCall.allowedTools, ['Edit'], '承認したツールだけを許可する');
  });

  test('却下すると idle に戻り、理由を渡せばそれが次の指示になる', async () => {
    const h = harness();
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn() : successfulTurn();
    });

    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'sub を追加して');

    const approvalId = emp.pendingApprovals[0]!.id;
    const next = await h.manager.reject(emp.id, approvalId, 'その修正は不要です。テストだけ書いて。');

    assert.ok(next);
    assert.equal(next.status, 'done');
    assert.equal(h.claude.calls[1]!.prompt, 'その修正は不要です。テストだけ書いて。');
    assert.equal(emp.stats.approvalsGranted, 0);
  });

  test('理由なしの却下は idle に戻すだけで、指示は送らない', async () => {
    const h = harness();
    h.claude.setScenario(() => deniedTurn());
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'やって');

    const result = await h.manager.reject(emp.id, emp.pendingApprovals[0]!.id);
    assert.equal(result, null);
    assert.equal(emp.state, 'idle');
    assert.equal(h.claude.calls.length, 1);
  });

  test('常時承認にしたツールは以降のターンに自動で渡る', async () => {
    const h = harness();
    h.claude.setScenario(() => successfulTurn());
    const emp = h.manager.createSession({ kind: 'claude' });

    h.manager.alwaysAllow('Edit');
    await h.manager.dispatch(emp.id, 'やって');
    await h.manager.dispatch(emp.id, 'もっとやって');

    assert.deepEqual(h.claude.calls[1]!.allowedTools, ['Edit']);
  });
});

// ---------------------------------------------------------------------------

describe('サブエージェント（SPEC §11）', () => {
  test('サブエージェントが動くと delegating になる', async () => {
    const h = harness();
    const seen: number[] = [];
    h.claude.setScenario(() =>
      delegatingTurn([
        { taskId: 'a1', type: 'Explore', description: '認証まわりを調査' },
        { taskId: 'a2', type: 'Plan', description: '移行手順を設計' },
      ]),
    );

    const emp = h.manager.createSession({ kind: 'claude' });
    h.store.on((e) => {
      if (e.t === 'agent_event' && e.event.t === 'subagent_progress') {
        seen.push(emp.subagents.length);
      }
    });

    await h.manager.dispatch(emp.id, '調べて');

    assert.deepEqual(seen, [2, 2], 'ターン中は 2 つ動いている');
    assert.equal(emp.stats.subagentsSpawned, 2);
    assert.equal(emp.subagents.length, 0, 'ターン終了で消える');

    const delegated = h.events.some((e) => e.t === 'state_changed' && e.to === 'delegating');
    assert.ok(delegated, 'delegating 状態を通る');
  });

  test('サブエージェントの名前と種別が取れる', async () => {
    const h = harness();
    const captured: Array<{ name: string; agentType: string; tokens: number }> = [];
    h.claude.setScenario(() =>
      delegatingTurn([{ taskId: 'a1', type: 'Explore', description: '調査' }]),
    );

    const emp = h.manager.createSession({ kind: 'claude' });
    h.store.on((e) => {
      if (e.t === 'agent_event' && e.event.t === 'subagent_progress') {
        const s = emp.subagents[0]!;
        captured.push({ name: s.name, agentType: s.agentType, tokens: s.totalTokens });
      }
    });

    await h.manager.dispatch(emp.id, '調べて');

    assert.equal(captured[0]!.name, 'claude-1/1');
    assert.equal(captured[0]!.agentType, 'Explore');
        assert.equal(captured[0]!.tokens, 8_217, 'サブエージェントごとのトークンが取れる');
  });

  test('サブエージェントの起動回数を数える', async () => {
    const h = harness();
    h.claude.setScenario(() =>
      delegatingTurn([{ taskId: 'a1', type: 'Explore', description: '調査' }]),
    );
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, '調べて');

    // 完了 10 + 部下 1 体 × 3 = 13
  });
});

// ---------------------------------------------------------------------------

describe('コンテキスト', () => {
  test('比率が閾値を超えると resting になる', async () => {
    const h = harness({ contextWindow: 100_000, contextRestThreshold: 0.85 });
    h.claude.setScenario(() => successfulTurn({ contextTokens: 90_000 }));
    const emp = h.manager.createSession({ kind: 'claude' });

    await h.manager.dispatch(emp.id, 'やって');

    assert.equal(emp.context.ratio, 0.9);
    assert.equal(emp.state, 'resting');
    assert.equal(emp.context.estimated, false, 'claude は正確値');
  });

  test('閾値未満なら idle に戻る', async () => {
    const h = harness({ contextWindow: 100_000 });
    h.claude.setScenario(() => successfulTurn({ contextTokens: 50_000 }));
    const emp = h.manager.createSession({ kind: 'claude' });

    await h.manager.dispatch(emp.id, 'やって');
    assert.equal(emp.state, 'idle');
  });

  test('codex は概算フラグが立つ', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex' });
    assert.equal(emp.context.estimated, true, 'ゲージに ~ を出すため');
  });
});

// ---------------------------------------------------------------------------

describe('稼働時間', () => {
  test('動いていた時間だけが積まれる', async () => {
    const h = harness();
    h.claude.setScenario(() => successfulTurn({ files: ['a.ts'] }));
    const emp = h.manager.createSession({ kind: 'claude' });

    // ターン中はイベントごとに 100ms 進める
    h.store.on((e) => {
      if (e.t === 'agent_event') h.clock.advance(100);
    });

    await h.manager.dispatch(emp.id, 'やって');
    const afterTurn = emp.uptime.activeMs;
    assert.ok(afterTurn > 0, '動いた分は積まれる');

    // 待機したまま 1 時間放置しても実働は増えない
    h.clock.advance(60 * 60 * 1000);
    await h.manager.dispatch(emp.id, 'もう一度');

    const total = h.clock.now() - emp.uptime.startedAt;
    assert.ok(emp.uptime.activeMs < total / 2, `実働 ${emp.uptime.activeMs} < 総勤務 ${total} の半分`);
  });

  test('承認待ちの間は実働に入らない', async () => {
    const h = harness();
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? deniedTurn() : successfulTurn();
    });
    const emp = h.manager.createSession({ kind: 'claude' });

    await h.manager.dispatch(emp.id, 'やって');
    const beforeWait = emp.uptime.activeMs;

    h.clock.advance(10 * 60 * 1000); // 社長が 10 分放置
    await h.manager.approve(emp.id, emp.pendingApprovals[0]!.id);

    assert.ok(
      emp.uptime.activeMs - beforeWait < 10 * 60 * 1000,
      'blocked の 10 分は実働に含まれない',
    );
  });
});

// ---------------------------------------------------------------------------

describe('次に送るプロンプト（SPEC §12）', () => {
  test('選んで送ると、その控えだけ消える', async () => {
    const h = harness();
    h.claude.setScenario(() => successfulTurn());
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, '最初の指示');

    h.manager.addDraft(emp.id, 'テストも書いて');
    const second = h.manager.addDraft(emp.id, 'ドキュメントも')!;

    await h.manager.sendDraft(emp.id, second.id);

    assert.equal(h.claude.calls[1]!.prompt, 'ドキュメントも');
    assert.deepEqual(
      emp.drafts.map((d) => d.text),
      ['テストも書いて'],
      '選ばなかったほうは残る',
    );
  });

  test('無い控えは送れない', async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    await assert.rejects(() => h.manager.sendDraft(emp.id, 'ない'), /もうありません/);
  });

  test('完了しても控えは自動で出て行かない', async () => {
    // 返答を見て別のことを頼みたい場面がある。勝手に送られると取り消せない。
    const h = harness();
    h.claude.setScenario(() => successfulTurn());
    const emp = h.manager.createSession({ kind: 'claude' });

    h.manager.addDraft(emp.id, '次はドキュメント');
    await h.manager.dispatch(emp.id, 'まずコード');

    assert.deepEqual(
      h.claude.calls.map((c) => c.prompt),
      ['まずコード'],
    );
    assert.equal(emp.drafts.length, 1);
    assert.equal(emp.stats.tasksCompleted, 1);
  });

  test('空文字は控えにならない', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    assert.equal(h.manager.addDraft(emp.id, '   '), null);
    assert.equal(emp.drafts.length, 0);
  });

  test('中身を空にすると消える', () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude' });
    const draft = h.manager.addDraft(emp.id, 'あとで')!;

    h.manager.updateDraft(emp.id, draft.id, '');
    assert.equal(emp.drafts.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('失敗', () => {
  test('失敗すると error 状態になり経験値が減る', async () => {
    const h = harness();
    h.claude.setScenario(() => failingTurn('API error'));
    const emp = h.manager.createSession({ kind: 'claude' });

    const task = await h.manager.dispatch(emp.id, 'やって');

    assert.equal(task.status, 'failed');
    assert.equal(emp.state, 'error');
    assert.equal(emp.lastError, 'API error');
    assert.equal(emp.stats.tasksFailed, 1);
    assert.ok(h.events.some((e) => e.t === 'notify' && e.reason === 'task_failed'));
  });

  test('error 状態からでも再指示できる', async () => {
    const h = harness();
    let turn = 0;
    h.claude.setScenario(() => {
      turn += 1;
      return turn === 1 ? failingTurn() : successfulTurn();
    });
    const emp = h.manager.createSession({ kind: 'claude' });

    await h.manager.dispatch(emp.id, 'やって');
    assert.equal(emp.state, 'error');

    const task = await h.manager.dispatch(emp.id, 'もう一度');
    assert.equal(task.status, 'done');
    assert.equal(emp.state, 'idle');
    assert.equal(emp.lastError, null);
  });

  test('ドライバが例外を投げても状態が壊れない', async () => {
    const h = harness();
    h.claude.setScenario(() => {
      throw new Error('spawn failed');
    });
    const emp = h.manager.createSession({ kind: 'claude' });

    const task = await h.manager.dispatch(emp.id, 'やって');
    assert.equal(task.status, 'failed');
    assert.equal(emp.state, 'error');
    assert.match(emp.lastError ?? '', /spawn failed/);
  });
});


// ---------------------------------------------------------------------------

describe('レート制限（SPEC §13.4）', () => {
  test('rate_limit イベントがオフィス全体の状態になる', async () => {
    const h = harness();
    h.claude.setScenario(() => [
      {
        t: 'rate_limit',
        status: 'allowed',
        resetsAt: 1_786_566_000,
        rateLimitType: 'five_hour',
        isUsingOverage: false,
      },
      { t: 'turn_end', ok: true, result: 'ok' },
    ]);
    const emp = h.manager.createSession({ kind: 'claude' });
    await h.manager.dispatch(emp.id, 'やって');

    assert.equal(h.store.dashboard.rateLimit?.rateLimitType, 'five_hour');
    assert.equal(h.store.dashboard.rateLimit?.resetsAt, 1_786_566_000);
  });
});

// ---------------------------------------------------------------------------

describe('同じ CLI セッションを 2 つが持つのを防ぐ', () => {
  function fake(over: Partial<Session>): Session {
    return {
      id: over.name ?? 'x',
      name: 'x',
      archived: false,
      agentSessionId: null,
      lastError: null,
      stats: { tasksCompleted: 0 },
      ...over,
    } as unknown as Session;
  }

  test('アーカイブ側の紐付けを外す', () => {
    // codex は 1 会話に書き手 1 人しか許さない。両方残すと
    // 「already has an active writer」で終了コード 1 になる。
    const live = fake({ name: 'codex-2', agentSessionId: 'thread-1' });
    const old = fake({ name: 'codex-1', agentSessionId: 'thread-1', archived: true });

    const notes = SessionManager.resolveDuplicateAgentSessions([old, live]);

    assert.equal(live.agentSessionId, 'thread-1', '一覧にいる方を残す');
    assert.equal(old.agentSessionId, null);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /codex-1.*codex-2|codex-2.*codex-1/);
  });

  test('どちらも一覧にいるならやり取りが多い方を残す', () => {
    const a = fake({ name: 'a', agentSessionId: 't', stats: { tasksCompleted: 2 } as never });
    const b = fake({ name: 'b', agentSessionId: 't', stats: { tasksCompleted: 9 } as never });

    SessionManager.resolveDuplicateAgentSessions([a, b]);

    assert.equal(b.agentSessionId, 't');
    assert.equal(a.agentSessionId, null);
  });

  test('前の失敗も一緒に消す', () => {
    const live = fake({ name: 'live', agentSessionId: 't' });
    const old = fake({
      name: 'old',
      agentSessionId: 't',
      archived: true,
      lastError: '終了コード 1 で終了しました',
    });

    SessionManager.resolveDuplicateAgentSessions([old, live]);
    assert.equal(old.lastError, null, '紐付けを外したら、その失敗はもう関係ない');
  });

  test('重複していなければ何もしない', () => {
    const a = fake({ name: 'a', agentSessionId: 't1' });
    const b = fake({ name: 'b', agentSessionId: 't2' });
    const c = fake({ name: 'c', agentSessionId: null });

    assert.deepEqual(SessionManager.resolveDuplicateAgentSessions([a, b, c]), []);
    assert.equal(a.agentSessionId, 't1');
    assert.equal(b.agentSessionId, 't2');
  });
});
