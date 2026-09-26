/** 明示実行時だけ実モデルを使う。会話は ephemeral で保存しない。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexRpc, type RpcMessage } from '../src/core/drivers/codex-rpc.ts';

test('実Codexの同じターンに途中指示を追加できる', {
  skip: process.env.AD_CODEX_STEER_LIVE !== '1', timeout: 90_000,
}, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'dashboard-steer-live-'));
  const events: RpcMessage[] = [];
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const rpc = new CodexRpc('codex', cwd, (message) => {
    events.push(message);
    if (message.method === 'turn/completed') finish();
  });
  const initialId = randomUUID();
  const addedId = randomUUID();
  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent_dashboard_live_test', version: '0.1.0' } });
    rpc.send({ method: 'initialized', params: {} });
    const thread = await rpc.request('thread/start', { cwd, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    const threadId = thread.thread.id;
    const started = await rpc.request('turn/start', { threadId, clientUserMessageId: initialId,
      input: [{ type: 'text', text: '接続確認です。ツールは使わず、CHECK_INITIAL とだけ回答してください。' }] });
    const accepted = await rpc.request('turn/steer', { threadId, expectedTurnId: started.turn.id,
      clientUserMessageId: addedId,
      input: [{ type: 'text', text: '途中の追加指示です。回答を STEER_OK という1語に変更してください。ツールは使わないでください。' }] });
    assert.equal(accepted.turnId, started.turn.id);
    await Promise.race([done, rpc.closed.then(() => { throw new Error('完了前に接続が終了'); })]);
    assert.equal(events.filter((e) => e.method === 'turn/started').length, 1);
    assert.ok(events.some((e) => e.method === 'item/started' && e.params.item?.clientId === initialId), '初回メッセージを識別可能');
    assert.ok(events.some((e) => e.method === 'item/started' && e.params.item?.clientId === addedId), '途中送信を識別可能');
    const end = events.find((e) => e.method === 'turn/completed');
    assert.equal(end?.params.turn.status, 'completed', JSON.stringify(end?.params.turn.error));
    assert.ok(events.some((e) => e.method === 'item/completed' && e.params.item?.type === 'agentMessage' && e.params.item.text.includes('STEER_OK')));
  } finally {
    await rpc.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
