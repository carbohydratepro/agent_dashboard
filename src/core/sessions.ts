/**
 * すでにある CLI のセッションを見つけて、セッションとして取り込めるようにする。
 *
 * 端末で直接 `claude` や `codex` を動かして始めた会話も、
 * セッション ID さえ分かれば `--resume` で続けられる。
 *
 * 保存場所（実測）:
 *   claude … ~/.claude/projects/<cwd をエンコード>/<セッションID>.jsonl
 *            ファイル名がそのままセッション ID。
 *            レコードに cwd があり、ai-title に生成されたタイトルが入る。
 *   codex  … ~/.codex/sessions/<年>/<月>/<日>/rollout-<時刻>-<スレッドID>.jsonl
 *            先頭の session_meta に session_id と cwd がある。
 *            ~/.codex/session_index.jsonl の thread_name に Codex が生成した題名がある。
 */

import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { AgentKind, SessionLifetime, TokenUsage } from './types.ts';

export interface ExistingSession {
  kind: AgentKind;
  /** --resume に渡す ID */
  sessionId: string;
  /** 会話が始まった作業ディレクトリ */
  cwd: string;
  /** 一覧に出す見出し */
  title: string;
  updatedAt: number;
  path: string;
  /** resume で分割された同一会話のログ。古い順に読み合わせる。 */
  paths?: string[];
}

/** 会話ログから復元した 1 項目 */
export type TranscriptItem =
  | { t: 'user'; text: string }
  | { t: 'assistant'; text: string }
  | { t: 'tool'; name: string; detail: string };

/** 取り込む会話の実績 */
export interface CarriedExperience {
  /** こちらから送った回数。こなしたタスク数の目安 */
  turns: number;
  filesEdited: number;
  commandsRun: number;
}

export interface ReadTranscriptOptions {
  /** 画面に残す項目数の上限。古いものから捨てる */
  maxItems?: number;
  /** 明示した場合だけ、読み込むログ全体をこのバイト数に制限する */
  maxBytes?: number;
}

export interface ListSessionsOptions {
  claudeRoot?: string;
  codexRoot?: string;
  /** Codex が生成した会話題名の索引。主にテストで差し替える。 */
  codexIndexPath?: string;
  /** 新しい順に何件まで見るか。全部読むと遅い */
  limit?: number;
  headBytes?: number;
}

/** 統計画面に出す、1 会話ターンぶんの実測トークン。 */
export interface TurnUsage {
  id: string;
  index: number;
  label: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  complete: boolean;
  tokens: TokenUsage;
}

/** CLI の保存ログを一巡して得た全期間集計。 */
export interface SessionAnalysis {
  lifetime: SessionLifetime;
  turns: TurnUsage[];
}

/** ファイルの先頭だけ読む。会話ログは大きいので全部は読まない。 */
export function readHead(path: string, bytes: number): string {
  const size = statSync(path).size;
  const length = Math.min(size, bytes);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, 0);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  // 末尾は行の途中で切れているので落とす
  const lastNewline = text.lastIndexOf('\n');
  return lastNewline >= 0 ? text.slice(0, lastNewline) : text;
}

function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const o: unknown = JSON.parse(line);
      if (typeof o === 'object' && o !== null) yield o as Record<string, unknown>;
    } catch {
      // 壊れた行は飛ばす
    }
  }
}

/**
 * 大きな JSONL を一括でメモリへ載せず、1 行ずつ読む。
 * 改行は UTF-8 の継続バイトにならないため、Buffer 上で安全に区切れる。
 */
function* textLinesFromFile(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);

  try {
    while (true) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;

      const data = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, read)])
        : chunk.subarray(0, read);
      let start = 0;
      while (true) {
        const end = data.indexOf(0x0a, start);
        if (end < 0) break;
        const line = data.toString('utf8', start, end);
        start = end + 1;
        if (line.trim() !== '') yield line;
      }
      pending = Buffer.from(data.subarray(start));
    }

    if (pending.length > 0) {
      const line = pending.toString('utf8');
      if (line.trim() !== '') yield line;
    }
  } finally {
    closeSync(fd);
  }
}

function* jsonLinesFromFile(
  path: string,
  acceptLine?: (line: string) => boolean,
): Generator<Record<string, unknown>> {
  for (const line of textLinesFromFile(path)) {
    if (acceptLine && !acceptLine(line)) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value === 'object' && value !== null) {
        yield value as Record<string, unknown>;
      }
    } catch {
      // 壊れた行と書き込み途中の最終行は飛ばす
    }
  }
}

