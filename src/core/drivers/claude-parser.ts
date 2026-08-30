/**
 * claude の `--output-format stream-json` を AgentEvent に正規化する。
 * イベント形はフェーズ 0 で実採取したもの（docs/phase0/FINDINGS.md §2.1）に基づく。
 *
 * 未知の種別は無視する。落ちないことを最優先にする（SPEC §5.3）。
 */

import type { AgentEvent } from '../types.ts';
import type { ProcEvent } from './process.ts';

/** ファイルを変更するツールと、その変更種別 */
const EDIT_TOOLS: Record<string, 'add' | 'update' | 'delete'> = {
  Edit: 'update',
  MultiEdit: 'update',
  NotebookEdit: 'update',
  Write: 'add',
};

/** サブエージェント起動ツール。専用イベントで扱うので tool_start は出さない（FINDINGS §4.1） */
const AGENT_TOOL = 'Agent';

/** パース不能な行がこの割合を超えたらスキーマ不整合とみなす（SPEC §5.3） */
const PARSE_FAILURE_THRESHOLD = 0.2;

interface AnyRecord {
  [key: string]: unknown;
}

function asRecord(v: unknown): AnyRecord | null {
  return typeof v === 'object' && v !== null ? (v as AnyRecord) : null;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * ツール引数から画面に出す 1 行を作る。
 * ヒアドキュメントなど改行を含む引数がそのまま来るので、必ず 1 行に潰す。
 */
export function toolDetail(input: unknown): string {
  const rec = asRecord(input);
  if (!rec) return '';
  for (const key of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return v.replace(/\s+/g, ' ').trim();
  }
  return '';
}

export interface ClaudeParserOptions {
  /** 検証用。パース失敗率の判定を切りたいときに使う */
  strict?: boolean;
}

export class ClaudeParser {
  #toolNames = new Map<string, string>();
  #toolInputs = new Map<string, unknown>();
  #denialMessages = new Map<string, string>();
  #endedSubagents = new Set<string>();
  /** task_updated で完了を見たが、まだ task_notification が来ていないサブエージェント */
  #pendingSubagentEnds = new Map<string, boolean>();
  #lastAssistantUsage: AnyRecord | null = null;
  #sawTurnEnd = false;
  #lines = 0;
  #failures = 0;
  #strict: boolean;

  constructor(opts: ClaudeParserOptions = {}) {
    this.#strict = opts.strict ?? true;
  }

  get sawTurnEnd(): boolean {
    return this.#sawTurnEnd;
  }

  push(line: string): AgentEvent[] {
    this.#lines += 1;
    let o: AnyRecord | null;
    try {
      o = asRecord(JSON.parse(line));
    } catch {
      this.#failures += 1;
      return [];
    }
    if (!o) {
      this.#failures += 1;
      return [];
    }
    try {
      return this.#handle(o);
    } catch {
      // 想定外の形でも落とさない
      this.#failures += 1;
      return [];
    }
  }

  /** プロセス終了時。turn_end を見ていなければ異常終了として扱う。 */
  finish(exit: Extract<ProcEvent, { t: 'exit' }>): AgentEvent[] {
    const events: AgentEvent[] = [];

    if (this.#strict && this.#lines > 0 && this.#failures / this.#lines > PARSE_FAILURE_THRESHOLD) {
      events.push({
        t: 'error',
        message: `出力を解釈できません（${this.#failures}/${this.#lines} 行が不正）。CLI のバージョンを確認してください。`,
      });
    }

    if (!this.#sawTurnEnd) {
      const tail = exit.stderr.trim().split('\n').slice(-10).join('\n');
      const reason = exit.signal
        ? `シグナル ${exit.signal} で終了しました`
        : `終了コード ${exit.code} で終了しました`;
      events.push({ t: 'error', message: tail ? `${reason}\n${tail}` : reason });
      events.push({ t: 'turn_end', ok: false, result: reason });
    }
    return events;
  }

  #handle(o: AnyRecord): AgentEvent[] {
    switch (o.type) {
      case 'system':
        return this.#handleSystem(o);
      case 'assistant':
        return this.#handleAssistant(o);
      case 'user':
        return this.#handleUser(o);
      case 'rate_limit_event':
        return this.#handleRateLimit(o);
      case 'result':
        return this.#handleResult(o);
      // 部分メッセージは量が多いので早期に捨てる（FINDINGS §7.4）
      case 'stream_event':
      default:
        return [];
    }
  }

  #handleSystem(o: AnyRecord): AgentEvent[] {
    switch (o.subtype) {
      case 'init':
        return [
          {
            t: 'session_started',
            sessionId: str(o.session_id),
            model: str(o.model),
          },
        ];

      case 'status':
        return str(o.status) === 'requesting' ? [{ t: 'requesting' }] : [];

      case 'thinking_tokens':
        return [{ t: 'thinking', estimatedTokens: num(o.estimated_tokens) }];

      case 'permission_denied':
        // 引数は result.permission_denials[] にしか無いので、ここでは理由だけ覚えておく
        this.#denialMessages.set(str(o.tool_use_id), str(o.message));
        return [];

      case 'task_started':
        return [
          {
            t: 'subagent_start',
            taskId: str(o.task_id),
            toolUseId: str(o.tool_use_id),
            agentType: str(o.subagent_type) || 'general-purpose',
            description: str(o.description),
          },
        ];

      case 'task_progress': {
        const usage = asRecord(o.usage) ?? {};
        return [
          {
            t: 'subagent_progress',
            taskId: str(o.task_id),
            description: str(o.description),
            lastToolName: str(o.last_tool_name),
            totalTokens: num(usage.total_tokens),
            toolUses: num(usage.tool_uses),
            durationMs: num(usage.duration_ms),
          },
        ];
      }

      case 'task_notification':
        // 成果報告（summary）はこちらにしか無いので、サブエージェントの終了はここで確定させる
        return this.#endSubagent(str(o.task_id), str(o.status) === 'completed', str(o.summary));

      case 'task_updated': {
        const patch = asRecord(o.patch) ?? {};
        const status = str(patch.status);
        if (status !== 'completed' && status !== 'failed') return [];
        // task_updated は task_notification より先に届く。ここで終了させると
        // summary を取り逃すので、通知が来なかった場合の保険として控えておく。
        const taskId = str(o.task_id);
        if (taskId !== '' && !this.#endedSubagents.has(taskId)) {
          this.#pendingSubagentEnds.set(taskId, status === 'completed');
        }
        return [];
      }

      default:
        return [];
    }
  }

  /** 同じサブエージェントを二重に終了させない */
  #endSubagent(taskId: string, ok: boolean, summary: string): AgentEvent[] {
    if (taskId === '' || this.#endedSubagents.has(taskId)) return [];
    this.#endedSubagents.add(taskId);
    return [{ t: 'subagent_end', taskId, ok, summary }];
  }

  #handleAssistant(o: AnyRecord): AgentEvent[] {
    const message = asRecord(o.message);
    if (!message) return [];

    const usage = asRecord(message.usage);
    if (usage) this.#lastAssistantUsage = usage;

    const parent = str(o.parent_tool_use_id) || undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    const events: AgentEvent[] = [];

    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;

      if (block.type === 'text') {
        const delta = str(block.text);
        if (delta !== '') {
          events.push(parent ? { t: 'text', delta, parentToolUseId: parent } : { t: 'text', delta });
        }
        continue;
      }

      if (block.type === 'tool_use') {
        const id = str(block.id);
        const name = str(block.name);
        this.#toolNames.set(id, name);
        this.#toolInputs.set(id, block.input);

        // Agent は system/task_* で扱うので、ここでは出さない
        if (name === AGENT_TOOL) continue;

        const ev: Extract<AgentEvent, { t: 'tool_start' }> = {
          t: 'tool_start',
          name,
          detail: toolDetail(block.input),
          toolUseId: id,
        };
        if (parent) ev.parentToolUseId = parent;
        events.push(ev);
      }
    }
    return events;
  }

  #handleUser(o: AnyRecord): AgentEvent[] {
    const message = asRecord(o.message);
    if (!message) return [];

    const parent = str(o.parent_tool_use_id) || undefined;
    const content = Array.isArray(message.content) ? message.content : [];
    const events: AgentEvent[] = [];

    for (const raw of content) {
      const block = asRecord(raw);
      if (!block || block.type !== 'tool_result') continue;

      const id = str(block.tool_use_id);
      const name = this.#toolNames.get(id) ?? '';
      if (name === AGENT_TOOL) continue;

      const ok = block.is_error !== true;
      const end: Extract<AgentEvent, { t: 'tool_end' }> = { t: 'tool_end', name, ok, toolUseId: id };
      if (parent) end.parentToolUseId = parent;
      events.push(end);

      if (!ok) continue;

      // claude には file_edited / command_run 相当のイベントが無いので、
      // ツール名と引数から導出する
      const input = asRecord(this.#toolInputs.get(id));
      const kind = EDIT_TOOLS[name];
      if (kind && input) {
        const path = str(input.file_path);
        if (path !== '') events.push({ t: 'file_edited', path, kind });
      }
      if (name === 'Bash' && input) {
        const cmd = str(input.command);
        if (cmd !== '') events.push({ t: 'command_run', cmd, exitCode: null });
      }
    }
    return events;
  }

  #handleRateLimit(o: AnyRecord): AgentEvent[] {
    const info = asRecord(o.rate_limit_info);
    if (!info) return [];
    const event: Extract<AgentEvent, { t: 'rate_limit' }> = {
      t: 'rate_limit',
      status: str(info.status),
      resetsAt: num(info.resetsAt),
      rateLimitType: str(info.rateLimitType),
      isUsingOverage: info.isUsingOverage === true,
    };
    if (typeof info.overageStatus === 'string') event.overageStatus = info.overageStatus;
    if (typeof info.overageResetsAt === 'number') event.overageResetsAt = info.overageResetsAt;
    return [event];
  }

  #handleResult(o: AnyRecord): AgentEvent[] {
    const events: AgentEvent[] = [];

    // task_notification が来なかったサブエージェントをここで閉じる（スロットに残り続けないように）
    for (const [taskId, ok] of this.#pendingSubagentEnds) {
      events.push(...this.#endSubagent(taskId, ok, ''));
    }
    this.#pendingSubagentEnds.clear();

    // 文脈サイズは「最後の assistant メッセージの usage」から出す。
    // result.usage はターン内の全モデル呼び出しの累計なので使えない（FINDINGS §5.1）
    const last = this.#lastAssistantUsage;
    if (last) {
      const contextTokens =
        num(last.input_tokens) +
        num(last.cache_creation_input_tokens) +
        num(last.cache_read_input_tokens);

      const total = asRecord(o.usage) ?? {};
      events.push({
        t: 'usage',
        contextTokens,
        estimated: false,
        inputTokens:
          num(total.input_tokens) +
          num(total.cache_creation_input_tokens) +
          num(total.cache_read_input_tokens),
        outputTokens: num(total.output_tokens),
      });
    }

    // 承認待ち書。引数はここにしか無い（FINDINGS §3.1）
    const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
    for (const raw of denials) {
      const d = asRecord(raw);
      if (!d) continue;
      const toolUseId = str(d.tool_use_id);
      events.push({
        t: 'permission_denied',
        toolName: str(d.tool_name),
        toolUseId,
        toolInput: (asRecord(d.tool_input) ?? {}) as Record<string, unknown>,
        message: this.#denialMessages.get(toolUseId) ?? '権限が付与されていません',
      });
    }

    this.#sawTurnEnd = true;
    events.push({
      t: 'turn_end',
      ok: o.subtype === 'success' && o.is_error !== true,
      result: str(o.result),
    });
    return events;
  }
}
