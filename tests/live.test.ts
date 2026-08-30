/**
 * 実 CLI との統合テスト。フェーズ 2 の完了条件そのもの。
 *
 * 実行には課金と時間がかかるので、既定ではスキップする:
 *   VO_LIVE=1 node --test tests/live.test.ts
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { bootstrap } from '../src/core/bootstrap.ts';
import { NetworkMonitor } from '../src/core/network.ts';
import { listExistingSessions } from '../src/core/sessions.ts';
import { ClaudeUsageProbe } from '../src/core/usage.ts';
import { RecoveryCoordinator } from '../src/core/recovery.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { decodeKeys } from '../src/tui/input.ts';
import { displayWidth } from '../src/tui/width.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import { ClaudeDriver } from '../src/core/drivers/claude.ts';
import { CodexDriver } from '../src/core/drivers/codex.ts';
import type { AgentEvent, SessionState } from '../src/core/types.ts';

const LIVE = process.env.VO_LIVE === '1';
const TURN_TIMEOUT = 300_000;

let workspace = '';

function setupWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vo-live-'));
  writeFileSync(join(dir, 'calc.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(dir, 'README.md'), '# live test workspace\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync(
    'git',
    ['-c', 'user.email=t@local', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    { cwd: dir },
  );
  return dir;
}

interface Harness {
  manager: SessionManager;
  store: StateStore;
  states: SessionState[];
  events: AgentEvent[];
  rawLines: number;
}

function harness(): Harness {
  const store = new StateStore(createDashboard());
  const manager = new SessionManager({
    store,
    drivers: { claude: new ClaudeDriver(), codex: new CodexDriver() },
    config: { defaultCwd: workspace },
  });

  const h: Harness = { manager, store, states: [], events: [], rawLines: 0 };
  store.on((e) => {
    if (e.t === 'state_changed') h.states.push(e.to);
    if (e.t === 'agent_event') h.events.push(e.event);
  });
  return h;
}

before(() => {
  if (LIVE) workspace = setupWorkspace();
});

after(() => {
  if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('実 claude CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('マルチターンの会話が成立する', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'claude', role: 'backend' });

    const first = await h.manager.dispatch(
      emp.id,
      'calc.js を読んで、定義されている関数名だけを一行で答えて。',
    );

    assert.equal(first.status, 'done', `1 ターン目が失敗: ${first.summary}`);
    assert.equal(emp.agentSessionId, emp.id, 'こちらが採番した UUID がセッション ID になる');
    assert.match(first.summary ?? '', /add/);
    assert.ok(emp.stats.commandsRun >= 0);
    assert.ok(emp.context.usedTokens > 0, '文脈サイズが取れている');
    assert.equal(emp.context.estimated, false, 'claude は正確値');
    assert.ok(emp.context.ratio > 0 && emp.context.ratio < 1);

    const ctxAfterFirst = emp.context.usedTokens;

    const second = await h.manager.dispatch(
      emp.id,
      'さっき読んだファイル名と関数名を答えて。ファイルは読み直さないこと。',
    );

    assert.equal(second.status, 'done', `2 ターン目が失敗: ${second.summary}`);
    assert.match(second.summary ?? '', /calc\.js/, '前ターンの文脈を保持している');
    assert.match(second.summary ?? '', /add/);
    assert.ok(
      emp.context.usedTokens > ctxAfterFirst,
      `文脈が増えている: ${ctxAfterFirst} → ${emp.context.usedTokens}`,
    );

    assert.equal(emp.state, 'idle');
    assert.equal(emp.stats.tasksCompleted, 2);
    assert.ok(h.states.includes('thinking'));
  });

  test('承認フローが実 CLI で一周する', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    // 権限モードを manual にして、確実に拒否を起こす
    const emp = h.manager.createSession({ kind: 'claude', permissionMode: 'manual' });

    const denied = await h.manager.dispatch(emp.id, 'calc.js に mul 関数を追加して。');

    assert.equal(denied.status, 'blocked', `承認待ちにならなかった: ${denied.summary}`);
    assert.equal(emp.state, 'blocked');
    assert.equal(emp.pendingApprovals.length, 1);

    const approval = emp.pendingApprovals[0]!;
    assert.ok(['Edit', 'Write'].includes(approval.toolName));
    assert.ok(approval.toolInput.file_path, '承認書に対象ファイルが載る');
    assert.equal(
      readFileSync(join(workspace, 'calc.js'), 'utf8').includes('mul'),
      false,
      '拒否された時点ではファイルは変わっていない',
    );

    const approved = await h.manager.approve(emp.id, approval.id);

    assert.equal(approved.status, 'done', `承認後の再実行が失敗: ${approved.summary}`);
    assert.equal(emp.state, 'idle');
    assert.equal(emp.pendingApprovals.length, 0);
    assert.ok(
      readFileSync(join(workspace, 'calc.js'), 'utf8').includes('mul'),
      '承認後にファイルが実際に変更される',
    );
    assert.equal(emp.stats.approvalsRequested, 1);
    assert.equal(emp.stats.approvalsGranted, 1);
  });
});

// ---------------------------------------------------------------------------

describe('実 codex CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('マルチターンの会話が成立し、文脈を概算できる', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    const emp = h.manager.createSession({ kind: 'codex', sandbox: 'read-only' });

    const first = await h.manager.dispatch(
      emp.id,
      'README.md を読んで、見出しの文字列だけを一行で答えて。',
    );

    assert.equal(first.status, 'done', `1 ターン目が失敗: ${first.summary}`);
    assert.ok(emp.agentSessionId, 'thread_id をセッション ID として拾えている');
    assert.equal(emp.context.estimated, true, 'codex は概算');
    assert.ok(emp.context.usedTokens > 0);
    assert.ok(emp.context.prevInputTokens > 0, '次ターンの差分計算用に累計を持ち回す');

    const ctxAfterFirst = emp.context.usedTokens;
    const sessionId = emp.agentSessionId;

    const second = await h.manager.dispatch(
      emp.id,
      'いま答えた見出しをもう一度言って。ファイルは読み直さないこと。',
    );

    assert.equal(second.status, 'done', `2 ターン目が失敗: ${second.summary}`);
    assert.equal(emp.agentSessionId, sessionId, '同じスレッドを継続している');

    // 連続するターンで概算値が大きくぶれないこと（推定式の妥当性）
    const drift = Math.abs(emp.context.usedTokens - ctxAfterFirst) / ctxAfterFirst;
    assert.ok(
      drift < 0.5,
      `文脈の概算が安定している: ${ctxAfterFirst} → ${emp.context.usedTokens}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('会話モードと実 CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('画面から指示を出して応答が履歴に並ぶ', { timeout: TURN_TIMEOUT }, async () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { claude: new ClaudeDriver(), codex: new CodexDriver() },
      config: { defaultCwd: workspace },
    });
    const term = new FakeTerminal(110, 36);
    const app = new App({ manager, terminal: term, animate: false, bell: false });
    app.start();

    const press = (...raws: string[]): void => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    };
    const view = (): string => {
      app.render();
      return app.screen.toStrings().join('\n');
    };

    const emp = manager.createSession({ kind: 'claude', name: 'ミナ' });

    // 会話モードに入って指示を打ち、Enter で送る
    press('\r');
    assert.equal(app.screenId, 'conversation');
    press('calc.js を読んで、定義されている関数名だけを一行で答えて。');
    press('\r');

    // ターンが閉じるまで待つ
    for (let i = 0; i < 300 && manager.isRunning(emp.id); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await manager.awaitTurn(emp.id);

    const text = view();
    assert.ok(text.includes('calc.js を読んで'), '社長の指示が履歴にある');
    assert.ok(/add/.test(text), `モデルの出力が出る:\n${text}`);
    assert.equal(emp.stats.tasksCompleted, 1);

    // 2 ターン目。文脈が引き継がれる
    press('さっき答えた関数名をもう一度。ファイルは読み直さないこと。');
    press('\r');
    for (let i = 0; i < 300 && manager.isRunning(emp.id); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await manager.awaitTurn(emp.id);

    assert.equal(emp.stats.tasksCompleted, 2);
    assert.equal(emp.agentSessionId, emp.id, '同じセッションを続けている');
    app.stop();
  });
});

// ---------------------------------------------------------------------------

describe('承認 UI と実 CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('画面から承認するとファイルが実際に変わる', { timeout: TURN_TIMEOUT }, async () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { claude: new ClaudeDriver() },
      config: { defaultCwd: workspace },
    });
    const term = new FakeTerminal(110, 36);
    const app = new App({ manager, terminal: term, animate: false, bell: false });
    app.start();

    const press = (...raws: string[]): void => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    };
    const view = (): string => {
      app.render();
      return app.screen.toStrings().join('\n');
    };
    const waitIdle = async (id: string): Promise<void> => {
      for (let i = 0; i < 300 && manager.isRunning(id); i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
      await manager.awaitTurn(id);
    };

    const emp = manager.createSession({ kind: 'claude', permissionMode: 'manual' });

    press('\r');
    press('calc.js に div 関数を追加して。');
    press('\r');
    await waitIdle(emp.id);

    assert.equal(emp.state, 'blocked', `承認待ちにならなかった: ${emp.currentTask?.summary}`);
    assert.equal(app.screenId, 'conversation');

    // 一覧に戻ると承認待ちの印が立つ
    press('\x1b');
    assert.ok(view().includes('承認待ち 1 件'), '詳細に承認待ちが出る');

    // Enter で承認画面を開く
    press('\r');
    assert.equal(app.screenId, 'approval');
    const sheet = view();
    assert.ok(sheet.includes('承認待ち'), sheet);
    assert.ok(/div/.test(sheet), `やろうとした内容が差分で見える:\n${sheet}`);

    const before = readFileSync(join(workspace, 'calc.js'), 'utf8');
    assert.equal(before.includes('div'), false, '承認前は変わっていない');

    // y で承認 → 再実行
    press('y');
    await new Promise((r) => setTimeout(r, 200));
    await waitIdle(emp.id);

    const after = readFileSync(join(workspace, 'calc.js'), 'utf8');
    assert.ok(after.includes('div'), `承認後に実際に変更される:\n${after}`);
    assert.equal(emp.pendingApprovals.length, 0);
    assert.equal(emp.stats.approvalsGranted, 1);
    app.stop();
  });
});

// ---------------------------------------------------------------------------

describe('落として立ち上げ直す（SPEC §14）', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('再起動しても実 CLI の会話が続く', { timeout: TURN_TIMEOUT }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'vo-home-'));
    try {
      // --- 1 回目の起動 ---
      const first = await bootstrap({ root: home, cwd: workspace });
      const emp = first.manager.createSession({ kind: 'claude', role: 'backend' });
      const t1 = await first.manager.dispatch(
        emp.id,
        'calc.js を読んで、定義されている関数名だけを一行で答えて。',
      );
      assert.equal(t1.status, 'done', `1 回目が失敗: ${t1.summary}`);

      const agentSessionId = emp.agentSessionId;
      const createdId = emp.id;
      const completed = emp.stats.tasksCompleted;
      first.manager.setNextPrompt(emp.id, '次はテストを書いて');
      first.detachAutosave();

      // --- ここでアプリが落ちる ---

      // --- 2 回目の起動 ---
      const second = await bootstrap({ root: home, cwd: workspace });
      const restored = second.store.active()[0]!;

      assert.equal(restored.id, createdId, '同じセッションが戻る');
      assert.equal(restored.agentSessionId, agentSessionId, '会話への紐が残っている');
      assert.equal(restored.state, 'offline');
      assert.equal(restored.nextPrompt, '次はテストを書いて', 'メモも残る');
      assert.equal(restored.stats.tasksCompleted, completed);
      assert.equal(restored.name, emp.name);

      // 前回の会話を覚えているか、実 CLI に聞く
      const t2 = await second.manager.dispatch(
        restored.id,
        'さっき答えた関数名をもう一度。ファイルは読み直さないこと。',
      );

      assert.equal(t2.status, 'done', `2 回目が失敗: ${t2.summary}`);
      assert.match(t2.summary ?? '', /add/, `再起動をまたいで文脈が続く: ${t2.summary}`);
      assert.equal(restored.stats.tasksCompleted, completed + 1);

      // 履歴もディスクから読める
      const history = second.persistence.loadTasks(createdId);
      assert.equal(history.length, 2);
      assert.match(history[0]!.prompt, /calc\.js/);
      second.detachAutosave();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('ネットワーク復帰の実機確認（SPEC §10）', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('本物のインターフェースから安定した指紋が出る', () => {
    const monitor = new NetworkMonitor({ stabilizeMs: 10 });
    const before = monitor.fingerprint;
    assert.equal(monitor.online, true, 'このマシンはオンライン');
    for (let i = 0; i < 10; i += 1) monitor.tick();
    assert.equal(monitor.fingerprint, before, '何も変えていないのに変化を報告しない');
  });

  test('実 CLI のターンを途中で切って復帰させても二重に実行しない', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    const monitor = new NetworkMonitor({ stabilizeMs: 10 });
    const recovery = new RecoveryCoordinator({
      store: h.store,
      manager: h.manager,
      monitor,
      options: { maxRetries: 2, backoffMs: [500, 1_000] },
    });

    const emp = h.manager.createSession({ kind: 'claude', permissionMode: 'acceptEdits' });

    // わざと少し長い作業をさせる
    const running = h.manager.dispatch(
      emp.id,
      'calc.js を読んでから sub 関数を追加して、追加後にもう一度ファイル全体を読んで内容を報告して。',
    );

    // ツールを使い始めるまで待ってから、回線が切れたことにする
    for (let i = 0; i < 120; i += 1) {
      if (emp.state === 'working' || emp.state === 'delegating') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(
      ['thinking', 'working', 'delegating'].includes(emp.state),
      `作業中に切れる状況を作れなかった: ${emp.state}`,
    );

    const report = await recovery.recover();
    const interrupted = (await running) as { status: string };

    assert.equal(interrupted.status, 'interrupted', '中断として閉じる');
    assert.equal(emp.stats.tasksInterrupted, 1);
    assert.equal(emp.stats.tasksFailed, 0, 'セッションの失敗にはしない');
    assert.deepEqual(report.failed, [], `復帰に失敗した: ${emp.recovery.lastError}`);
    assert.deepEqual(report.ok, [emp.id]);
    assert.equal(emp.stats.reconnects, 1);
    assert.equal(emp.state, 'idle');

    // 中断前後で sub が二重に足されていないこと（SPEC §10.5 の狙い）
    const content = readFileSync(join(workspace, 'calc.js'), 'utf8');
    const occurrences = content.match(/function sub\b/g)?.length ?? 0;
    assert.equal(occurrences, 1, `sub が ${occurrences} 個ある。二重実行が起きている:\n${content}`);
  });
});

// ---------------------------------------------------------------------------

describe('サブエージェント演出と実 CLI（SPEC §11）', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('実際に部下が登場して報告して退場する', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    const seen: Array<{ count: number; type: string; tokens: number; tool: string }> = [];
    let sawDelegating = false;

    h.store.on((e) => {
      if (e.t === 'state_changed' && e.to === 'delegating') sawDelegating = true;
    });

    const emp = h.manager.createSession({ kind: 'claude' });
    h.store.on(() => {
      const sub = emp.subagents[0];
      if (sub) {
        seen.push({
          count: emp.subagents.length,
          type: sub.agentType,
          tokens: sub.totalTokens,
          tool: sub.lastToolName,
        });
      }
    });

    const task = await h.manager.dispatch(
      emp.id,
      'Task ツールで Explore エージェントを 1 体起動し、このディレクトリのファイル一覧と各ファイルの行数を調べさせて。結果を報告して。',
    );

    assert.equal(task.status, 'done', `失敗: ${task.summary}`);
    assert.ok(sawDelegating, '部下を使っている間は delegating になる');
    assert.ok(emp.stats.subagentsSpawned >= 1, `部下の起動が数えられている: ${emp.stats.subagentsSpawned}`);
    assert.deepEqual(emp.subagents, [], 'ターンが終われば退場する');

    assert.ok(seen.length > 0, '部下が席にいる瞬間を観測できた');
    const withProgress = seen.filter((s) => s.tokens > 0);
    assert.ok(withProgress.length > 0, `部下ごとのトークンが取れる: ${JSON.stringify(seen.slice(0, 3))}`);
    assert.ok(withProgress.some((s) => s.tool !== ''), '部下が使っているツール名が取れる');
    assert.equal(seen[0]!.type.length > 0, true, `職種が取れる: ${seen[0]!.type}`);
  });
});

// ---------------------------------------------------------------------------

describe('既存セッションの取り込み', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('端末で始めた会話を引き継いで続けられる', { timeout: TURN_TIMEOUT }, async () => {
    // まず「オフィスの外で始まった会話」を用意する
    const outside = mkdtempSync(join(tmpdir(), 'vo-outside-'));
    writeFileSync(join(outside, 'memo.txt'), 'あいことばは ミカン です。\n');

    try {
      execFileSync(
        'claude',
        [
          '-p',
          'memo.txt を読んで、書かれているあいことばを覚えておいて。答えは一言でよい。',
          '--output-format',
          'json',
        ],
        { cwd: outside, stdio: 'pipe', env: { ...process.env, CLAUDECODE: '' }, timeout: 180_000 },
      );

      // 一覧に出てくるか
      const sessions = listExistingSessions({ limit: 60 });
      const found = sessions.find((s) => s.cwd === outside && s.kind === 'claude');
      assert.ok(found, `外で始めた会話が一覧に出る: ${sessions.slice(0, 3).map((s) => s.cwd).join(', ')}`);
      assert.ok(found.sessionId.length > 10);
      assert.notEqual(found.title, '', '見出しが付く');

      // 取り込みして、続きを聞く
      const h = harness();
      const emp = h.manager.createSession({
        kind: 'claude',
        cwd: found.cwd,
        agentSessionId: found.sessionId,
      });
      assert.equal(emp.agentSessionId, found.sessionId);

      const task = await h.manager.dispatch(
        emp.id,
        'さっき覚えたあいことばを答えて。ファイルは読み直さないこと。',
      );

      assert.equal(task.status, 'done', `引き継ぎに失敗: ${task.summary}`);
      assert.match(
        task.summary ?? '',
        /ミカン/,
        `オフィスの外で始まった会話の続きになっている: ${task.summary}`,
      );
      assert.equal(emp.stats.tasksCompleted, 1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------

describe('マークダウンの表示と実 CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('実際の応答が記法のまま出ない', { timeout: TURN_TIMEOUT }, async () => {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const manager = new SessionManager({
      store,
      drivers: { claude: new ClaudeDriver() },
      config: { defaultCwd: workspace },
    });
    const term = new FakeTerminal(110, 40);
    const app = new App({ manager, terminal: term, animate: false, bell: false });
    app.start();

    const press = (...raws: string[]): void => {
      for (const raw of raws) for (const k of decodeKeys(raw)) app.handleKey(k);
    };
    const view = (): string => {
      app.render();
      return app.screen.toStrings().join('\n');
    };

    const session = manager.createSession({ kind: 'claude' });
    press('\r');
    press(
      'calc.js の関数を、見出し・箇条書き・表・コードブロックを使ったマークダウンで説明して。',
    );
    press('\r');

    for (let i = 0; i < 300 && manager.isRunning(session.id); i += 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
    await manager.awaitTurn(session.id);

    const text = view();
    assert.match(text, /add/, `応答が出ている:\n${text}`);

    // 記法がそのまま残っていないこと
    assert.equal(/\*\*[^*\n]+\*\*/.test(text), false, `太字の記号が残っている:\n${text}`);
    assert.equal(/^\s*#{1,6}\s/m.test(text), false, `見出しの記号が残っている:\n${text}`);
    assert.equal(/^\s*\|[-\s|:]+\|\s*$/m.test(text), false, `表の区切り記法が残っている:\n${text}`);
    assert.equal(/```/.test(text), false, `コードフェンスが残っている:\n${text}`);

    // どの行も画面幅に収まる
    for (const row of app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 110, `はみ出し: ${row}`);
    }
    app.stop();
  });
});

// ---------------------------------------------------------------------------

describe('スラッシュコマンドと実 CLI', { skip: !LIVE && 'VO_LIVE=1 のときだけ実行する' }, () => {
  test('コマンド一覧が使用量の取得と一緒に届く', { timeout: TURN_TIMEOUT }, async () => {
    const probe = new ClaudeUsageProbe();
    const snapshot = await probe.fetch();

    assert.equal(snapshot.error, null);
    assert.ok(snapshot.slashCommands, 'コマンド一覧が取れる');
    assert.ok(snapshot.slashCommands.length > 10, `件数: ${snapshot.slashCommands.length}`);
    assert.ok(snapshot.slashCommands.includes('usage'));
    assert.ok(snapshot.slashCommands.includes('context'));
    assert.ok(Array.isArray(snapshot.terminalOnlyCommands));
  });

  test('画面から送ったコマンドが CLI で処理される', { timeout: TURN_TIMEOUT }, async () => {
    const h = harness();
    const session = h.manager.createSession({ kind: 'claude' });

    // まず 1 ターン走らせて会話を作る
    const first = await h.manager.dispatch(session.id, 'calc.js の関数名だけ一行で答えて。');
    assert.equal(first.status, 'done', `準備のターンが失敗: ${first.summary}`);

    // そのセッションにスラッシュコマンドを送る
    const task = await h.manager.dispatch(session.id, '/context');

    assert.equal(task.status, 'done', `コマンドが失敗: ${task.summary}`);
    assert.match(
      task.summary ?? '',
      /Context|コンテキスト|Token/i,
      `CLI がコマンドとして処理している: ${task.summary}`,
    );
  });
});