/** 巨大なコマンド結果や暗号化済み思考を JSON.parse する前に除外する。 */
function isCodexTranscriptLine(line: string): boolean {
  // 種別は行頭近くにある。本文中に同じ文字があっても、余分に 1 行読むだけで実害はない。
  const head = line.slice(0, 2_048);
  return (
    head.includes('"type":"user_message"') ||
    head.includes('"type":"agent_message"') ||
    head.includes('"type":"message"') ||
    head.includes('"type":"custom_tool_call"')
  );
}

/** 見出しにできない、注入された指示文かどうか */
function looksLikeInjectedInstruction(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith('# AGENTS.md instructions') ||
    head.includes('AGENTS.md instructions') ||
    head.startsWith('<INSTRUCTIONS>') ||
    head.startsWith('<system-reminder') ||
    // codex は resume のたびに、これまでの履歴を user 発話として差し込む
    head.startsWith('The following is the Codex agent history') ||
    head.startsWith('<user_instructions>') ||
    head.startsWith('<environment_context>')
  );
}

/** 見出しに使えない、機械向けの出力かどうか */
function looksLikeMachineOutput(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('{') || head.startsWith('[') || head.startsWith('<');
}

/** 長い発話を 1 行の見出しにする */
export function toTitle(text: string, max = 60): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      texts.push(block);
      continue;
    }
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') texts.push(b.text);
    }
  }
  return texts.join('\n');
}

// ---------------------------------------------------------------------------
// 会話の中身を読み戻す
// ---------------------------------------------------------------------------

/** ファイルを読む。大きすぎるものは末尾だけ。 */
function readForTranscript(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  if (size <= maxBytes) return readFileSync(path, 'utf8');

  const buffer = Buffer.alloc(maxBytes);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, maxBytes, size - maxBytes);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
}

/**
 * ツール引数から画面に出す 1 行を作る。
 * ヒアドキュメントなど改行を含む引数がそのまま来るので、必ず 1 行に潰す。
 */
function toolDetail(input: unknown): string {
  if (typeof input === 'string') {
    // codex は JS のコード片で来る。cmd を抜き出す。
    const cmd = /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(input)?.[1];
    if (cmd) return toTitle(cmd.replace(/\\n/g, ' '), 70);
    return toTitle(input, 70);
  }
  if (typeof input !== 'object' || input === null) return '';
  const rec = input as Record<string, unknown>;
  for (const key of ['file_path', 'command', 'pattern', 'path', 'url', 'description']) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') return toTitle(v, 70);
  }
  return '';
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = new Set(['Bash', 'exec', 'shell']);

function* claudeTranscript(
  records: Iterable<Record<string, unknown>>,
): Generator<TranscriptItem> {
  for (const record of records) {
    // サブエージェントの発話は本筋ではないので入れない
    if (record.isSidechain === true) continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message) continue;

    if (record.type === 'user') {
      const content = message.content;
      // ツールの実行結果も user レコードで来る。こちらの入力だけ拾う。
      if (Array.isArray(content) && content.some((b) => (b as Record<string, unknown>)?.type === 'tool_result')) {
        continue;
      }
      const text2 = textOfContent(content);
      if (text2 !== '' && !looksLikeInjectedInstruction(text2)) yield { t: 'user', text: text2 };
      continue;
    }

    if (record.type === 'assistant' && Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = raw as Record<string, unknown>;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          yield { t: 'assistant', text: block.text };
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          yield { t: 'tool', name: block.name, detail: toolDetail(block.input) };
        }
      }
    }
  }
}

function* codexTranscript(
  records: Iterable<Record<string, unknown>>,
): Generator<TranscriptItem> {
  let lastMessage: { t: 'user' | 'assistant'; text: string } | null = null;

  for (const record of records) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      if (!looksLikeInjectedInstruction(payload.message)) {
        if (lastMessage?.t !== 'user' || lastMessage.text !== payload.message) {
          yield { t: 'user', text: payload.message };
        }
        lastMessage = { t: 'user', text: payload.message };
      }
      continue;
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      if (lastMessage?.t !== 'assistant' || lastMessage.text !== payload.message) {
        yield { t: 'assistant', text: payload.message };
      }
      lastMessage = { t: 'assistant', text: payload.message };
      continue;
    }
    // Codex 0.2xx 以降の発話形式。旧 event_msg と両方入る版では重複を除く。
    if (
      record.type === 'response_item' &&
      payload.type === 'message' &&
      (payload.role === 'user' || payload.role === 'assistant')
    ) {
      const text = textOfContent(payload.content);
      const role = payload.role;
      if (text !== '' && (role === 'assistant' || !looksLikeInjectedInstruction(text))) {
        if (lastMessage?.t !== role || lastMessage.text !== text) yield { t: role, text };
        lastMessage = { t: role, text };
      }
      continue;
    }
    if (payload.type === 'custom_tool_call' && typeof payload.name === 'string') {
      yield { t: 'tool', name: payload.name, detail: toolDetail(payload.input) };
      lastMessage = null;
    }
  }
}

