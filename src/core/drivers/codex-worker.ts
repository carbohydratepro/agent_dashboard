/** 1ターンだけを担当する分離プロセス。stdoutは既存の追跡可能なJSONLへ書く。 */
import { createServer, type Socket } from 'node:net';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../types.ts';
import { CodexRpc, type RpcMessage } from './codex-rpc.ts';
import { steerSocketPath, type WorkerOptions } from './codex-app-server.ts';

const emit = (event: AgentEvent): void => {
  process.stdout.write(`${JSON.stringify({ type: 'dashboard.event', event })}\n`);
};
const textInput = (text: string) => [{ type: 'text', text }];

async function main(opts: WorkerOptions): Promise<void> {
  process.umask(0o077);
  let threadId = opts.threadId ?? '';
  let turnId = '';
  let finished = false;
  let result = '';
  let status = 'failed';
  let turnError = '';
  let usage: any = null;
  const initialMessageId = randomUUID();
  const userItems = new Set<string>();
  const streamed = new Set<string>();
  const clients = new Set<Socket>();
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });

  const rpc = new CodexRpc(opts.bin, opts.cwd, (message: RpcMessage) => {
    const p = message.params ?? {};
    if (message.id !== undefined && message.method) {
      // exec と同様、ここで権限を自動承認しない。対話入力要求も明示的に返す。
      if (message.method === 'item/commandExecution/requestApproval' ||
          message.method === 'item/fileChange/requestApproval') {
        rpc.send({ id: message.id, result: { decision: 'decline' } });
        emit({ t: 'permission_denied', toolName: p.command ? 'Bash' : 'Edit',
          toolUseId: p.itemId ?? '', toolInput: {}, message: 'Codexの権限確認が必要です。' });
      } else {
        rpc.send({ id: message.id, error: { code: -32601, message: 'このダッシュボードはこの対話要求に未対応です。' } });
      }
      return;
    }
    if (p.threadId && p.threadId !== threadId) return;
    if (p.turnId && turnId && p.turnId !== turnId) return;
    if (message.method === 'turn/started') {
      turnId = p.turn.id;
      emit({ t: 'requesting' });
    } else if (message.method === 'thread/tokenUsage/updated') {
      usage = p.tokenUsage;
    } else if (message.method === 'item/agentMessage/delta') {
      streamed.add(p.itemId);
      emit({ t: 'text', delta: p.delta });
    } else if (message.method === 'item/started' || message.method === 'item/completed') {
      const item = p.item;
      if (!item) return;
      const done = message.method === 'item/completed';
      const id = item.id ?? '';
      if (item.type === 'userMessage' && !userItems.has(id)) {
        userItems.add(id);
        const text = (item.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        if (item.clientId !== initialMessageId) emit({ t: 'user_message', text });
      } else if (item.type === 'agentMessage' && done) {
        if (!streamed.has(id) && item.text) emit({ t: 'text', delta: item.text });
        streamed.delete(id);
        result = item.text ?? result;
      } else if (item.type === 'commandExecution') {
        if (!done) emit({ t: 'tool_start', name: 'Bash', detail: item.command, toolUseId: id });
        else {
          emit({ t: 'command_run', cmd: item.command, exitCode: item.exitCode ?? null });
          emit({ t: 'tool_end', name: 'Bash', ok: item.status === 'completed', toolUseId: id });
        }
      } else if (item.type === 'fileChange') {
        if (!done) emit({ t: 'tool_start', name: 'Edit', detail: (item.changes ?? []).map((c: any) => c.path).join(', '), toolUseId: id });
        else {
          if (item.status === 'completed') for (const change of item.changes ?? []) {
            const kind = change.kind?.type ?? change.kind;
            emit({ t: 'file_edited', path: change.path, kind: kind === 'add' || kind === 'delete' ? kind : 'update' });
          }
          emit({ t: 'tool_end', name: 'Edit', ok: item.status === 'completed', toolUseId: id });
        }
      } else if (item.type === 'mcpToolCall' || item.type === 'webSearch') {
        const name = item.tool ?? 'WebSearch';
        if (!done) emit({ t: 'tool_start', name, detail: item.query ?? item.server ?? '', toolUseId: id });
        else emit({ t: 'tool_end', name, ok: !item.error, toolUseId: id });
      }
    } else if (message.method === 'turn/completed') {
      finished = true;
      status = p.turn.status;
      turnError = p.turn.error?.message ?? '';
      complete();
    } else if (message.method === 'error' && !p.willRetry) {
      turnError = p.error?.message ?? 'Codexがエラーを返しました。';
    }
  });

  const interrupt = () => {
    finished = true;
    status = 'interrupted';
    complete();
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  void rpc.closed.then(() => {
    if (!finished) { turnError ||= 'Codex App Server が応答の途中で終了しました。'; complete(); }
  });

  // 同じユーザーだけが接続できる短いUnixソケット。PIDを含み、前ターンと混同しない。
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.setTimeout(15_000, () => socket.destroy());
    let input = '';
    let handled = false;
    socket.on('data', (data) => {
      if (handled) return;
      input += data;
      if (Buffer.byteLength(input) > 1_048_576) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.split('\n')[0]!);
          if (request.threadId !== threadId || typeof request.prompt !== 'string' || !request.prompt.trim()) {
            throw new Error('追加指示の対象または文章が不正です。');
          }
          if (!turnId || finished) throw new Error('現在は追加指示を受け付けられません。実行状態を確認してください。');
          await rpc.request('turn/steer', {
            threadId, expectedTurnId: turnId, input: textInput(request.prompt),
          }, 10_000);
          socket.end(`${JSON.stringify({ ok: true })}\n`);
        } catch (err) {
          socket.end(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
        }
      })();
    });
  });

  try {
    await rpc.request('initialize', { clientInfo: { name: 'agent_dashboard', version: '0.1.0' } });
    rpc.send({ method: 'initialized', params: {} });
    const params: Record<string, unknown> = { cwd: opts.cwd };
    if (opts.model) params.model = opts.model;
    if (opts.reasoning) params.config = { model_reasoning_effort: opts.reasoning };
    if (!opts.threadId && opts.sandbox) params.sandbox = opts.sandbox;
    if (opts.threadId) { params.threadId = opts.threadId; params.excludeTurns = true; }
    const response = await rpc.request(opts.threadId ? 'thread/resume' : 'thread/start', params);
    threadId = response.thread.id;
    emit({ t: 'session_started', sessionId: threadId, model: response.model ?? opts.model ?? '' });
    if (opts.outFile) {
      const path = steerSocketPath(opts.outFile, process.pid);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => { chmodSync(path, 0o600); resolve(); });
      });
    }
    if (!finished) {
      const response = await rpc.request('turn/start', {
        threadId, input: textInput(opts.prompt), clientUserMessageId: initialMessageId,
      });
      turnId = response.turn.id;
      await completion;
    }
  } catch (err) {
    turnError = err instanceof Error ? err.message : String(err);
  } finally {
    finished = true;
    if (server.listening) server.close();
    // 応答済みソケットは書込をflushしてから閉じる。保留要求はRPCの切断で失敗する。
    await rpc.close();
    for (const socket of clients) socket.destroySoon();
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
  if (usage?.total) {
    const input = usage.total.inputTokens ?? 0;
    const output = usage.total.outputTokens ?? 0;
    emit({ t: 'usage', contextTokens: usage.last?.inputTokens ?? 0, estimated: true,
      inputTokens: Math.max(0, input - (opts.prevInputTokens ?? 0)),
      outputTokens: Math.max(0, output - (opts.prevOutputTokens ?? 0)),
      cumulativeInputTokens: input, cumulativeOutputTokens: output });
  }
  if (turnError) emit({ t: 'error', message: turnError });
  emit({ t: 'turn_end', ok: status === 'completed' && !turnError, result: turnError || result });
}

void main(JSON.parse(process.argv[2]!)).catch((err) => {
  emit({ t: 'error', message: String(err) });
  emit({ t: 'turn_end', ok: false, result: String(err) });
  process.exitCode = 1;
});
