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
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { AgentKind } from './types.ts';

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
  /** これより大きいファイルは末尾だけ読む */
  maxBytes?: number;
}

export interface ListSessionsOptions {
  claudeRoot?: string;
  codexRoot?: string;
  /** 新しい順に何件まで見るか。全部読むと遅い */
  limit?: number;
  headBytes?: number;
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

/** 見出しにできない、注入された指示文かどうか */
function looksLikeInjectedInstruction(text: string): boolean {
  const head = text.trimStart();
  return (
    head.startsWith('#') ||
    head.startsWith('<') ||
    head.includes('AGENTS.md instructions') ||
    head.includes('<INSTRUCTIONS>') ||
    head.includes('system-reminder')
  );
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
  for (const block of content) {
    if (typeof block === 'string') return block;
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>;
      if (typeof b.text === 'string') return b.text;
    }
  }
  return '';
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

function claudeTranscript(text: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (const record of jsonLines(text)) {
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
      if (text2 !== '' && !looksLikeInjectedInstruction(text2)) items.push({ t: 'user', text: text2 });
      continue;
    }

    if (record.type === 'assistant' && Array.isArray(message.content)) {
      for (const raw of message.content) {
        const block = raw as Record<string, unknown>;
        if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
          items.push({ t: 'assistant', text: block.text });
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          items.push({ t: 'tool', name: block.name, detail: toolDetail(block.input) });
        }
      }
    }
  }
  return items;
}

function codexTranscript(text: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];

  for (const record of jsonLines(text)) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      if (!looksLikeInjectedInstruction(payload.message)) {
        items.push({ t: 'user', text: payload.message });
      }
      continue;
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      items.push({ t: 'assistant', text: payload.message });
      continue;
    }
    if (payload.type === 'custom_tool_call' && typeof payload.name === 'string') {
      items.push({ t: 'tool', name: payload.name, detail: toolDetail(payload.input) });
    }
  }
  return items;
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
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;

  let all: TranscriptItem[] = [];
  try {
    const text = readForTranscript(session.path, maxBytes);
    all = session.kind === 'claude' ? claudeTranscript(text) : codexTranscript(text);
  } catch {
    return { items: [], experience: { turns: 0, filesEdited: 0, commandsRun: 0 }, truncated: false };
  }

  const experience = summarizeTranscript(all);
  const truncated = all.length > maxItems;
  return { items: truncated ? all.slice(-maxItems) : all, experience, truncated };
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

function claudeSessionsRoot(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

function codexSessionsRoot(): string {
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
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
  return { kind: 'claude', sessionId, cwd, title, updatedAt: mtime, path };
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
  }

  if (sessionId === '') return null;
  return {
    kind: 'codex',
    sessionId,
    cwd,
    title: firstUser ? toTitle(firstUser) : '（内容不明）',
    updatedAt: mtime,
    path,
  };
}

/**
 * 使えそうな既存セッションを新しい順に返す。
 * 読めなかったものは黙って飛ばす（一覧が出ないより、出るものだけ出すほうがよい）。
 */
export function listExistingSessions(opts: ListSessionsOptions = {}): ExistingSession[] {
  const limit = opts.limit ?? 40;
  const headBytes = opts.headBytes ?? 128 * 1024;

  const candidates: Array<Candidate & { kind: AgentKind }> = [
    ...collect(opts.claudeRoot ?? claudeSessionsRoot(), (n) => n.endsWith('.jsonl')).map((c) => ({
      ...c,
      kind: 'claude' as const,
    })),
    ...collect(
      opts.codexRoot ?? codexSessionsRoot(),
      (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'),
    ).map((c) => ({ ...c, kind: 'codex' as const })),
  ];

  candidates.sort((a, b) => b.mtime - a.mtime);

  const sessions: ExistingSession[] = [];
  for (const candidate of candidates.slice(0, limit)) {
    try {
      const head = readHead(candidate.path, headBytes);
      const parsed =
        candidate.kind === 'claude'
          ? parseClaudeSession(candidate.path, head, candidate.mtime)
          : parseCodexSession(candidate.path, head, candidate.mtime);
      if (parsed) sessions.push(parsed);
    } catch {
      // 読めないファイルは一覧に出さない
    }
  }
  return sessions;
}