/**
 * 会話ログから、画面に出せる履歴を復元する。
 * 引き継いだ直後に「これまでの話」が見えないと、次に何を送るか決められない。
 */
export function readSessionTranscript(
  session: ExistingSession,
  opts: ReadTranscriptOptions = {},
): { items: TranscriptItem[]; experience: CarriedExperience; truncated: boolean } {
  const maxItems = opts.maxItems ?? 200;

  let all: TranscriptItem[] = [];
  let itemCount = 0;
  const experience: CarriedExperience = { turns: 0, filesEdited: 0, commandsRun: 0 };
  let remaining = opts.maxBytes;
  let bytesTruncated = false;
  let readAny = false;
  const paths = [...new Set(session.paths?.length ? session.paths : [session.path])].sort();

  // maxBytes が明示された場合だけ、新しいログを優先して総量を制限する。
  const selected: Array<{ path: string; bytes: number | null }> = [];
  if (remaining === undefined) {
    selected.push(...paths.map((path) => ({ path, bytes: null })));
  } else {
    for (let i = paths.length - 1; i >= 0; i -= 1) {
      if (remaining <= 0) {
        bytesTruncated = true;
        break;
      }
      try {
        const size = statSync(paths[i]!).size;
        const bytes = Math.min(size, remaining);
        selected.unshift({ path: paths[i]!, bytes });
        remaining -= bytes;
        if (bytes < size) bytesTruncated = true;
      } catch {
        // 消えたログは飛ばし、残っている分を使う。
      }
    }
  }

  for (const selectedFile of selected) {
    try {
      const records = selectedFile.bytes === null
        ? jsonLinesFromFile(
            selectedFile.path,
            session.kind === 'codex' ? isCodexTranscriptLine : undefined,
          )
        : jsonLines(readForTranscript(selectedFile.path, selectedFile.bytes));
      const items = session.kind === 'claude'
        ? claudeTranscript(records)
        : codexTranscript(records);
      for (const item of items) {
        itemCount += 1;
        if (item.t === 'user') experience.turns += 1;
        else if (item.t === 'tool') {
          if (EDIT_TOOLS.has(item.name)) experience.filesEdited += 1;
          else if (COMMAND_TOOLS.has(item.name)) experience.commandsRun += 1;
        }
        all.push(item);
        // 長い履歴でも、画面へ返さない項目をメモリに溜め続けない。
        if (all.length > maxItems) all.shift();
      }
      readAny = true;
    } catch {
      // 1 ファイルが壊れていても、同じ会話のほかの rollout は表示する。
    }
  }
  if (!readAny) {
    return { items: [], experience: { turns: 0, filesEdited: 0, commandsRun: 0 }, truncated: false };
  }

  const truncated = bytesTruncated || itemCount > maxItems;
  return { items: all, experience, truncated };
}

/** 前職の実績を数える。数字はログの実数で、作らない。 */
export function summarizeTranscript(items: readonly TranscriptItem[]): CarriedExperience {
  let turns = 0;
  let filesEdited = 0;
  let commandsRun = 0;

  for (const item of items) {
    if (item.t === 'user') turns += 1;
    else if (item.t === 'tool') {
      if (EDIT_TOOLS.has(item.name)) filesEdited += 1;
      else if (COMMAND_TOOLS.has(item.name)) commandsRun += 1;
    }
  }
  return { turns, filesEdited, commandsRun };
}

// ---------------------------------------------------------------------------
// CLI セッション全期間の集計
// ---------------------------------------------------------------------------

interface MutableTurn extends TurnUsage {
  tokenEvents: number;
}

