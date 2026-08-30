/**
 * 使用量の取得と表示。
 * claude は `/usage` の出力、codex はセッション記録から実数を取る。
 * 実際に採取した出力（docs/phase0/captures/）をそのまま食わせて検証する。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ClaudeUsageProbe,
  CodexUsageProbe,
  labelForWindowMinutes,
  parseClaudeUsage,
  parseCodexRollout,
  parseResetTime,
  readTail,
} from '../src/core/usage.ts';
import { UsageMonitor } from '../src/core/usage-monitor.ts';
import { StateStore, createDashboard } from '../src/core/store.ts';
import type { StoreEvent } from '../src/core/store.ts';
import type { UsageProbe, UsageSnapshot } from '../src/core/usage.ts';
import { App } from '../src/tui/app.ts';
import { FakeTerminal } from '../src/tui/terminal.ts';
import { SessionManager } from '../src/core/session-manager.ts';
import { MockDriver, successfulTurn } from '../src/core/drivers/mock.ts';
import { SeqIdGen } from '../src/core/clock.ts';
import { untilReset, usageColor, usageLines, usagePieces } from '../src/tui/views/usage.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
import { displayWidth } from '../src/tui/width.ts';
import type { AgentKind } from '../src/core/types.ts';

const CAPTURES = new URL('../docs/phase0/captures/', import.meta.url);
const CLAUDE_USAGE = readFileSync(new URL('claude_usage.txt', CAPTURES), 'utf8');
const CODEX_ROLLOUT = readFileSync(new URL('codex_rate_limits.jsonl', CAPTURES), 'utf8');
const NOW = Date.UTC(2026, 7, 23, 13, 0);

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vo-usage-'));
});
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('claude の /usage を読む', () => {
  test('実際の出力から使用率を取り出す', () => {
    const snap = parseClaudeUsage(CLAUDE_USAGE, NOW);

    assert.equal(snap.error, null);
    assert.equal(snap.windows.length, 2);
    assert.equal(snap.windows[0]!.label, 'セッション');
    assert.ok(snap.windows[0]!.usedPercent > 0 && snap.windows[0]!.usedPercent <= 100);
    assert.equal(snap.windows[1]!.label, '週');
    assert.ok(snap.windows[1]!.resetsText.includes('Aug'));
  });

  test('リセット時刻を時刻に直す', () => {
    const snap = parseClaudeUsage(CLAUDE_USAGE, NOW);
    for (const w of snap.windows) {
      assert.notEqual(w.resetsAt, null, `${w.label} のリセット時刻が読めていない`);
    }
  });

  test('見出しの言い換え', () => {
    const snap = parseClaudeUsage(
      'Current session: 5% used · resets Aug 24, 2:00am\n' +
        'Current week (all models): 10% used · resets Aug 25, 12am\n' +
        'Current week (Opus): 3% used · resets Aug 25, 12am\n',
      NOW,
    );
    assert.deepEqual(snap.windows.map((w) => w.label), ['セッション', '週', '週(Opus)']);
  });

  test('使用量の行が無ければエラーにする。0% とは言わない', () => {
    const snap = parseClaudeUsage('何も分かりません', NOW);
    assert.deepEqual(snap.windows, []);
    assert.ok(snap.error);
  });

  test('100% を超える値は丸める', () => {
    const snap = parseClaudeUsage('Current session: 150% used', NOW);
    assert.equal(snap.windows[0]!.usedPercent, 100);
  });

  test('CLI が失敗したら理由を残す', async () => {
    const probe = new ClaudeUsageProbe({
      now: () => NOW,
      run: async () => {
        throw new Error('claude が見つかりません');
      },
    });
    const snap = await probe.fetch();
    assert.deepEqual(snap.windows, []);
    assert.match(snap.error ?? '', /見つかりません/);
  });

  test('差し込んだ出力から作れる', async () => {
    const probe = new ClaudeUsageProbe({ now: () => NOW, run: async () => CLAUDE_USAGE });
    const snap = await probe.fetch();
    assert.equal(snap.kind, 'claude');
    assert.equal(snap.windows.length, 2);
  });
});

describe('リセット時刻の解釈', () => {
  test('am / pm を読む', () => {
    const at = parseResetTime('Aug 24, 2:50am (Asia/Tokyo)', NOW)!;
    const d = new Date(at);
    assert.equal(d.getMonth(), 7);
    assert.equal(d.getDate(), 24);
    assert.equal(d.getHours(), 2);
    assert.equal(d.getMinutes(), 50);
  });

  test('12am は 0 時', () => {
    assert.equal(new Date(parseResetTime('Aug 24, 12am', NOW)!).getHours(), 0);
  });

  test('12pm は 12 時', () => {
    assert.equal(new Date(parseResetTime('Aug 24, 12pm', NOW)!).getHours(), 12);
  });

  test('年をまたぐ表記', () => {
    const dec = Date.UTC(2026, 11, 30);
    const at = parseResetTime('Jan 2, 3am', dec)!;
    assert.equal(new Date(at).getFullYear(), 2027);
  });

  test('読めなければ null', () => {
    assert.equal(parseResetTime('', NOW), null);
    assert.equal(parseResetTime('いつか', NOW), null);
  });
});

describe('codex のセッション記録を読む', () => {
  test('実際の記録から使用率を取り出す', () => {
    const snap = parseCodexRollout(CODEX_ROLLOUT, NOW)!;

    assert.ok(snap);
    assert.equal(snap.kind, 'codex');
    assert.equal(snap.windows.length >= 1, true);
    assert.equal(snap.windows[0]!.label, '週', 'window_minutes 10080 は週');
    assert.ok(snap.windows[0]!.usedPercent >= 0);
    assert.notEqual(snap.windows[0]!.resetsAt, null);
    assert.equal(snap.planType, 'plus');
    assert.equal(snap.contextWindow, 258_400, 'モデルの本当のコンテキスト窓も分かる');
  });

  test('枠の長さを名前にする', () => {
    assert.equal(labelForWindowMinutes(10_080), '週');
    assert.equal(labelForWindowMinutes(1_440), '日');
    assert.equal(labelForWindowMinutes(300), '5時間');
    assert.equal(labelForWindowMinutes(30), '30分');
  });

  test('rate_limits の無い記録は無視する', () => {
    assert.equal(parseCodexRollout('{"type":"event_msg","payload":{"type":"other"}}', NOW), null);
    assert.equal(parseCodexRollout('壊れた行\n', NOW), null);
    assert.equal(parseCodexRollout('', NOW), null);
  });

  test('副次の枠も読む', () => {
    const line = JSON.stringify({
      type: 'event_msg',
      payload: {
        rate_limits: {
          primary: { used_percent: 40, window_minutes: 300, resets_at: 1_787_916_394 },
          secondary: { used_percent: 12, window_minutes: 10_080, resets_at: 1_787_916_394 },
        },
      },
    });
    const snap = parseCodexRollout(line, NOW)!;
    assert.deepEqual(snap.windows.map((w) => w.label), ['5時間', '週']);
  });

  test('セッションが無ければその旨を返す', async () => {
    const probe = new CodexUsageProbe({ sessionsDir: join(dir, 'ない'), now: () => NOW });
    const snap = await probe.fetch();
    assert.deepEqual(snap.windows, []);
    assert.ok(snap.error);
  });

  test('新しい記録から順に探す', async () => {
    const sessions = join(dir, 'sessions', '2026', '08', '23');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'rollout-old.jsonl'), '{"type":"event_msg","payload":{}}\n');
    writeFileSync(join(sessions, 'rollout-new.jsonl'), CODEX_ROLLOUT);

    const probe = new CodexUsageProbe({ sessionsDir: join(dir, 'sessions'), now: () => NOW });
    const snap = await probe.fetch();
    assert.equal(snap.windows.length >= 1, true);
    assert.equal(snap.error, null);
  });

  test('大きなファイルは末尾だけ読む', () => {
    const path = join(dir, 'big.jsonl');
    writeFileSync(path, `${'x'.repeat(100_000)}\n${CODEX_ROLLOUT}`);
    const tail = readTail(path, 4_096);
    assert.ok(tail.length <= 4_096);
    assert.ok(parseCodexRollout(tail, NOW));
  });
});

describe('UsageMonitor', () => {
  function fakeProbe(kind: AgentKind, percent: number): UsageProbe & { calls: number } {
    const probe = {
      kind,
      calls: 0,
      async fetch(): Promise<UsageSnapshot> {
        probe.calls += 1;
        return {
          kind,
          windows: [{ label: '週', usedPercent: percent, resetsAt: null, resetsText: '' }],
          planType: null,
          contextWindow: null,
          fetchedAt: NOW,
          error: null,
        };
      },
    };
    return probe;
  }

  test('取得して保持する', async () => {
    const probe = fakeProbe('claude', 42);
    const monitor = new UsageMonitor({ probes: [probe], now: () => NOW });

    assert.equal(monitor.snapshot('claude'), null);
    await monitor.refresh('claude', { force: true });
    assert.equal(monitor.snapshot('claude')!.windows[0]!.usedPercent, 42);
  });

  test('最短間隔より短ければ取り直さない', async () => {
    let now = NOW;
    const probe = fakeProbe('claude', 10);
    const monitor = new UsageMonitor({ probes: [probe], minIntervalMs: 30_000, now: () => now });

    await monitor.refresh('claude', { force: true });
    await monitor.refresh('claude');
    assert.equal(probe.calls, 1, '続けて呼んでも 1 回');

    now += 40_000;
    await monitor.refresh('claude');
    assert.equal(probe.calls, 2, '間が空けば取り直す');
  });

  test('force なら間隔を無視する', async () => {
    const probe = fakeProbe('claude', 10);
    const monitor = new UsageMonitor({ probes: [probe], now: () => NOW });
    await monitor.refresh('claude', { force: true });
    await monitor.refresh('claude', { force: true });
    assert.equal(probe.calls, 2);
  });

  test('同時に呼ばれても 1 回にまとめる', async () => {
    const probe = fakeProbe('claude', 10);
    const monitor = new UsageMonitor({ probes: [probe], now: () => NOW });
    await Promise.all([
      monitor.refresh('claude', { force: true }),
      monitor.refresh('claude', { force: true }),
      monitor.refresh('claude', { force: true }),
    ]);
    assert.equal(probe.calls, 1);
  });

  test('取り直したら知らせる', async () => {
    const store = new StateStore(createDashboard());
    const events: StoreEvent[] = [];
    store.on((e) => events.push(e));

    const monitor = new UsageMonitor({ probes: [fakeProbe('codex', 5)], store, now: () => NOW });
    await monitor.refresh(undefined, { force: true });

    assert.ok(events.some((e) => e.t === 'usage_updated' && e.kind === 'codex'));
  });

  test('登録していない種別は何もしない', async () => {
    const monitor = new UsageMonitor({ probes: [fakeProbe('claude', 1)], now: () => NOW });
    await monitor.refresh('codex', { force: true });
    assert.equal(monitor.snapshot('codex'), null);
  });
});

describe('表示', () => {
  const theme = DEFAULT_THEME;

  function snapshot(kind: AgentKind, percent: number, resetsAt: number | null = null): UsageSnapshot {
    return {
      kind,
      windows: [{ label: '週', usedPercent: percent, resetsAt, resetsText: '' }],
      planType: null,
      contextWindow: null,
      fetchedAt: NOW,
      error: null,
    };
  }

  test('使うほど色が変わる', () => {
    assert.equal(usageColor(theme, 10), theme.gauge.good);
    assert.equal(usageColor(theme, 60), theme.gauge.warn);
    assert.equal(usageColor(theme, 80), theme.gauge.high);
    assert.equal(usageColor(theme, 95), theme.gauge.critical);
  });

  test('リセットまでの残りを短く出す', () => {
    const w = { label: '週', usedPercent: 1, resetsAt: NOW + 2 * 3_600_000 + 14 * 60_000, resetsText: '' };
    assert.equal(untilReset(w, NOW), '2:14');
    assert.equal(untilReset({ ...w, resetsAt: NOW + 4 * 86_400_000 }, NOW), '4日');
    assert.equal(untilReset({ ...w, resetsAt: null, resetsText: 'あとで' }, NOW), 'あとで');
    assert.equal(untilReset({ ...w, resetsAt: NOW - 1_000 }, NOW), '0:00');
  });

  test('両方の使用率が 1 行に並ぶ', () => {
    const pieces = usagePieces({
      theme,
      now: NOW,
      snapshots: { claude: snapshot('claude', 31), codex: snapshot('codex', 11) },
    });
    const text = pieces.map((p) => p.text).join('');
    assert.ok(text.includes('claude'));
    assert.ok(text.includes('31%'));
    assert.ok(text.includes('codex'));
    assert.ok(text.includes('11%'));
    assert.ok(pieces.some((p) => p.gauge), 'ゲージも出る');
  });

  test('取得前と取得失敗を区別して出す', () => {
    const pending = usagePieces({ theme, now: NOW, snapshots: {} });
    assert.ok(pending.map((p) => p.text).join('').includes('取得中'));

    const failed = usagePieces({
      theme,
      now: NOW,
      snapshots: {
        claude: { kind: 'claude', windows: [], planType: null, contextWindow: null, fetchedAt: NOW, error: '取れませんでした' },
      },
    });
    assert.ok(failed.map((p) => p.text).join('').includes('取れませんでした'));
  });

  test('未導入の CLI はそう書く', () => {
    const pieces = usagePieces({ theme, now: NOW, snapshots: {}, availableKinds: ['claude'] });
    assert.ok(pieces.map((p) => p.text).join('').includes('未導入'));
  });

  test('統計パネル用の行', () => {
    const lines = usageLines({
      theme,
      now: NOW,
      snapshots: {
        claude: snapshot('claude', 31),
        codex: { ...snapshot('codex', 11), planType: 'plus' },
      },
    });
    assert.ok(lines.some((l) => l.includes('claude')));
    assert.ok(lines.some((l) => l.includes('31% 使用')));
    assert.ok(lines.some((l) => l.includes('プラン plus')));

    // 全角を含む見出しでも桁が揃う
    const rows = lines.filter((l) => l.includes('% 使用'));
    const columns = rows.map((l) => displayWidth(l.slice(0, l.indexOf('% 使用'))));
    assert.equal(new Set(columns).size, 1, `桁がずれている: ${rows.join(' / ')}`);
  });
});

describe('ホーム画面', () => {
  function harness(opts: { snapshots?: Partial<Record<AgentKind, UsageSnapshot>> } = {}) {
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const claude = new MockDriver({ kind: 'claude' });
    claude.setScenario(() => successfulTurn());
    const manager = new SessionManager({
      store,
      drivers: { claude, codex: new MockDriver({ kind: 'codex', assignsOwnSessionId: true }) },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });

    const probes: UsageProbe[] = [];
    for (const [kind, snap] of Object.entries(opts.snapshots ?? {})) {
      probes.push({ kind: kind as AgentKind, fetch: async () => snap! });
    }
    const usage = new UsageMonitor({ probes, store, now: () => NOW });

    const app = new App({
      manager,
      terminal: new FakeTerminal(100, 32),
      animate: false,
      bell: false,
      usage,
    });
    app.start();
    return {
      app,
      manager,
      usage,
      claude,
      view: () => {
        
        app.render();
        return app.screen.toStrings().join('\n');
      },
    };
  }

  const claudeSnap: UsageSnapshot = {
    kind: 'claude',
    windows: [
      { label: 'セッション', usedPercent: 31, resetsAt: NOW + 3_600_000, resetsText: '' },
      { label: '週', usedPercent: 22, resetsAt: NOW + 40_000_000, resetsText: '' },
    ],
    planType: null,
    contextWindow: null,
    fetchedAt: NOW,
    error: null,
  };
  const codexSnap: UsageSnapshot = {
    kind: 'codex',
    windows: [{ label: '週', usedPercent: 11, resetsAt: NOW + 400_000_000, resetsText: '' }],
    planType: 'plus',
    contextWindow: 258_400,
    fetchedAt: NOW,
    error: null,
  };

  test('両方の残量が出る', async () => {
    const h = harness({ snapshots: { claude: claudeSnap, codex: codexSnap } });
    await h.usage.refresh(undefined, { force: true });

    const text = h.view();
    assert.ok(text.includes('claude'));
    assert.ok(text.includes('31%'), 'claude のセッション使用率');
    assert.ok(text.includes('22%'), 'claude の週使用率');
    assert.ok(text.includes('codex'));
    assert.ok(text.includes('11%'), 'codex の週使用率');
  });

  test('1 行に収まる', async () => {
    const h = harness({ snapshots: { claude: claudeSnap, codex: codexSnap } });
    await h.usage.refresh(undefined, { force: true });
    h.app.render();
    for (const row of h.app.screen.toStrings()) {
      assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
    }
  });

  test('統計にも詳しく出る', async () => {
    const h = harness({ snapshots: { claude: claudeSnap, codex: codexSnap } });
    await h.usage.refresh(undefined, { force: true });

    h.app.handleKey({ name: 'char', ch: 's', ctrl: false, alt: false, shift: false, raw: 's' });
    const text = h.view();
    assert.ok(text.includes('AI の使用量'));
    assert.ok(text.includes('31% 使用'));
    assert.ok(text.includes('プラン plus'));
  });

  test('codex の実際のコンテキスト窓をゲージに反映する', async () => {
    const h = harness({ snapshots: { codex: codexSnap } });
    const emp = h.manager.createSession({ kind: 'codex' });
    assert.equal(emp.context.windowTokens, 200_000, '既定値');

    await h.usage.refresh(undefined, { force: true });
    await new Promise((r) => setImmediate(r));

    assert.equal(emp.context.windowTokens, 258_400, '実測値に置き換わる');
  });

  test('ターンが終わると取り直す', async () => {
    let calls = 0;
    const store = new StateStore(createDashboard({ slotCount: 6 }));
    const claude = new MockDriver({ kind: 'claude' });
    claude.setScenario(() => successfulTurn());
    const manager = new SessionManager({
      store,
      drivers: { claude },
      ids: new SeqIdGen(),
      config: { defaultCwd: '/ws' },
    });
    const usage = new UsageMonitor({
      probes: [
        {
          kind: 'claude',
          fetch: async () => {
            calls += 1;
            return claudeSnap;
          },
        },
      ],
      store,
      minIntervalMs: 0,
    });
    const app = new App({ manager, terminal: new FakeTerminal(100, 32), animate: false, usage });
    app.start();

    const emp = manager.createSession({ kind: 'claude' });
    await manager.dispatch(emp.id, 'やって');
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(calls >= 1, '使ったぶんを反映するために取り直す');
  });
});
