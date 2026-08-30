/** ログ画面（SPEC §15.5）。全セッションの出来事を時系列で。 */

import type { PanelLine } from './panel.ts';
import type { Theme } from '../theme.ts';
import type { AgentEvent } from '../../core/types.ts';

export interface LogEntry {
  at: number;
  sessionId: string | null;
  sessionName: string;
  kind: 'agent' | 'system';
  event?: AgentEvent;
  text: string;
}

export const LOG_CAPACITY = 2_000;

export class LogBuffer {
  #entries: LogEntry[] = [];

  push(entry: LogEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > LOG_CAPACITY) {
      this.#entries.splice(0, this.#entries.length - LOG_CAPACITY);
    }
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  filtered(sessionId: string | null): LogEntry[] {
    if (!sessionId) return [...this.#entries];
    return this.#entries.filter((e) => e.sessionId === sessionId);
  }
}

function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

/** AgentEvent を 1 行の日本語にする。出せないものは null。 */
export function describeEvent(ev: AgentEvent): string | null {
  switch (ev.t) {
    case 'session_started':
      return `セッション開始 (${ev.model})`;
    case 'thinking':
      return `思考中… ${ev.estimatedTokens} tok`;
    case 'tool_start':
      return `${ev.parentToolUseId ? '  └ ' : ''}⚙ ${ev.name} ${ev.detail}`;
    case 'tool_end':
      return ev.ok ? null : `× ${ev.name} 失敗`;
    case 'subagent_start':
      return `サブエージェント起動: ${ev.agentType}「${ev.description}」`;
    case 'subagent_progress':
      return `  └ ${ev.lastToolName || '作業'}: ${ev.description} (${ev.totalTokens} tok)`;
    case 'subagent_end':
      return `サブエージェント終了: ${ev.ok ? '完了' : '失敗'}`;
    case 'file_edited':
      return `編集 ${ev.path}`;
    case 'command_run':
      return `実行 ${ev.cmd}`;
    case 'permission_denied':
      return `承認待ち: ${ev.toolName}`;
    case 'rate_limit':
      return `レート制限: ${ev.status}`;
    case 'turn_end':
      return ev.ok ? 'ターン完了' : `ターン失敗: ${ev.result}`;
    case 'error':
      return `エラー: ${ev.message}`;
    default:
      return null;
  }
}

export function logLines(entries: readonly LogEntry[], theme: Theme): PanelLine[] {
  return entries.map((e) => ({
    text: `${clock(e.at)}  ${e.sessionName.padEnd(10)} ${e.text}`,
    color: e.kind === 'system' ? theme.system : theme.text,
    dim: e.kind === 'agent' && e.text.startsWith('  └'),
  }));
}