function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addTokenUsage(target: TokenUsage, value: TokenUsage): void {
  target.inputTokens += value.inputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.outputTokens += value.outputTokens;
  target.reasoningTokens += value.reasoningTokens;
  target.totalTokens += value.totalTokens;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function timeMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function codexTokens(value: Record<string, unknown>): TokenUsage {
  const inputTokens = finiteNumber(value.input_tokens);
  const outputTokens = finiteNumber(value.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: finiteNumber(value.cached_input_tokens),
    outputTokens,
    reasoningTokens: finiteNumber(value.reasoning_output_tokens),
    totalTokens: finiteNumber(value.total_tokens) || inputTokens + outputTokens,
  };
}

function claudeTokens(value: Record<string, unknown>): TokenUsage {
  const cached = finiteNumber(value.cache_read_input_tokens);
  const inputTokens =
    finiteNumber(value.input_tokens) +
    finiteNumber(value.cache_creation_input_tokens) +
    cached;
  const outputTokens = finiteNumber(value.output_tokens);
  return {
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
  };
}

async function* asyncTextLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() !== '') yield line;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

function finalizeAnalysis(
  turns: MutableTurn[],
  values: {
    startedAt: number | null;
    latestAt: number | null;
    filesEdited: number;
    commandsRun: number;
    tokens: TokenUsage;
    contextTokens: number;
    contextWindow: number;
    hasTokenUsage: boolean;
  },
): SessionAnalysis {
  const publicTurns = turns.map(({ tokenEvents: _tokenEvents, ...turn }, index) => ({
    ...turn,
    index: index + 1,
  }));
  const completed = publicTurns.filter((turn) => turn.complete);
  const durations = completed
    .map((turn) => turn.durationMs)
    .filter((duration) => duration > 0)
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const typicalTurnMs = durations.length === 0
    ? undefined
    : durations.length % 2 === 1
      ? durations[middle]!
      : Math.round((durations[middle - 1]! + durations[middle]!) / 2);
  return {
    lifetime: {
      startedAt: values.startedAt,
      activeMs: completed.reduce((sum, turn) => sum + turn.durationMs, 0),
      tasksCompleted: completed.length,
      filesEdited: values.filesEdited,
      commandsRun: values.commandsRun,
      tokens: values.tokens,
      contextTokens: values.contextTokens,
      contextWindow: values.contextWindow,
      hasTokenUsage: values.hasTokenUsage,
      hasTiming: completed.some(
        (turn) => turn.durationMs > 0 || (turn.startedAt !== null && turn.endedAt !== null),
      ),
      timedTurns: durations.length,
      ...(typicalTurnMs === undefined ? {} : { typicalTurnMs }),
      updatedAt: values.latestAt ?? Date.now(),
    },
    turns: publicTurns,
  };
}

/**
 * Codex の rollout はコマンド出力が 1 行で数 MiB になることがある。
 * 種別と ID は行頭側にあるため、その 2 種類は JSON.parse せず数える。
 */
