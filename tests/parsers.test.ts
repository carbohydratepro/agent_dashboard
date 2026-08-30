/**
 * パーサのゴールデンテスト。
 * フェーズ 0 で実際の CLI から採取した JSONL（docs/phase0/captures/）を食わせ、
 * AgentEvent 列が期待どおりに出るかを検証する。
 * CLI のバージョンが上がってスキーマが変わったら、ここが最初に落ちる。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ClaudeParser, toolDetail } from '../src/core/drivers/claude-parser.ts';
import { CodexParser } from '../src/core/drivers/codex-parser.ts';
import type { AgentEvent } from '../src/core/types.ts';
import type { ProcEvent } from '../src/core/drivers/process.ts';

interface Parser {
  push(line: string): AgentEvent[];
  finish(exit: Extract<ProcEvent, { t: 'exit' }>): AgentEvent[];
}

const CLEAN_EXIT = { t: 'exit', code: 0, signal: null, stderr: '' } as const;

function runCapture(parser: Parser, file: string): AgentEvent[] {
  const url = new URL(`../docs/phase0/captures/${file}`, import.meta.url);
  const text = readFileSync(url, 'utf8');
  const events: AgentEvent[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    events.push(...parser.push(line));
  }
  events.push(...parser.finish(CLEAN_EXIT));
  return events;
}

function only<T extends AgentEvent['t']>(events: AgentEvent[], t: T) {
  return events.filter((e): e is Extract<AgentEvent, { t: T }> => e.t === t);
}

// ---------------------------------------------------------------------------

describe('ClaudeParser — 読み取りのみのターン (A1)', () => {
  const events = runCapture(new ClaudeParser(), 'claude_A1_readonly.jsonl');

  test('セッション ID とモデルが取れる', () => {
    const started = only(events, 'session_started');
    assert.equal(started.length, 1);
    assert.equal(started[0]!.sessionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(started[0]!.model, 'claude-opus-5');
  });

  test('ツールの開始と終了が対になる', () => {
    const starts = only(events, 'tool_start');
    const ends = only(events, 'tool_end');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.name, 'Read');
    assert.match(starts[0]!.detail, /calc\.js$/, '引数からファイルパスを抜き出す');
    assert.equal(ends.length, 1);
    assert.equal(ends[0]!.ok, true);
    assert.equal(ends[0]!.toolUseId, starts[0]!.toolUseId);
  });

  test('文脈サイズは最後の assistant メッセージから出す（result.usage ではない）', () => {
    const usage = only(events, 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.contextTokens, 14_346, '2 + 330 + 14014');
    assert.equal(usage[0]!.estimated, false, 'claude は正確値');
    assert.notEqual(usage[0]!.contextTokens, 28_362, 'result.usage を使うと 2 倍になる');
  });

  test('レート制限イベントが取れる', () => {
    const rl = only(events, 'rate_limit');
    assert.equal(rl.length, 1);
    assert.equal(rl[0]!.rateLimitType, 'five_hour');
    assert.equal(rl[0]!.isUsingOverage, false);
  });

  test('成功で終わる', () => {
    const end = only(events, 'turn_end');
    assert.equal(end.length, 1);
    assert.equal(end[0]!.ok, true);
    assert.equal(end[0]!.result, 'add');
    assert.equal(only(events, 'error').length, 0);
  });
});

describe('ClaudeParser — 権限拒否のターン (C1)', () => {
  const events = runCapture(new ClaudeParser(), 'claude_C1_denied.jsonl');

  test('稟議書に完全な引数が乗る', () => {
    const denied = only(events, 'permission_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.toolName, 'Edit');
    assert.match(String(denied[0]!.toolInput.file_path), /calc\.js$/);
    assert.ok(denied[0]!.toolInput.new_string, '差分描画に必要な引数がある');
    assert.match(denied[0]!.message, /permission/i, 'system/permission_denied の理由と結び付く');
  });

  test('拒否されてもターン自体は成功で終わる（失敗ではなく稟議待ち）', () => {
    const end = only(events, 'turn_end');
    assert.equal(end[0]!.ok, true);
  });

  test('拒否されたので file_edited は出ない', () => {
    assert.equal(only(events, 'file_edited').length, 0);
  });
});

describe('ClaudeParser — 承認後の再実行 (C2)', () => {
  const events = runCapture(new ClaudeParser(), 'claude_C2_approved.jsonl');

  test('編集が成立し、稟議は発生しない', () => {
    assert.equal(only(events, 'permission_denied').length, 0);
    const edits = only(events, 'file_edited');
    assert.equal(edits.length, 1);
    assert.match(edits[0]!.path, /calc\.js$/);
    assert.equal(edits[0]!.kind, 'update');
    assert.equal(only(events, 'turn_end')[0]!.ok, true);
  });
});

describe('ClaudeParser — サブエージェントのターン (A3)', () => {
  const events = runCapture(new ClaudeParser(), 'claude_A3_subagent.jsonl');

  test('部下の開始・進捗・終了が揃う', () => {
    const started = only(events, 'subagent_start');
    assert.equal(started.length, 1);
    assert.equal(started[0]!.agentType, 'Explore');
    assert.equal(started[0]!.description, 'List files and line counts');

    const progress = only(events, 'subagent_progress');
    assert.equal(progress.length, 3);
    assert.equal(progress[0]!.lastToolName, 'Bash');
    assert.equal(progress[0]!.totalTokens, 8_217);
    assert.equal(progress[0]!.toolUses, 1);
    assert.ok(progress[0]!.durationMs > 0);

    const ended = only(events, 'subagent_end');
    assert.equal(ended.length, 1, 'task_updated と task_notification で二重に終わらせない');
    assert.equal(ended[0]!.ok, true);
    assert.ok(ended[0]!.summary.length > 0);
  });

  test('Agent ツール自体は tool_start にしない', () => {
    const names = only(events, 'tool_start').map((e) => e.name);
    assert.ok(!names.includes('Agent'), '専用イベントで扱うため');
    assert.ok(names.includes('Bash'), '部下が使ったツールは出る');
  });

  test('部下の発話には親の tool_use_id が付く', () => {
    const parented = only(events, 'text').filter((e) => e.parentToolUseId);
    assert.ok(parented.length > 0, '吹き出しをどの部下に紐付けるか決められる');
  });

  test('部下のツール実行にも親が付く', () => {
    const parented = only(events, 'tool_start').filter((e) => e.parentToolUseId);
    assert.ok(parented.length > 0, '会話ビューでインデント表示するため');
  });

  test('stream_event は捨てる', () => {
    // A3 は 59 行中 34 行が stream_event。落とさず無視できていれば十分
    assert.equal(only(events, 'error').length, 0);
    assert.equal(only(events, 'turn_end')[0]!.ok, true);
  });
});

describe('ClaudeParser — 会話の継続 (A4)', () => {
  const events = runCapture(new ClaudeParser(), 'claude_A4_resume.jsonl');

  test('ツールを使わず記憶から答えている', () => {
    assert.equal(only(events, 'tool_start').length, 0);
    assert.match(only(events, 'turn_end')[0]!.result, /calc\.js/);
  });

  test('文脈は前ターンから増えている', () => {
    assert.equal(only(events, 'usage')[0]!.contextTokens, 14_389);
  });
});

describe('ClaudeParser — 異常系', () => {
  test('壊れた行があっても落ちず、無視して続ける', () => {
    const p = new ClaudeParser();
    assert.deepEqual(p.push('これは JSON ではない'), []);
    assert.deepEqual(p.push('{"type":"未知のイベント"}'), []);
    const events = p.push(
      '{"type":"system","subtype":"init","session_id":"s1","model":"m1"}',
    );
    assert.equal(events[0]!.t, 'session_started');
  });

  test('パース失敗が多すぎるとスキーマ不整合として報告する', () => {
    const p = new ClaudeParser();
    for (let i = 0; i < 10; i += 1) p.push('壊れた行');
    p.push('{"type":"result","subtype":"success","result":"ok"}');
    const events = p.finish(CLEAN_EXIT);
    assert.ok(events.some((e) => e.t === 'error' && /解釈できません/.test(e.message)));
  });

  test('turn_end を見ないまま終了したら失敗として閉じる', () => {
    const p = new ClaudeParser();
    p.push('{"type":"system","subtype":"init","session_id":"s1","model":"m"}');
    const events = p.finish({ t: 'exit', code: 1, signal: null, stderr: 'boom\nbad things' });

    const err = events.find((e) => e.t === 'error');
    assert.ok(err && /終了コード 1/.test(err.message));
    assert.match(err.message, /bad things/, 'stderr の末尾を残す');
    const end = events.find((e) => e.t === 'turn_end');
    assert.ok(end && end.ok === false);
  });

  test('SIGTERM で殺された場合はシグナルを報告する', () => {
    const p = new ClaudeParser();
    const events = p.finish({ t: 'exit', code: null, signal: 'SIGTERM', stderr: '' });
    const err = events.find((e) => e.t === 'error');
    assert.ok(err && /SIGTERM/.test(err.message));
  });

  test('ツール引数から表示用の 1 行を作る', () => {
    assert.equal(toolDetail({ file_path: '/a/b.ts' }), '/a/b.ts');
    assert.equal(toolDetail({ command: 'npm test' }), 'npm test');
    assert.equal(toolDetail({ unknown: 1 }), '');
    assert.equal(toolDetail(null), '');
  });
});

// ---------------------------------------------------------------------------

describe('CodexParser — 読み取りのみのターン (B1)', () => {
  const events = runCapture(new CodexParser(), 'codex_B1_readonly.jsonl');

  test('thread_id がセッション ID になる', () => {
    const started = only(events, 'session_started');
    assert.equal(started.length, 1);
    assert.equal(started[0]!.sessionId, '019ff6a2-024e-7e50-bbe2-56218772a9b3');
  });

  test('シェル実行が tool_start / command_run / tool_end になる', () => {
    const starts = only(events, 'tool_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.name, 'Bash');
    assert.match(starts[0]!.detail, /sed -n/);

    const cmds = only(events, 'command_run');
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0]!.exitCode, 0);

    assert.equal(only(events, 'tool_end')[0]!.ok, true);
  });

  test('文脈サイズは概算になる', () => {
    const usage = only(events, 'usage');
    assert.equal(usage[0]!.estimated, true, 'ゲージに ~ を出すため');
    // 累計 32782 ÷ (ツール 1 回 + 1) = 16391
    assert.equal(usage[0]!.contextTokens, 16_391);
    assert.equal(usage[0]!.cumulativeInputTokens, 32_782);
  });

  test('最後の agent_message がターンの結果になる', () => {
    assert.equal(only(events, 'turn_end')[0]!.result, 'add');
  });
});

describe('CodexParser — ファイル編集のターン (B3)', () => {
  const events = runCapture(new CodexParser(), 'codex_B3_edit.jsonl');

  test('file_change から file_edited が出る', () => {
    const edits = only(events, 'file_edited');
    assert.equal(edits.length, 1);
    assert.match(edits[0]!.path, /calc\.js$/);
    assert.equal(edits[0]!.kind, 'update');
  });

  test('読み取りもシェル経由なので command_run に数えられる', () => {
    // codex には Read 相当のツールが無く、sed / git などで読む（FINDINGS §2.2）
    assert.equal(only(events, 'command_run').length, 3);
  });
});

describe('CodexParser — 累計トークンからの文脈推定 (B4 / B5)', () => {
  test('前ターンの累計との差分で出す', () => {
    // B3 の終了時点が 85303、B4 はツール実行なしなので差分がそのまま文脈サイズ
    const b4 = runCapture(
      new CodexParser({ prevInputTokens: 85_303, prevOutputTokens: 758 }),
      'codex_B4_resume.jsonl',
    );
    const u4 = only(b4, 'usage')[0]!;
    assert.equal(u4.contextTokens, 17_466);
    assert.equal(u4.inputTokens, 17_466, 'このターンの消費量も差分で出す');
    assert.equal(u4.outputTokens, 5);
    assert.equal(u4.cumulativeInputTokens, 102_769);

    // 続けて B5。累計を持ち回れば一貫した値になる
    const b5 = runCapture(
      new CodexParser({
        prevInputTokens: u4.cumulativeInputTokens,
        prevOutputTokens: u4.cumulativeOutputTokens,
      }),
      'codex_B5_ctx.jsonl',
    );
    const u5 = only(b5, 'usage')[0]!;
    assert.equal(u5.contextTokens, 17_483);
    assert.ok(
      Math.abs(u5.contextTokens - u4.contextTokens) < 100,
      '連続するターンで文脈サイズがほぼ一致する（推定式が妥当）',
    );
  });

  test('累計を渡さないと過大になる', () => {
    const events = runCapture(new CodexParser(), 'codex_B5_ctx.jsonl');
    assert.equal(only(events, 'usage')[0]!.contextTokens, 120_252, '前回値なしでは累計がそのまま出る');
  });

  test('ツールを使わなかったターンは記憶から答えている', () => {
    const events = runCapture(new CodexParser({ prevInputTokens: 85_303 }), 'codex_B4_resume.jsonl');
    assert.equal(only(events, 'tool_start').length, 0);
    assert.equal(only(events, 'turn_end')[0]!.result, 'sub');
  });
});

describe('CodexParser — 異常系', () => {
  test('壊れた行を無視する', () => {
    const p = new CodexParser();
    assert.deepEqual(p.push('nope'), []);
    assert.deepEqual(p.push('{"type":"unknown.thing"}'), []);
  });

  test('turn_end を見ないまま終了したら失敗として閉じる', () => {
    const p = new CodexParser();
    p.push('{"type":"thread.started","thread_id":"t1"}');
    const events = p.finish({ t: 'exit', code: 2, signal: null, stderr: 'error: unexpected argument' });
    assert.ok(events.some((e) => e.t === 'error' && /unexpected argument/.test(e.message)));
    assert.equal(events.find((e) => e.t === 'turn_end')?.ok, false);
  });
});
