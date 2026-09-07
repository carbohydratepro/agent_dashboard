/**
 * 描画崩れの防止。
 *
 * 改行やエスケープがセルに入ると、端末に流れた瞬間に画面全体がずれる。
 * 文字の出どころは多いので、描画の入口で必ず止める。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Screen, sanitizeChar } from '../src/tui/screen.ts';
import { toolDetail } from '../src/core/drivers/claude-parser.ts';
import { ConversationState, drawConversation } from '../src/tui/views/conversation.ts';
import { drawMainScreen } from '../src/tui/render.ts';
import { drawApproval } from '../src/tui/views/approval.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
import { sampleDashboard, FIXTURE_NOW } from './fixtures/dashboard.ts';
import type { Session } from '../src/core/types.ts';

const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);

/** 端末へ送る並びに、こちらが意図していない制御文字が混ざっていないか */
function strayControls(rendered: string): string[] {
  // 自分で出したエスケープ列は取り除いてから見る
  const plain = rendered.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  return [...plain].filter((c) => {
    const cp = c.codePointAt(0);
    return cp !== undefined && (cp < 0x20 || cp === 0x7f);
  });
}

function fakeSession(over: Partial<Session> = {}): Session {
  return {
    name: 'claude-1',
    state: 'idle',
    drafts: [],
    pendingApprovals: [],
    ...over,
  } as unknown as Session;
}

// ---------------------------------------------------------------------------

describe('制御文字を無害にする', () => {
  test('改行・タブ・エスケープは空白になる', () => {
    assert.equal(sanitizeChar(NL), ' ');
    assert.equal(sanitizeChar(TAB), ' ');
    assert.equal(sanitizeChar(ESC), ' ');
    assert.equal(sanitizeChar(String.fromCharCode(0x7f)), ' ');
  });

  test('普通の文字はそのまま', () => {
    assert.equal(sanitizeChar('a'), 'a');
    assert.equal(sanitizeChar('あ'), 'あ');
    assert.equal(sanitizeChar('█'), '█');
  });

  test('セルに書いても混ざらない', () => {
    const s = new Screen(20, 2, 'none');
    s.text(0, 0, `a${NL}b${TAB}c`);
    assert.equal(strayControls(s.render()).length, 0);
    assert.equal(s.toStrings()[0], 'a b c');
  });

  test('エスケープ列を書き込まれても乗っ取られない', () => {
    const s = new Screen(30, 2, 'none');
    // モデルの出力に端末のエスケープが混ざっている想定
    s.text(0, 0, `前${ESC}[2J${ESC}[31m後`);
    const out = s.render();
    assert.equal(strayControls(out).length, 0);
    assert.equal(out.includes('[2J'), true, '文字としては残る');
    assert.equal(out.includes(`${ESC}[2J`), false, '命令としては効かない');
  });
});

describe('ツール引数を 1 行にする', () => {
  test('ヒアドキュメントを潰す', () => {
    const command = `cd /app && python - <<EOF${NL}import sys${NL}EOF`;
    const detail = toolDetail({ command });
    assert.equal(detail.includes(NL), false);
    assert.ok(detail.startsWith('cd /app'));
  });

  test('前後の空白を落とす', () => {
    assert.equal(toolDetail({ command: `  npm test ${NL}` }), 'npm test');
  });
});

describe('会話が続いても崩れない', () => {
  function render(build: (conv: ConversationState) => void, width = 70, height = 20): string {
    const conv = new ConversationState();
    build(conv);
    const screen = new Screen(width, height, 'none');
    drawConversation(screen, {
      session: fakeSession(),
      conversation: conv,
      theme: DEFAULT_THEME,
      now: FIXTURE_NOW,
    });
    return screen.render();
  }

  test('改行を含むコマンドを実行しても崩れない', () => {
    const out = render((conv) => {
      conv.pushUser('テストを走らせて');
      conv.applyEvent({
        t: 'tool_start',
        name: 'Bash',
        detail: `python - <<EOF${NL}import sys${NL}EOF`,
        toolUseId: '1',
      });
    });
    assert.deepEqual(strayControls(out), []);
  });

  test('モデルの出力にエスケープが混ざっても崩れない', () => {
    const out = render((conv) => {
      conv.applyEvent({ t: 'text', delta: `結果は${ESC}[31m赤${ESC}[0mです` });
    });
    assert.deepEqual(strayControls(out), []);
  });

  test('サブエージェントの報告に改行があっても崩れない', () => {
    const out = render((conv) => {
      conv.applyEvent({
        t: 'subagent_end',
        taskId: 'a1',
        ok: true,
        summary: `一行目${NL}二行目${NL}三行目`,
      });
    });
    assert.deepEqual(strayControls(out), []);
  });

  test('やり取りを重ねても崩れない', () => {
    const out = render((conv) => {
      for (let i = 0; i < 60; i += 1) {
        conv.pushUser(`指示 ${i}${NL}続き`);
        conv.applyEvent({
          t: 'tool_start',
          name: 'Bash',
          detail: `cmd ${i}${NL}${TAB}next`,
          toolUseId: `t${i}`,
        });
        conv.applyEvent({ t: 'text', delta: `## 見出し ${i}${NL}${NL}本文です。` });
        conv.applyEvent({ t: 'turn_end', ok: true, result: '' });
      }
    });
    assert.deepEqual(strayControls(out), []);
  });

  test('画面が狭くても崩れない', () => {
    for (const [w, h] of [
      [40, 10],
      [30, 8],
      [100, 30],
    ] as const) {
      const out = render((conv) => {
        conv.pushUser('あ'.repeat(200));
        conv.applyEvent({ t: 'text', delta: `# 見出し${NL}- 箇条書き${NL}\`\`\`${NL}code${NL}\`\`\`` });
      }, w, h);
      assert.deepEqual(strayControls(out), [], `${w}x${h}`);
    }
  });
});

describe('他の画面も崩れない', () => {
  test('一覧', () => {
    const dashboard = sampleDashboard();
    const session = dashboard.sessions[0]!;
    session.lastError = `失敗しました${NL}stderr の 2 行目${NL}3 行目`;
    session.currentTask = {
      id: 't1',
      sessionId: session.id,
      prompt: `複数行の${NL}プロンプト`,
      startedAt: FIXTURE_NOW,
      endedAt: null,
      status: 'running',
      events: [{ t: 'tool_start', name: 'Bash', detail: `a${NL}b`, toolUseId: '1' }],
      summary: null,
      recoveredFrom: null,
      pid: null,
      outFile: null,
    };

    const screen = new Screen(100, 30, 'none');
    drawMainScreen(screen, {
      dashboard,
      selected: 0,
      frame: 0,
      now: FIXTURE_NOW,
      expanded: true,
      animate: false,
    });
    assert.deepEqual(strayControls(screen.render()), []);
  });

  test('承認待ち', () => {
    const session = fakeSession({
      pendingApprovals: [
        {
          id: 'a1',
          toolName: 'Bash',
          toolUseId: 't1',
          toolInput: { command: `rm -rf x${NL}rm -rf y` },
          message: `理由の 1 行目${NL}2 行目`,
          requestedAt: FIXTURE_NOW,
          taskId: 'task-1',
        },
      ],
    });
    const screen = new Screen(90, 24, 'none');
    drawApproval(screen, { session, index: 0, theme: DEFAULT_THEME, rejectInput: null });
    assert.deepEqual(strayControls(screen.render()), []);
  });
});