async function analyzeCodexSession(session: ExistingSession): Promise<SessionAnalysis> {
  const turns: MutableTurn[] = [];
  const byId = new Map<string, MutableTurn>();
  const seenItems = new Set<string>();
  const seenTokenEvents = new Set<string>();
  const totals = emptyTokenUsage();
  let activeTurn: MutableTurn | null = null;
  let anonymous = 0;
  let startedAt: number | null = null;
  let latestAt: number | null = null;
  let filesEdited = 0;
  let commandsRun = 0;
  let contextTokens = 0;
  let contextWindow = 0;
  let hasTokenUsage = false;

  const noteTime = (value: number | null): void => {
    if (value === null) return;
    startedAt = startedAt === null ? value : Math.min(startedAt, value);
    latestAt = latestAt === null ? value : Math.max(latestAt, value);
  };
  const ensureTurn = (id: string, at: number | null): MutableTurn => {
    const seen = byId.get(id);
    if (seen) {
      if (seen.startedAt === null && at !== null) seen.startedAt = at;
      return seen;
    }
    const turn: MutableTurn = {
      id,
      index: 0,
      label: '',
      startedAt: at,
      endedAt: null,
      durationMs: 0,
      complete: false,
      tokens: emptyTokenUsage(),
      tokenEvents: 0,
    };
    byId.set(id, turn);
    turns.push(turn);
    return turn;
  };
  const setLabel = (turn: MutableTurn | null, text: string): void => {
    if (!turn || turn.label !== '' || looksLikeInjectedInstruction(text)) return;
    turn.label = toTitle(text, 48);
  };

  const paths = [...new Set(session.paths?.length ? session.paths : [session.path])].sort();
  for (const path of paths) {
    try {
      for await (const line of asyncTextLines(path)) {
        const head = line.slice(0, 16_384);

        const item = /"item"\s*:\s*\{\s*"type"\s*:\s*"(CommandExecution|FileChange|command_execution|file_change)"\s*,\s*"id"\s*:\s*"([^"]+)"/.exec(head);
        if (item) {
          const id = item[2]!;
          if (!seenItems.has(id)) {
            seenItems.add(id);
            if (item[1] === 'CommandExecution' || item[1] === 'command_execution') commandsRun += 1;
            else {
              // rolloutのFileChangeは changes が「パス → 変更内容」のオブジェクト。
              // unified_diff本体をJSON展開せず、各エントリ先頭だけを数える。
              const objectChanges = line.match(
                /"(?:[^"\\]|\\.)+"\s*:\s*\{\s*"type"\s*:\s*"(?:add|update|delete)"/g,
              )?.length ?? 0;
              const arrayChanges = line.match(
                /"path"\s*:\s*"(?:[^"\\]|\\.)+"\s*,\s*"kind"\s*:\s*"(?:add|update|delete)"/g,
              )?.length ?? 0;
              filesEdited += Math.max(1, objectChanges, arrayChanges);
            }
          }
          continue;
        }

        const relevant =
          head.includes('"type":"session_meta"') ||
          head.includes('"type":"task_started"') ||
          head.includes('"type":"task_complete"') ||
          head.includes('"type":"token_count"') ||
          head.includes('"type":"user_message"') ||
          head.includes('"type":"UserMessage"') ||
          (head.includes('"type":"response_item"') && head.includes('"role":"user"'));
        if (!relevant) continue;

        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          const object = recordOf(parsed);
          if (!object) continue;
          record = object;
        } catch {
          continue;
        }

        const at = timeMs(record.timestamp);
        noteTime(at);
        const payload = recordOf(record.payload);
        if (!payload) continue;

        if (record.type === 'session_meta') continue;

        if (payload.type === 'task_started') {
          const id: string = typeof payload.turn_id === 'string'
            ? payload.turn_id
            : `turn-${++anonymous}`;
          const turnAt = timeMs(payload.started_at) ?? at;
          activeTurn = ensureTurn(id, turnAt);
          noteTime(turnAt);
          const window = finiteNumber(payload.model_context_window);
          if (window > 0) contextWindow = window;
          continue;
        }

        if (payload.type === 'task_complete') {
          const id: string = typeof payload.turn_id === 'string'
            ? payload.turn_id
            : activeTurn?.id ?? `turn-${++anonymous}`;
          const turn: MutableTurn = ensureTurn(id, timeMs(payload.started_at) ?? at);
          const endedAt = timeMs(payload.completed_at) ?? at;
          turn.endedAt = endedAt;
          const reportedDuration = finiteNumber(payload.duration_ms);
          turn.durationMs = reportedDuration > 0
            ? reportedDuration
            : turn.startedAt !== null && endedAt !== null
              ? Math.max(0, endedAt - turn.startedAt)
              : 0;
          turn.complete = true;
          noteTime(endedAt);
          if (activeTurn?.id === id) activeTurn = null;
          continue;
        }

        if (payload.type === 'token_count') {
          const info = recordOf(payload.info);
          const last = recordOf(info?.last_token_usage);
          if (!last) continue;
          const usage = codexTokens(last);
          const turn: MutableTurn = activeTurn ?? ensureTurn(`unbound-${++anonymous}`, at);
          activeTurn = turn;
          const eventKey = [
            turn.id,
            record.timestamp ?? '',
            usage.inputTokens,
            usage.outputTokens,
            usage.reasoningTokens,
          ].join(':');
          if (!seenTokenEvents.has(eventKey)) {
            seenTokenEvents.add(eventKey);
            addTokenUsage(turn.tokens, usage);
            addTokenUsage(totals, usage);
            turn.tokenEvents += 1;
          }
          contextTokens = usage.inputTokens;
          const window = finiteNumber(info?.model_context_window);
          if (window > 0) contextWindow = window;
          hasTokenUsage = true;
          continue;
        }

        if (payload.type === 'user_message' && typeof payload.message === 'string') {
          setLabel(activeTurn, payload.message);
          continue;
        }
        if (record.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
          setLabel(activeTurn, textOfContent(payload.content));
          continue;
        }
        if (payload.type === 'item_completed') {
          const completed = recordOf(payload.item);
          if (completed?.type === 'UserMessage') setLabel(activeTurn, textOfContent(completed.content));
        }
      }
    } catch {
      // 途中の rollout が消えたり壊れたりしても、読めた分は返す。
    }
  }

  for (const turn of turns) {
    if (turn.label === '') turn.label = `会話 ${turns.indexOf(turn) + 1}`;
  }
  return finalizeAnalysis(turns, {
    startedAt,
    latestAt,
    filesEdited,
    commandsRun,
    tokens: totals,
    contextTokens,
    contextWindow,
    hasTokenUsage,
  });
}

