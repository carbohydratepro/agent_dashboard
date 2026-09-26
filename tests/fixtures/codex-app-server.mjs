#!/usr/bin/env node
// ローカルのプロトコル試験専用。モデル・ネットワークは使わない。
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params: { threadId: 'thread-test', turnId: 'turn-test', ...params } });
let initialMessageId;
let active = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  appendFileSync('requests.jsonl', line + '\n');
  if (msg.method === 'initialize') send({ id: msg.id, result: {} });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    send({ id: msg.id, result: { thread: { id: 'thread-test' }, model: msg.params.model ?? 'test-model' } });
  }
  if (msg.method === 'turn/start') {
    initialMessageId = msg.params.clientUserMessageId;
    active = true;
    notify('turn/started', { turn: { id: 'turn-test', status: 'inProgress' } });
    notify('item/started', { item: { type: 'userMessage', id: 'initial', clientId: initialMessageId, content: msg.params.input } });
    send({ id: msg.id, result: { turn: { id: 'turn-test' } } });
    if (msg.params.input[0].text === 'crash') process.exit(1);
  }
  if (msg.method === 'turn/steer') {
    if (!active || msg.params.expectedTurnId !== 'turn-test' || msg.params.input[0].text === 'reject') {
      send({ id: msg.id, error: { message: 'steer rejected' } });
      return;
    }
    const item = { type: 'userMessage', id: 'followup', content: msg.params.input };
    notify('item/started', { item });
    notify('item/completed', { item });
    send({ id: msg.id, result: { turnId: 'turn-test' } });
    setTimeout(() => {
      notify('item/started', { item: { type: 'commandExecution', id: 'cmd1', command: 'test' } });
      notify('item/completed', { item: { type: 'commandExecution', id: 'cmd1', command: 'test', status: 'completed', exitCode: 0 } });
      notify('item/completed', { item: { type: 'fileChange', id: 'edit1', status: 'completed', changes: [{ path: 'sample.ts', kind: { type: 'update' } }] } });
      notify('item/agentMessage/delta', { itemId: 'reply', delta: '反映: ' });
      notify('item/agentMessage/delta', { itemId: 'reply', delta: msg.params.input[0].text });
      notify('item/completed', { item: { id: 'reply', type: 'agentMessage', text: '反映: ' + msg.params.input[0].text } });
      notify('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 200, outputTokens: 40 }, last: { inputTokens: 150 } } });
      active = false;
      notify('turn/completed', { turn: { id: 'turn-test', status: 'completed', error: null } });
    }, 50);
  }
});
