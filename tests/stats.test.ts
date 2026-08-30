/** 集計と識別名。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStats, tokensPerTask, utilization } from '../src/core/stats.ts';
import { colorForSlot, nextName, ROLE_PROMPT, ROLES } from '../src/core/naming.ts';

describe('集計', () => {
  test('初期値はすべて 0', () => {
    const stats = createStats();
    for (const [key, value] of Object.entries(stats)) {
      assert.equal(value, 0, `${key} が 0 でない`);
    }
  });

  test('稼働率は実働 / 経過', () => {
    assert.equal(utilization(600_000, 1_000_000), 0.6);
    assert.equal(utilization(0, 1_000), 0);
    assert.equal(utilization(500, 0), 0, '経過 0 で割らない');
    assert.equal(utilization(2_000, 1_000), 1, '1 を超えない');
  });

  test('1 タスクあたりのトークン', () => {
    const stats = createStats();
    stats.totalTokensIn = 90_000;
    stats.totalTokensOut = 10_000;
    stats.tasksCompleted = 10;
    assert.equal(tokensPerTask(stats), 10_000);

    stats.tasksCompleted = 0;
    assert.equal(tokensPerTask(stats), null, 'タスクが無ければ出せない');
  });
});

describe('識別名', () => {
  test('同じ種別の中で連番になる', () => {
    assert.equal(nextName('claude', []), 'claude-1');
    assert.equal(nextName('claude', ['claude-1']), 'claude-2');
    assert.equal(nextName('codex', ['claude-1', 'claude-2']), 'codex-1');
  });

  test('間が空いていれば埋める', () => {
    assert.equal(nextName('claude', ['claude-1', 'claude-3']), 'claude-2');
  });

  test('色はスロットで決まり、巡回する', () => {
    assert.equal(colorForSlot(0), colorForSlot(6));
    assert.notEqual(colorForSlot(0), colorForSlot(1));
  });
});

describe('役割', () => {
  test('すべての役割にプロンプトの定義がある', () => {
    for (const role of ROLES) {
      assert.equal(typeof ROLE_PROMPT[role], 'string', `${role} の定義が無い`);
    }
  });

  test('汎用は追記しない', () => {
    assert.equal(ROLE_PROMPT.general, '');
    assert.ok(ROLE_PROMPT.backend.length > 0);
  });
});