async function analyzeClaudeSession(session: ExistingSession): Promise<SessionAnalysis> {
  const turns: MutableTurn[] = [];
  const seenMessages = new Set<string>();
  const seenEndMessages = new Set<string>();
  const seenTools = new Set<string>();
  const totals = emptyTokenUsage();
  let current: MutableTurn | null = null;
  let sequence = 0;
  let startedAt: number | null = null;
  let latestAt: number | null = null;
  let filesEdited = 0;
  let commandsRun = 0;
  let contextTokens = 0;
  let hasTokenUsage = false;

  const noteTime = (value: number | null): void => {
    if (value === null) return;
    startedAt = startedAt === null ? value : Math.min(startedAt, value);
    latestAt = latestAt === null ? value : Math.max(latestAt, value);
  };
  const newTurn = (label: string, at: number | null, id?: string): MutableTurn => {
    const turn: MutableTurn = {
      id: id || `turn-${++sequence}`,
      index: 0,
      label: toTitle(label, 48) || `会話 ${turns.length + 1}`,
      startedAt: at,
      endedAt: null,
      durationMs: 0,
      complete: false,
      tokens: emptyTokenUsage(),
      tokenEvents: 0,
    };
    turns.push(turn);
    return turn;
  };

  const paths = [...new Set(session.paths?.length ? session.paths : [session.path])].sort();
  for (const path of paths) {
    try {
      for await (const line of asyncTextLines(path)) {
        const head = line.slice(0, 16_384);
        const isUser = head.includes('"type":"user"') && head.includes('"message"');
        const isAssistant = head.includes('"role":"assistant"');
        if (!isUser && !isAssistant) continue;
        // 暗号化済み思考は巨大で、同じ message.id の tool/text レコードにも usage が載る。
        if (
          isAssistant &&
          head.includes('"content":[{"type":"thinking"') &&
          !head.includes('"type":"tool_use"') &&
          !head.includes('"type":"text"')
        ) continue;

        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          const object = recordOf(parsed);
          if (!object) continue;
          record = object;
        } catch {
          continue;
        }
        if (record.isSidechain === true) continue;
        const at = timeMs(record.timestamp);
        noteTime(at);
        const message = recordOf(record.message);
        if (!message) continue;

        if (record.type === 'user') {
          const content = message.content;
          if (
            Array.isArray(content) &&
            content.some((block) => recordOf(block)?.type === 'tool_result')
          ) continue;
          const text = textOfContent(content);
          if (text === '' || looksLikeInjectedInstruction(text)) continue;
          current = newTurn(
            text,
            at,
            typeof record.uuid === 'string' ? record.uuid : undefined,
          );
          continue;
        }

        if (record.type !== 'assistant') continue;
        if (!current) current = newTurn('', at);
        const messageId =
          typeof message.id === 'string'
            ? message.id
            : typeof record.requestId === 'string'
              ? record.requestId
              : '';
        const usageRecord = recordOf(message.usage);
        if (usageRecord) {
          const usage = claudeTokens(usageRecord);
          contextTokens = usage.inputTokens;
          hasTokenUsage = true;
          if (messageId === '' || !seenMessages.has(messageId)) {
            if (messageId !== '') seenMessages.add(messageId);
            addTokenUsage(current.tokens, usage);
            addTokenUsage(totals, usage);
            current.tokenEvents += 1;
          }
        }

        if (Array.isArray(message.content)) {
          for (const raw of message.content) {
            const block = recordOf(raw);
            if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
            const toolId = typeof block.id === 'string' ? block.id : `${messageId}:${block.name}`;
            if (seenTools.has(toolId)) continue;
            seenTools.add(toolId);
            if (EDIT_TOOLS.has(block.name)) filesEdited += 1;
            if (block.name === 'Bash') commandsRun += 1;
          }
        }

        if (message.stop_reason === 'end_turn' && !seenEndMessages.has(messageId || String(at))) {
          seenEndMessages.add(messageId || String(at));
          current.endedAt = at;
          current.durationMs = current.startedAt !== null && at !== null
            ? Math.max(0, at - current.startedAt)
            : 0;
          current.complete = true;
          current = null;
        }
      }
    } catch {
      // 読めたファイルだけで集計する。
    }
  }

  return finalizeAnalysis(turns, {
    startedAt,
    latestAt,
    filesEdited,
    commandsRun,
    tokens: totals,
    contextTokens,
    contextWindow: 0,
    hasTokenUsage,
  });
}

