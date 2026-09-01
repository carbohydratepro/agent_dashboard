/** 描画基盤とダッシュボードのレイアウト。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Screen, CONTINUATION } from '../src/tui/screen.ts';
import { charWidth, center, displayWidth, padEnd, truncate } from '../src/tui/width.ts';
import { detectColorMode, toAnsi16, toAnsi256 } from '../src/tui/ansi.ts';
import { computeLayout, tooSmall, MIN_HEIGHT, MIN_WIDTH } from '../src/tui/layout.ts';
import { drawGauge, wrapText } from '../src/tui/paint.ts';
import { drawMainScreen } from '../src/tui/render.ts';
import { formatDuration, formatTokens } from '../src/tui/views/format.ts';
import { activityText, flagsFor, tableRows, tableScrollOffset, tailPath } from '../src/tui/views/table.ts';
import { ResourceMonitor, formatBytes } from '../src/core/resources.ts';
import { activityMark, isBusy, thinkingLevel } from '../src/tui/animation.ts';
import { recentActivity } from '../src/tui/views/detail.ts';
import { sampleDashboard, FIXTURE_NOW } from './fixtures/dashboard.ts';
import { createDashboard } from '../src/core/store.ts';
import type { Dashboard } from '../src/core/types.ts';

// ---------------------------------------------------------------------------

describe('表示幅', () => {
  test('日本語は 2 セル', () => {
    assert.equal(charWidth('あ'), 2);
    assert.equal(charWidth('漢'), 2);
    assert.equal(charWidth('a'), 1);
    assert.equal(charWidth('─'), 1, '罫線は半角');
    assert.equal(charWidth('█'), 1, 'ゲージのブロックは半角');
  });

  test('表示幅で切り詰める', () => {
    assert.equal(truncate('abcdef', 10), 'abcdef');
    assert.equal(truncate('abcdefghij', 5), 'abcd…');
    assert.ok(displayWidth(truncate('あいうえお', 6)) <= 6);
  });

  test('表示幅で揃える', () => {
    assert.equal(displayWidth(padEnd('あい', 8)), 8);
    assert.equal(displayWidth(center('あい', 9)), 9);
  });
});

describe('色のフォールバック', () => {
  test('COLORTERM から truecolor を検出する', () => {
    assert.equal(detectColorMode({ COLORTERM: 'truecolor' }, true), 'truecolor');
    assert.equal(detectColorMode({ TERM: 'xterm-256color' }, true), 'ansi256');
    assert.equal(detectColorMode({ TERM: 'xterm' }, true), 'ansi16');
  });

  test('NO_COLOR と非 TTY では色を使わない', () => {
    assert.equal(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true), 'none');
    assert.equal(detectColorMode({ COLORTERM: 'truecolor' }, false), 'none');
  });

  test('RGB から 256 色・16 色へ落とす', () => {
    assert.equal(toAnsi256(0x000000), 16);
    assert.equal(toAnsi256(0xffffff), 231);
    assert.equal(toAnsi16(0xff0000), 9);
  });
});

describe('Screen', () => {
  test('文字を置いて取り出せる', () => {
    const s = new Screen(10, 3);
    s.text(1, 1, 'hello');
    assert.equal(s.toStrings()[1], ' hello');
  });

  test('はみ出しは捨てる', () => {
    const s = new Screen(5, 1);
    s.text(3, 0, 'abcdef');
    assert.equal(s.toStrings()[0], '   ab');
  });

  test('全角文字は 2 セルを占める', () => {
    const s = new Screen(10, 1);
    s.text(0, 0, 'あa');
    assert.equal(s.get(0, 0).ch, 'あ');
    assert.equal(s.get(1, 0).ch, CONTINUATION, '右半分は継続セル');
    assert.equal(s.get(2, 0).ch, 'a');
  });

  test('全角の上に半角を書いても崩れない', () => {
    const s = new Screen(10, 1);
    s.text(0, 0, 'あい');
    s.set(1, 0, 'x');
    assert.equal(s.toStrings()[0]!.includes(CONTINUATION), false);
    assert.equal(s.get(0, 0).ch, ' ');
  });

  test('差分だけを流す', () => {
    const s = new Screen(10, 2, 'none');
    s.text(0, 0, 'abc');
    assert.ok(s.render().includes('abc'));
    assert.equal(s.render(), '', '変化が無ければ何も出さない');

    s.text(0, 0, 'abd');
    const diff = s.render();
    assert.ok(diff.includes('d'));
    assert.equal(diff.includes('abc'), false);
  });

  test('リサイズで作り直す', () => {
    const s = new Screen(10, 2);
    s.text(0, 0, 'abc');
    s.resize(20, 4);
    assert.equal(s.width, 20);
    assert.equal(s.toStrings()[0], '');
  });
});

describe('レイアウト', () => {
  test('最小サイズを判定する', () => {
    assert.equal(tooSmall(MIN_WIDTH, MIN_HEIGHT), false);
    assert.equal(tooSmall(MIN_WIDTH - 1, MIN_HEIGHT), true);
    assert.equal(tooSmall(MIN_WIDTH, MIN_HEIGHT - 1), true);
  });

  test('領域が縦に隙間なく積まれる', () => {
    const l = computeLayout(120, 40, 6);
    assert.equal(l.header.y + l.header.h, l.usage.y);
    assert.equal(l.usage.y + l.usage.h, l.table.y);
    assert.equal(l.table.y + l.table.h, l.detail.y);
    assert.equal(l.detail.y + l.detail.h, l.footer.y);
    assert.equal(l.footer.y + l.footer.h, 40);
  });

  test('一覧が画面を占有しすぎない', () => {
    const l = computeLayout(120, 40, 40);
    assert.ok(l.detail.h >= 3, '詳細の場所が残る');
  });
});

describe('ゲージと折り返し', () => {
  test('比率どおりに埋まる', () => {
    const s = new Screen(10, 1);
    drawGauge(s, 0, 0, 10, 0.5);
    const row = s.toStrings()[0]!;
    assert.equal([...row].filter((c) => c === '█').length, 5);
  });

  test('範囲外の比率を丸める', () => {
    const s = new Screen(4, 1);
    drawGauge(s, 0, 0, 4, 2);
    assert.equal(s.toStrings()[0], '████');
    drawGauge(s, 0, 0, 4, -1);
    assert.equal(s.toStrings()[0], '░░░░');
  });

  test('表示幅で折り返す', () => {
    const lines = wrapText('あいうえおかきくけこ', 6);
    for (const line of lines) assert.ok(displayWidth(line) <= 6);
    assert.equal(lines.join(''), 'あいうえおかきくけこ');
  });
});

describe('書式', () => {
  test('経過時間', () => {
    assert.equal(formatDuration(0), '00:00:00');
    assert.equal(formatDuration(4_400_000), '01:13:20');
  });

  test('トークン数', () => {
    assert.equal(formatTokens(999), '999');
    assert.equal(formatTokens(15_600), '16k');
    assert.equal(formatTokens(1_500_000), '1.5M');
  });

  test('長いパスは末尾を残す', () => {
    assert.equal(tailPath('/a/b', 10), '/a/b');
    const cut = tailPath('/very/long/path/to/project', 12);
    assert.ok(displayWidth(cut) <= 12);
    assert.ok(cut.endsWith('project'), '末尾のほうが情報量が多い');
    assert.ok(cut.startsWith('…'));
  });

  test('直近の作業を読める行にする', () => {
    const lines = recentActivity(
      [
        { t: 'tool_start', name: 'Edit', detail: 'a.ts', toolUseId: '1' },
        { t: 'tool_start', name: 'Bash', detail: 'npm test', toolUseId: '2' },
        { t: 'tool_start', name: 'Read', detail: 'b.ts', toolUseId: '3', parentToolUseId: 'p' },
      ],
      2,
    );
    assert.equal(lines.length, 2, '直近だけを残す');
    assert.ok(lines[1]!.startsWith('  └ '), 'サブエージェントはぶら下げる');
  });
});

describe('行の印', () => {
  test('状態が一目で分かる', () => {
    const dashboard = sampleDashboard();
    const [a, b, c] = dashboard.sessions;

    assert.ok(flagsFor(a!).includes('W'), 'worktree で隔離されている');
    assert.ok(flagsFor(b!).includes('S'), 'サブエージェントが動いている');
    assert.ok(flagsFor(c!).includes('P'), '下書きがある');
  });

  test('空きスロットも行として並ぶ', () => {
    const rows = tableRows(sampleDashboard());
    assert.equal(rows.length, 6);
    assert.equal(rows.filter((r) => r === null).length, 3);
  });
});

describe('動きの表示', () => {
  test('実行中は回り、止まっていれば回らない', () => {
    assert.equal(isBusy('working'), true);
    assert.equal(isBusy('idle'), false);
    assert.notEqual(activityMark('working', 0), activityMark('working', 1));
    assert.equal(activityMark('idle', 0), activityMark('idle', 5));
  });

  test('止まっている状態は記号で示す', () => {
    assert.equal(activityMark('blocked', 0), '!');
    assert.equal(activityMark('error', 0), '×');
  });

  test('ASCII モードでは記号を使わない', () => {
    const mark = activityMark('working', 0, true);
    assert.equal(/[⠋⠙⠹]/.test(mark), false);
  });

  test('思考量の段階', () => {
    assert.equal(thinkingLevel(0), 0);
    assert.equal(thinkingLevel(200), 1);
    assert.equal(thinkingLevel(800), 2);
    assert.equal(thinkingLevel(2_000), 3);
  });
});

describe('メイン画面', () => {
  function render(width = 100, height = 32, ascii = false): string[] {
    const s = new Screen(width, height, 'none');
    drawMainScreen(s, {
      dashboard: sampleDashboard(),
      selected: 0,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: false,
      animate: false,
      ascii,
    });
    return s.toStrings();
  }

  test('すべての行が画面幅に収まる', () => {
    for (const row of render()) assert.ok(displayWidth(row) <= 100, `はみ出し: ${row}`);
  });

  test('一覧に数字が並ぶ', () => {
    const text = render().join('\n');
    assert.ok(text.includes('codex-1'));
    assert.ok(text.includes('claude-1'));
    assert.ok(text.includes('WORKING'), '状態は色だけでなくラベルでも示す');
    assert.ok(text.includes('DELEGATE'));
    assert.ok(text.includes('78%~'), 'codex は概算マーク付き');
    assert.ok(text.includes('空き'));
  });

  test('見出しに列名が出る', () => {
    const text = render().join('\n');
    for (const header of ['セッション', '状態', 'コンテキスト', '経過', 'タスク', 'トークン']) {
      assert.ok(text.includes(header), `${header} が無い`);
    }
  });

  test('詳細に選択中のセッションが出る', () => {
    const text = render().join('\n');
    assert.ok(text.includes('バックエンド'), '役割');
    assert.ok(text.includes('認証まわりのリファクタ'), '実行中のタスク');
    assert.ok(text.includes('worktree vo/codex-1'));
    assert.ok(text.includes('稼働率'));
  });

  test('ヘッダーとキーバーが出る', () => {
    const rows = render();
    assert.ok(rows[0]!.includes('AGENT DASHBOARD'));
    assert.ok(rows[0]!.includes('3/6 セッション'));
    assert.ok(rows.at(-1)!.includes('Enter'));
  });

  test('会社の言葉が残っていない', () => {
    const text = render().join('\n');
    for (const word of ['社員', '社長', '採用', '退職', '稟議', '部下', '給料', '勤勉度', 'Lv.']) {
      assert.equal(text.includes(word), false, `${word} が残っている`);
    }
  });

  test('画面が小さければ警告だけ出す', () => {
    const text = render(80, 20).join('\n');
    assert.ok(text.includes('画面が小さすぎます'));
    assert.equal(text.includes('codex-1'), false);
  });

  test('広い端末でも崩れない', () => {
    for (const row of render(160, 50)) assert.ok(displayWidth(row) <= 160);
  });

  test('ASCII モードでも崩れない', () => {
    const rows = render(100, 32, true);
    for (const row of rows) assert.ok(displayWidth(row) <= 100);
    assert.ok(rows.join('\n').includes('codex-1'));
  });
});

// ---------------------------------------------------------------------------

describe('スロットが画面に入りきらないとき', () => {
  function dashboardWith(slotCount: number): Dashboard {
    const d = createDashboard({ title: 'T', slotCount });
    return d;
  }

  function draw(slotCount: number, selected: number, height: number): Screen {
    const screen = new Screen(100, height, 'none');
    drawMainScreen(screen, {
      dashboard: dashboardWith(slotCount),
      selected,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: false,
      animate: false,
    });
    return screen;
  }

  test('選択が下端を越えたらスクロールする', () => {
    // 13 行しか出せない画面で 20 スロット
    assert.equal(tableScrollOffset(0, 20, 13), 0);
    assert.equal(tableScrollOffset(12, 20, 13), 0, '最後の可視行までは動かない');
    assert.equal(tableScrollOffset(13, 20, 13), 1);
    assert.equal(tableScrollOffset(19, 20, 13), 7, '末尾で止まる');
  });

  test('行が収まるならスクロールしない', () => {
    assert.equal(tableScrollOffset(5, 6, 13), 0);
    assert.equal(tableScrollOffset(0, 6, 13), 0);
  });

  test('上下に動かしても行が飛ばない', () => {
    // 1 行動かしたらズレも 1 行以内であること
    let prev = tableScrollOffset(0, 24, 10);
    for (let sel = 1; sel < 24; sel += 1) {
      const cur = tableScrollOffset(sel, 24, 10);
      assert.ok(cur - prev <= 1 && cur >= prev, `${sel}: ${prev} → ${cur}`);
      prev = cur;
    }
  });

  test('見えない行にも選択が届く', () => {
    // 100x30 では 13 行が限界。16 スロット目を選べば画面に出る。
    const screen = draw(16, 15, 30);
    const rows = screen.toStrings();
    assert.ok(
      rows.some((r) => r.includes('16')),
      '最後のスロットが画面に出ている',
    );
  });

  // 一覧の見出し行。キーバーにも ↑↓ があるので、そこだけを見る。
  const headerRow = (screen: Screen): string => screen.toStrings()[2] ?? '';

  test('隠れている行数を知らせる', () => {
    assert.match(headerRow(draw(16, 0, 30)), /↓3/, '下に 3 行隠れている');
    assert.match(headerRow(draw(16, 15, 30)), /↑3/, '上に 3 行隠れている');
  });

  test('収まっているときは何も出さない', () => {
    const row = headerRow(draw(6, 0, 30));
    assert.equal(row.includes('↑'), false, row);
    assert.equal(row.includes('↓'), false, row);
  });
});

// ---------------------------------------------------------------------------

describe('マシンの負荷', () => {
  test('CPU は 2 回目から出る', () => {
    const m = new ResourceMonitor(() => 123 * 1024 * 1024);

    const first = m.sample();
    assert.equal(first.cpuRatio, null, '1 回目は差が取れない');
    assert.equal(first.rss, 123 * 1024 * 1024);
    assert.ok(first.memoryRatio > 0 && first.memoryRatio <= 1);

    const second = m.sample();
    if (second.cpuRatio !== null) {
      assert.ok(second.cpuRatio >= 0 && second.cpuRatio <= 1, String(second.cpuRatio));
    }
  });

  test('バイト数を短く書く', () => {
    assert.equal(formatBytes(159 * 1024 * 1024), '159M');
    assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2.5G');
    assert.equal(formatBytes(0), '0M');
  });

  test('ヘッダに出る', () => {
    const screen = new Screen(120, 30, 'none');
    drawMainScreen(screen, {
      dashboard: sampleDashboard(),
      selected: 0,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: false,
      animate: false,
      resources: { rss: 159 * 1024 * 1024, memoryRatio: 0.42, cpuRatio: 0.07 },
    });
    const header = screen.toStrings()[0] ?? '';
    assert.match(header, /MEM 42%/);
    assert.match(header, /CPU 7%/);
    assert.match(header, /本体 159M/);
  });

  test('負荷が渡されなければ何も出さない', () => {
    const screen = new Screen(120, 30, 'none');
    drawMainScreen(screen, {
      dashboard: sampleDashboard(),
      selected: 0,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: false,
      animate: false,
    });
    assert.equal((screen.toStrings()[0] ?? '').includes('MEM'), false);
  });
});

describe('いま何をしているか', () => {
  test('動いていれば実行中のツールを出す', () => {
    const dashboard = sampleDashboard();
    const session = dashboard.sessions[0]!;
    session.state = 'working';
    session.currentTask = {
      id: 't1',
      sessionId: session.id,
      prompt: 'テストを直して',
      startedAt: FIXTURE_NOW,
      endedAt: null,
      status: 'running',
      events: [
        { t: 'tool_start', name: 'Read', detail: 'a.ts', toolUseId: '1' },
        { t: 'tool_start', name: 'Bash', detail: 'npm test', toolUseId: '2' },
      ],
      summary: null,
      recoveredFrom: null,
    };

    const a = activityText(session);
    assert.equal(a.busy, true);
    assert.match(a.text, /Bash.*npm test/, '最後に始まったものを出す');
  });

  test('ツールを呼ぶ前は指示そのものを出す', () => {
    const dashboard = sampleDashboard();
    const session = dashboard.sessions[0]!;
    session.state = 'thinking';
    session.currentTask = {
      id: 't1',
      sessionId: session.id,
      prompt: 'テストを直して',
      startedAt: FIXTURE_NOW,
      endedAt: null,
      status: 'running',
      events: [],
      summary: null,
      recoveredFrom: null,
    };

    assert.deepEqual(activityText(session), { text: 'テストを直して', busy: true });
  });

  test('一覧の行に実際に出る', () => {
    // 列の幅計算から外れていると、関数が正しくても画面には出ない
    const dashboard = sampleDashboard();
    const session = dashboard.sessions[0]!;
    session.state = 'working';
    session.currentTask = {
      id: 't1',
      sessionId: session.id,
      prompt: 'テストを直して',
      startedAt: FIXTURE_NOW,
      endedAt: null,
      status: 'running',
      events: [{ t: 'tool_start', name: 'Bash', detail: 'npm run check', toolUseId: '1' }],
      summary: null,
      recoveredFrom: null,
    };

    const screen = new Screen(140, 30, 'none');
    drawMainScreen(screen, {
      dashboard,
      selected: 0,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: false,
      animate: false,
    });
    const rows = screen.toStrings();

    assert.ok(
      rows.some((r) => r.includes('npm run check')),
      '実行中のコマンドが行に出ている',
    );
    assert.ok(rows[2]?.includes('いま何をしているか'), '見出しが出ている');
  });

  test('止まっていれば作業ディレクトリを出す', () => {
    const dashboard = sampleDashboard();
    const session = dashboard.sessions[0]!;
    session.state = 'idle';

    const a = activityText(session);
    assert.equal(a.busy, false);
    assert.equal(a.text, session.workspace.requestedCwd);
  });
});
