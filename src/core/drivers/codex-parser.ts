/**
 * codex の `--json` 出力を AgentEvent に正規化する。
 * イベント形はフェーズ 0 で実採取したもの（docs/phase0/FINDINGS.md §2.2）に基づく。
 *
 * claude より構造が素直で、type は thread.* / turn.* / item.* の 3 系統しかない。
 */

import type { AgentEvent } from '../types.ts';
import type { ProcEvent } from './process.ts';

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

export interface CodexParserOptions {
  /**
   * 前ターンまでの累計トークン。turn.completed.usage はスレッド生涯の累計なので、
   * 文脈サイズを出すには差分が要る（FINDINGS §5.2）。
   */
  prevInputTokens?: number;
  prevOutputTokens?: number;
  model?: string;
  strict?: boolean;
}

export class CodexParser {
  #prevInput: number;
  #prevOutput: number;
  #model: string;
  #strict: boolean;

  /** 文脈サイズの概算に使う。ターン内のモデル呼び出し回数 ≒ ツール実行回数 + 1 */
  #toolExecutions = 0;
  #lastText = '';
  #sawTurnEnd = false;
  #lines = 0;
  #failures = 0;

  constructor(opts: CodexParserOptions = {}) {
    this.#prevInput = opts.prevInputTokens ?? 0;
    this.#prevOutput = opts.prevOutputTokens ?? 0;
    this.#model = opts.model ?? '';
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
      this.#failures += 1;
      return [];
    }
  }

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
      case 'thread.started':
        return [{ t: 'session_started', sessionId: str(o.thread_id), model: this.#model }];

      case 'turn.started':
        return [{ t: 'requesting' }];

      case 'item.started':
        return this.#itemStarted(asRecord(o.item));

      case 'item.completed':
        return this.#itemCompleted(asRecord(o.item));

      case 'turn.completed':
        return this.#turnCompleted(asRecord(o.usage));

      case 'turn.failed':
      case 'error': {
        this.#sawTurnEnd = true;
        const message = str(o.message) || 'codex がエラーを返しました';
        return [
          { t: 'error', message },
          { t: 'turn_end', ok: false, result: message },
        ];
      }

      default:
        return [];
    }
  }

  #itemStarted(item: AnyRecord | null): AgentEvent[] {
    if (!item) return [];
    const id = str(item.id);

    if (item.type === 'command_execution') {
      return [{ t: 'tool_start', name: 'Bash', detail: str(item.command), toolUseId: id }];
    }
    if (item.type === 'file_change') {
      return [
        { t: 'tool_start', name: 'Edit', detail: this.#changePaths(item).join(', '), toolUseId: id },
      ];
    }
    return [];
  }

  #itemCompleted(item: AnyRecord | null): AgentEvent[] {
    if (!item) return [];
    const id = str(item.id);

    if (item.type === 'agent_message') {
      const delta = str(item.text);
      if (delta === '') return [];
      this.#lastText = delta;
      return [{ t: 'text', delta }];
    }

    if (item.type === 'command_execution') {
      this.#toolExecutions += 1;
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
      return [
        { t: 'command_run', cmd: str(item.command), exitCode },
        { t: 'tool_end', name: 'Bash', ok: exitCode === 0, toolUseId: id },
      ];
    }

    if (item.type === 'file_change') {
      const events: AgentEvent[] = [];
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const raw of changes) {
        const c = asRecord(raw);
        if (!c) continue;
        const path = str(c.path);
        if (path === '') continue;
        events.push({ t: 'file_edited', path, kind: this.#changeKind(str(c.kind)) });
      }
      events.push({
        t: 'tool_end',
        name: 'Edit',
        ok: str(item.status) !== 'failed',
        toolUseId: id,
      });
      return events;
    }

    return [];
  }

  #changePaths(item: AnyRecord): string[] {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return changes
      .map((raw) => str(asRecord(raw)?.path))
      .filter((p): p is string => p !== '');
  }

  /** 実測では update のみ確認済み。add / delete は推定（SPEC §22-2） */
  #changeKind(kind: string): 'add' | 'update' | 'delete' {
    if (kind === 'add' || kind === 'delete') return kind;
    return 'update';
  }

  #turnCompleted(usage: AnyRecord | null): AgentEvent[] {
    this.#sawTurnEnd = true;
    const events: AgentEvent[] = [];

    if (usage) {
      const cumulativeInput = num(usage.input_tokens);
      const cumulativeOutput = num(usage.output_tokens);
      const inputDelta = Math.max(0, cumulativeInput - this.#prevInput);
      const outputDelta = Math.max(0, cumulativeOutput - this.#prevOutput);

      // 差分をモデル呼び出し回数で割ると 1 回あたりの入力 ≒ 文脈サイズになる
      const calls = this.#toolExecutions + 1;
      const contextTokens = Math.round(inputDelta / calls);

      events.push({
        t: 'usage',
        contextTokens,
        estimated: true,
        inputTokens: inputDelta,
        outputTokens: outputDelta,
        cumulativeInputTokens: cumulativeInput,
        cumulativeOutputTokens: cumulativeOutput,
      });
    }

    events.push({ t: 'turn_end', ok: true, result: this.#lastText });
    return events;
  }
}