/**
 * CLI の保存ログを非同期に読み、会話開始時点からの値を復元する。
 * 読み込みはストリーム式で、巨大なログ全体をメモリへ載せない。
 */
export async function analyzeSessionLog(session: ExistingSession): Promise<SessionAnalysis> {
  return session.kind === 'codex'
    ? analyzeCodexSession(session)
    : analyzeClaudeSession(session);
}

// ---------------------------------------------------------------------------

function claudeSessionsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function codexSessionsRoot(): string {
  return join(codexHome(), 'sessions');
}

/** Codex 自身が生成・保存した会話題名を、スレッド ID ごとに読む。 */
export function readCodexThreadNames(path = join(codexHome(), 'session_index.jsonl')): Map<string, string> {
  const names = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return names;
  }

  for (const record of jsonLines(text)) {
    if (typeof record.id !== 'string' || typeof record.thread_name !== 'string') continue;
    const name = record.thread_name.trim();
    if (name !== '') names.set(record.id, name);
  }
  return names;
}

interface Candidate {
  path: string;
  mtime: number;
}

function collect(root: string, match: (name: string) => boolean, depth = 0): Candidate[] {
  if (!existsSync(root) || depth > 5) return [];
  const out: Candidate[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collect(path, match, depth + 1));
    } else if (match(entry.name)) {
      try {
        out.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        // 消えた直後などは飛ばす
      }
    }
  }
  return out;
}

/** claude のセッションファイルを 1 件ぶん読み解く */
export function parseClaudeSession(
  path: string,
  head: string,
  mtime: number,
): ExistingSession | null {
  const sessionId = basename(path, '.jsonl');
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return null;

  let cwd = '';
  let aiTitle = '';
  let firstUser = '';

  for (const record of jsonLines(head)) {
    if (cwd === '' && typeof record.cwd === 'string') cwd = record.cwd;
    if (aiTitle === '' && record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      aiTitle = record.aiTitle;
    }
    if (firstUser === '' && record.type === 'user') {
      const message = record.message as Record<string, unknown> | undefined;
      const text = textOfContent(message?.content);
      if (text !== '' && !looksLikeInjectedInstruction(text)) firstUser = text;
    }
    if (cwd !== '' && aiTitle !== '') break;
  }

  const title = aiTitle || (firstUser ? toTitle(firstUser) : '（内容不明）');
  return { kind: 'claude', sessionId, cwd, title, updatedAt: mtime, path, paths: [path] };
}

/** codex のロールアウトを 1 件ぶん読み解く */
export function parseCodexSession(
  path: string,
  head: string,
  mtime: number,
): ExistingSession | null {
  let sessionId = '';
  let cwd = '';
  let firstUser = '';
  let firstAssistant = '';

  for (const record of jsonLines(head)) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (record.type === 'session_meta') {
      if (typeof payload.session_id === 'string') sessionId = payload.session_id;
      if (typeof payload.cwd === 'string') cwd = payload.cwd;
      continue;
    }
    if (firstUser === '' && payload.type === 'user_message' && typeof payload.message === 'string') {
      if (!looksLikeInjectedInstruction(payload.message)) firstUser = payload.message;
    }
    if (
      firstUser === '' &&
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'user'
    ) {
      const text = textOfContent(payload.content);
      if (text !== '' && !looksLikeInjectedInstruction(text)) firstUser = text;
    }
    // 発話が注入物だけのことがある（resume した直後のファイルなど）。
    // その場合は本人の返事を見出しに使う。無題より手がかりになる。
    if (
      firstUser === '' &&
      firstAssistant === '' &&
      record.type === 'response_item' &&
      payload.type === 'message' &&
      payload.role === 'assistant'
    ) {
      const text = textOfContent(payload.content);
      // ツールへ渡す JSON がそのまま入っていることがある。見出しにならない。
      if (text !== '' && !looksLikeMachineOutput(text)) firstAssistant = text;
    }
  }

  if (sessionId === '') return null;
  const title = firstUser || firstAssistant;
  return {
    kind: 'codex',
    sessionId,
    cwd,
    title: title ? toTitle(title) : '（内容不明）',
    updatedAt: mtime,
    path,
    paths: [path],
  };
}

/**
 * 使えそうな既存セッションを新しい順に返す。
 * 読めなかったものは黙って飛ばす（一覧が出ないより、出るものだけ出すほうがよい）。
 */
