/** AgentDriver 抽象（SPEC §5） */

import type { AgentEvent, AgentKind } from '../types.ts';

/** 両方のドライバに共通する 1 ターン分の入力 */
interface CommonOpts {
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  /** 生の JSONL 行をそのまま受け取る。raw.jsonl への追記に使う（SPEC §14.2） */
  onRawLine?: (line: string) => void;
  /**
   * codex 用。前ターンまでの累計トークン。
   * turn.completed.usage が累計値なので、文脈サイズを出すには差分が要る（FINDINGS §5.2）。
   */
  prevInputTokens?: number;
  prevOutputTokens?: number;
  /** 出力の置き場所。渡すと子を切り離し、親が落ちても走り続ける。 */
  outFile?: string;
  /** 起動できたら呼ぶ。PID を控えて、あとで追いかけ直すために使う。 */
  onStarted?: (info: { pid: number; outFile: string }) => void;
}

export interface StartOpts extends CommonOpts {
  /** codex の推論の深さ。null なら config.toml のまま。 */
  reasoning?: string | null;
  /** claude はこちらで UUID を採番できる。codex は無視され、後から thread_id が返る */
  sessionId?: string;
  model?: string | null;
  /** null なら引数を渡さず CLI の既定に従う（SPEC §1） */
  permissionMode?: string | null;
  sandbox?: string | null;
}

export interface TurnOpts extends CommonOpts {
  /** 承認待ち承認時にのみ渡す（SPEC §8.4） */
  allowedTools?: string[];
  /** null なら引数を渡さず CLI の既定に従う（SPEC §1） */
  permissionMode?: string | null;
  /** 途中でモデルを変えたとき。null なら開始時のまま。 */
  model?: string | null;
  /** codex の推論の深さ。null なら config.toml のまま。 */
  reasoning?: string | null;
}

/** すでに走っているものを追いかけ直すとき */
export interface AttachOpts {
  pid: number;
  outFile: string;
  cwd: string;
  signal?: AbortSignal;
  onRawLine?: (line: string) => void;
  prevInputTokens?: number;
  prevOutputTokens?: number;
  model?: string | null;
}

export interface AgentDriver {
  readonly kind: AgentKind;
  /** 新規セッションを開始し、最初のターンを実行する */
  start(opts: StartOpts): AsyncIterable<AgentEvent>;
  /** 既存セッションを再開して 1 ターン実行する */
  resume(sessionId: string, opts: TurnOpts): AsyncIterable<AgentEvent>;
  /** ダッシュボードを立ち上げ直したとき、走ったままのものを追いかける */
  attach?(opts: AttachOpts): AsyncIterable<AgentEvent>;
}