export function listExistingSessions(opts: ListSessionsOptions = {}): ExistingSession[] {
  const limit = opts.limit ?? 40;
  const headBytes = opts.headBytes ?? 128 * 1024;
  const codexRoot = opts.codexRoot ?? codexSessionsRoot();
  const codexThreadNames = readCodexThreadNames(
    opts.codexIndexPath ?? join(dirname(codexRoot), 'session_index.jsonl'),
  );

  const candidates: Array<Candidate & { kind: AgentKind }> = [
    ...collect(opts.claudeRoot ?? claudeSessionsRoot(), (n) => n.endsWith('.jsonl')).map((c) => ({
      ...c,
      kind: 'claude' as const,
    })),
    ...collect(
      codexRoot,
      (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    ).map((c) => ({ ...c, kind: 'codex' as const })),
  ];

  candidates.sort((a, b) => b.mtime - a.mtime);

  // codex は resume のたびに新しい rollout ファイルを作るが、スレッド ID は同じ。
  // そのまま並べると同じ会話が何度も出るので、ID ごとに 1 件へまとめる。
  // 上限は「まとめたあとの件数」で数えたいので、少し多めに読む。
  const byId = new Map<string, ExistingSession>();
  for (const candidate of candidates.slice(0, limit * 4)) {
    try {
      const head = readHead(candidate.path, headBytes);
      const parsed =
        candidate.kind === 'claude'
          ? parseClaudeSession(candidate.path, head, candidate.mtime)
          : parseCodexSession(candidate.path, head, candidate.mtime);
      if (!parsed) continue;

      if (parsed.kind === 'codex') {
        const generatedTitle = codexThreadNames.get(parsed.sessionId);
        if (generatedTitle) parsed.title = generatedTitle;
      }

      const key = `${parsed.kind}:${parsed.sessionId}`;
      const seen = byId.get(key);
      if (!seen) {
        byId.set(key, parsed);
        continue;
      }
      // 再開先は最新のファイルに合わせる。見出しは中身のある方を採る。
      if (isUntitled(seen.title) && !isUntitled(parsed.title)) seen.title = parsed.title;
      if (seen.cwd === '' && parsed.cwd !== '') seen.cwd = parsed.cwd;
      if (seen.kind === 'codex') {
        seen.paths = [...new Set([...(seen.paths ?? [seen.path]), ...(parsed.paths ?? [parsed.path])])];
      }
    } catch {
      // 読めないファイルは一覧に出さない
    }
  }
  return [...byId.values()].slice(0, limit);
}

/**
 * 保存済みのダッシュボードが指している CLI セッションを ID から探す。
 * codex は resume ごとの rollout を全部束ね、過去のやり取りを時系列で読める形にする。
 */
export function findExistingSession(
  kind: AgentKind,
  sessionId: string,
  opts: ListSessionsOptions = {},
): ExistingSession | null {
  if (!/^[0-9a-f-]{16,}$/i.test(sessionId)) return null;
  const root =
    kind === 'claude'
      ? (opts.claudeRoot ?? claudeSessionsRoot())
      : (opts.codexRoot ?? codexSessionsRoot());
  const candidates = collect(
    root,
    kind === 'claude'
      ? (name) => name === `${sessionId}.jsonl`
      : (name) => name.startsWith('rollout-') && name.endsWith('.jsonl') && name.includes(sessionId),
  ).sort((a, b) => b.mtime - a.mtime);
  const threadNames =
    kind === 'codex'
      ? readCodexThreadNames(opts.codexIndexPath ?? join(dirname(root), 'session_index.jsonl'))
      : new Map<string, string>();

  let found: ExistingSession | null = null;
  for (const candidate of candidates) {
    try {
      const head = readHead(candidate.path, opts.headBytes ?? 128 * 1024);
      const parsed =
        kind === 'claude'
          ? parseClaudeSession(candidate.path, head, candidate.mtime)
          : parseCodexSession(candidate.path, head, candidate.mtime);
      if (!parsed || parsed.sessionId !== sessionId) continue;
      const generatedTitle = threadNames.get(sessionId);
      if (generatedTitle) parsed.title = generatedTitle;

      if (!found) {
        found = parsed;
        if (kind === 'claude') break;
        continue;
      }
      found.paths = [...new Set([...(found.paths ?? [found.path]), parsed.path])];
      if (isUntitled(found.title) && !isUntitled(parsed.title)) found.title = parsed.title;
      if (found.cwd === '' && parsed.cwd !== '') found.cwd = parsed.cwd;
    } catch {
      // 読めない rollout だけを飛ばす。
    }
  }
  return found;
}

function isUntitled(title: string): boolean {
  return title === '' || title === '（内容不明）';
}
