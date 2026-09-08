/**
 * AI ごとの使用量（残量）の取得。
 *
 * 両 CLI とも「残り何 %」を出す口を持っているが、場所がまったく違う。
 *
 *   claude … `claude -p "/usage"` が非対話でも動く。
 *            CLI 内部で処理されるのでモデル呼び出しは起きない
 *            （実測: num_turns 0 / total_cost_usd 0 / 約 0.4 秒）。
 *            返ってくるのは人間向けのテキストなので、そこから読み取る。
 *
 *   codex  … stdout には出ない。セッションのロールアウト
 *            （~/.codex/sessions/**\/rollout-*.jsonl）に token_count イベントとして
 *            rate_limits が書かれるので、そこから読む。
 *            ファイルを読むだけなので API も課金も発生しない。
 *
 * どちらも「取れなかった」を握り潰さない。error を持たせて画面に出す。
 */

import { execFile } from 'node:child_process';
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentKind } from './types.ts';
import { childEnv } from './drivers/process.ts';

export interface UsageWindow {
  /** 'セッション' / '週' など、画面に出す短い名前 */
  label: string;
  usedPercent: number;
  /** リセット時刻（epoch ms）。読めなければ null */
  resetsAt: number | null;
  /** CLI が返した元の表記。読めなかったときはこちらを出す */
  resetsText: string;
  /**
   * 記録された時点では有効だったが、その後リセット時刻を過ぎた窓。
   *
   * codex の使用量は「最後に codex を動かしたときの記録」でしかない。
   * 一晩動かさずにいると、窓が入れ替わったあとも古い数字を出し続け、
   * 上限に張り付いているように見える。
   */
  expired?: boolean;
}

export interface UsageSnapshot {
  kind: AgentKind;
  windows: UsageWindow[];
  /**
   * 使えるスラッシュコマンド。claude だけ取れる。
   * 使用量の取得と同じ 1 回の起動で一緒に返ってくるので、追加の負荷は無い。
   */
  slashCommands?: string[];
  /** 端末でしか動かないコマンド。この画面からは送れない。 */
  terminalOnlyCommands?: string[];
  /** 'plus' など。codex だけ取れる */
  planType: string | null;
  /** codex だけ取れる。セッションのコンテキスト窓に反映できる */
  contextWindow: number | null;
  fetchedAt: number;
  /** 取れなかった理由 */
  error: string | null;
}

export interface UsageProbe {
  readonly kind: AgentKind;
  fetch(): Promise<UsageSnapshot>;
}

function empty(kind: AgentKind, at: number, error: string | null = null): UsageSnapshot {
  return { kind, windows: [], planType: null, contextWindow: null, fetchedAt: at, error };
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/** '17% used · resets Aug 24, 2:50am (Asia/Tokyo)' を持つ行を拾う */
const USAGE_LINE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·・]\s*resets?\s+(.+?))?\s*$/;

/**
 * 画面に出す短い名前へ言い換える。知らない見出しはそのまま。
 * 'Current week (Opus)' のようにモデル別の枠があるので、
 * 括弧の中も落とさずに残す（'週' が 2 つ並ぶと見分けられない）。
 */
export function shortLabel(raw: string): string {
  const text = raw.trim();
  const lower = text.toLowerCase();

  const period = lower.includes('session')
    ? 'セッション'
    : lower.includes('week')
      ? '週'
      : lower.includes('month')
        ? '月'
        : lower.includes('day')
          ? '日'
          : null;
  if (period === null) return text;

  const qualifier = /\(([^)]+)\)/.exec(text)?.[1]?.trim() ?? '';
  if (qualifier === '' || /all models/i.test(qualifier)) return period;
  return `${period}(${qualifier})`;
}

/** `/usage` の出力テキストから使用率を読み取る */
export function parseClaudeUsage(text: string, now: number): UsageSnapshot {
  const windows: UsageWindow[] = [];

  for (const line of text.split('\n')) {
    const m = USAGE_LINE.exec(line.trim());
    if (!m) continue;
    const percent = Number(m[2]);
    if (!Number.isFinite(percent)) continue;

    const resetsText = (m[3] ?? '').trim();
    windows.push({
      label: shortLabel(m[1]!),
      usedPercent: Math.max(0, Math.min(100, percent)),
      resetsAt: parseResetTime(resetsText, now),
      resetsText,
    });
  }

  const snapshot = empty('claude', now);
  snapshot.windows = windows;
  if (windows.length === 0) {
    snapshot.error = '使用量の行が見つかりませんでした';
  }
  return snapshot;
}

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/**
 * 'Aug 24, 2:50am (Asia/Tokyo)' のような表記を時刻に直す。
 * Date.parse は '2:50am' を読めないので、自前で組み立てる。
 * 読めなければ null（元の表記は画面に出せるので致命的ではない）。
 */
export function parseResetTime(text: string, now: number): number | null {
  if (text === '') return null;
  // 括弧の中はタイムゾーン名。ローカル時刻として扱うので落とす。
  const cleaned = text.replace(/\([^)]*\)/g, '').trim();
  if (cleaned === '') return null;

  const date = /([A-Za-z]{3,})\s+(\d{1,2})/.exec(cleaned);
  if (!date) return null;
  const month = MONTHS.indexOf(date[1]!.slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const day = Number(date[2]);

  const time = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(cleaned);
  let hour = 0;
  let minute = 0;
  if (time) {
    hour = Number(time[1]) % 12;
    minute = Number(time[2] ?? 0);
    if (time[3]!.toLowerCase() === 'pm') hour += 12;
  }

  const year = new Date(now).getFullYear();
  let at = new Date(year, month, day, hour, minute).getTime();
  // 年をまたぐ表記（12 月に「Jan 2」と出る）に備える
  if (at < now - 30 * 24 * 60 * 60 * 1000) {
    at = new Date(year + 1, month, day, hour, minute).getTime();
  }
  return Number.isFinite(at) ? at : null;
}

interface ProbeOutput {
  text: string;
  slashCommands: string[];
  terminalOnly: string[];
}

/** stream-json の各行から、使用量のテキストとコマンド一覧を拾う */
export function parseProbeOutput(stdout: string): ProbeOutput {
  const out: ProbeOutput = { text: '', slashCommands: [], terminalOnly: [] };

  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (o.type === 'system' && o.subtype === 'init') {
      if (Array.isArray(o.slash_commands)) {
        out.slashCommands = o.slash_commands.filter((c): c is string => typeof c === 'string');
      }
      if (Array.isArray(o.terminal_slash_commands)) {
        out.terminalOnly = o.terminal_slash_commands.filter((c): c is string => typeof c === 'string');
      }
      continue;
    }
    if (o.type === 'result' && typeof o.result === 'string') out.text = o.result;
  }
  return out;
}

export interface ClaudeUsageProbeOptions {
  bin?: string;
  timeoutMs?: number;
  now?: () => number;
  /** テスト用。実際にプロセスを起こさずに出力を差し込む */
  run?: () => Promise<string>;
}

export class ClaudeUsageProbe implements UsageProbe {
  readonly kind = 'claude' as const;
  #bin: string;
  #timeoutMs: number;
  #now: () => number;
  #run: (() => Promise<string>) | undefined;

  constructor(opts: ClaudeUsageProbeOptions = {}) {
    this.#bin = opts.bin ?? 'claude';
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
    this.#now = opts.now ?? (() => Date.now());
    this.#run = opts.run;
  }

  async fetch(): Promise<UsageSnapshot> {
    const now = this.#now();
    try {
      const output = this.#run
        ? { text: await this.#run(), slashCommands: [], terminalOnly: [] }
        : await this.#invoke();
      const snapshot = parseClaudeUsage(output.text, now);
      if (output.slashCommands.length > 0) {
        snapshot.slashCommands = output.slashCommands;
        snapshot.terminalOnlyCommands = output.terminalOnly;
      }
      return snapshot;
    } catch (err) {
      return empty('claude', now, err instanceof Error ? err.message : String(err));
    }
  }

  /** `/usage` の 1 回の起動から、使用量とコマンド一覧の両方を取る */
  #invoke(): Promise<ProbeOutput> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.#bin,
        [
          '-p',
          '/usage',
          // stream-json にすると system/init も届き、コマンド一覧が一緒に取れる
          '--output-format',
          'stream-json',
          '--verbose',
          // 使用量を見るためだけにセッションを残さない
          '--no-session-persistence',
        ],
        { env: childEnv(), timeout: this.#timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            reject(new Error(`claude /usage に失敗しました: ${err.message}`));
            return;
          }
          resolve(parseProbeOutput(String(stdout)));
        },
      );
      // stdin を閉じる。開けたままだと待たされる（FINDINGS §1.1）
      child.stdin?.end();
    });
  }
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

interface CodexRateLimitWindow {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
}

/** window_minutes を短い名前にする */
export function labelForWindowMinutes(minutes: number): string {
  if (minutes >= 10_080) return '週';
  if (minutes >= 1_440) return '日';
  if (minutes >= 60) return `${Math.round(minutes / 60)}時間`;
  return `${minutes}分`;
}

function toWindow(raw: unknown, fallbackLabel: string, now: number): UsageWindow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const w = raw as CodexRateLimitWindow;
  const percent = typeof w.used_percent === 'number' ? w.used_percent : null;
  if (percent === null) return null;

  const minutes = typeof w.window_minutes === 'number' ? w.window_minutes : 0;
  const resetsAt = typeof w.resets_at === 'number' ? w.resets_at * 1000 : null;

  // リセット時刻を過ぎていれば、その数字はもう前の窓のもの。
  // そのまま出すと、上限に張り付いたまま動かないように見える。
  const expired = resetsAt !== null && resetsAt <= now;

  return {
    label: minutes > 0 ? labelForWindowMinutes(minutes) : fallbackLabel,
    usedPercent: expired ? 0 : Math.max(0, Math.min(100, percent)),
    resetsAt,
    resetsText: resetsAt ? new Date(resetsAt).toLocaleString('ja-JP') : '',
    expired,
  };
}

/** ロールアウト 1 ファイルから、最後の rate_limits を取り出す */
/** その記録が指している窓のうち、いちばん先のリセット時刻 */
function latestReset(snapshot: UsageSnapshot): number {
  let out = 0;
  for (const w of snapshot.windows) out = Math.max(out, w.resetsAt ?? 0);
  return out;
}

export function parseCodexRollout(text: string, now: number): UsageSnapshot | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (line === '' || !line.includes('rate_limits')) continue;

    let payload: Record<string, unknown>;
    try {
      const o = JSON.parse(line) as { payload?: Record<string, unknown> };
      if (!o.payload) continue;
      payload = o.payload;
    } catch {
      continue;
    }

    const limits = payload.rate_limits;
    if (typeof limits !== 'object' || limits === null) continue;
    const l = limits as Record<string, unknown>;

    const windows: UsageWindow[] = [];
    const primary = toWindow(l.primary, '主', now);
    const secondary = toWindow(l.secondary, '副', now);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    if (windows.length === 0) continue;

    const info = payload.info as Record<string, unknown> | undefined;
    return {
      kind: 'codex',
      windows,
      planType: typeof l.plan_type === 'string' ? l.plan_type : null,
      contextWindow:
        info && typeof info.model_context_window === 'number' ? info.model_context_window : null,
      fetchedAt: now,
      error: null,
    };
  }
  return null;
}

export interface CodexUsageProbeOptions {
  /** 既定は ~/.codex/sessions */
  sessionsDir?: string;
  /** 末尾から読むバイト数。ロールアウトは大きくなりうる */
  tailBytes?: number;
  /** 新しい順に何ファイルまで遡るか */
  maxFiles?: number;
  now?: () => number;
}

export class CodexUsageProbe implements UsageProbe {
  readonly kind = 'codex' as const;
  #dir: string;
  #tailBytes: number;
  #maxFiles: number;
  #now: () => number;

  constructor(opts: CodexUsageProbeOptions = {}) {
    this.#dir = opts.sessionsDir ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
    this.#tailBytes = opts.tailBytes ?? 512 * 1024;
    this.#maxFiles = opts.maxFiles ?? 5;
    this.#now = opts.now ?? (() => Date.now());
  }

  async fetch(): Promise<UsageSnapshot> {
    const now = this.#now();
    let files: string[];
    try {
      files = this.#recentRollouts();
    } catch (err) {
      return empty('codex', now, err instanceof Error ? err.message : String(err));
    }
    if (files.length === 0) {
      return empty('codex', now, 'codex のセッション記録が見つかりません');
    }

    // ファイルの新しさではなく、記録された窓の新しさで選ぶ。
    // 長く続いているスレッドのファイルが更新されても、そこに載っている
    // 使用量が最新とは限らない。
    let best: UsageSnapshot | null = null;
    for (const file of files) {
      try {
        const snapshot = parseCodexRollout(readTail(file, this.#tailBytes), now);
        if (!snapshot) continue;
        if (best === null || latestReset(snapshot) > latestReset(best)) best = snapshot;
      } catch {
        // 読めないファイルは飛ばして次を見る
      }
    }
    if (best) return best;
    return empty('codex', now, 'まだ使用量の記録がありません（codex を 1 回動かすと出ます）');
  }

  /** 更新の新しい順にロールアウトを列挙する */
  #recentRollouts(): string[] {
    const found: Array<{ path: string; mtime: number }> = [];

    const walk = (dir: string, depth: number): void => {
      if (depth > 4) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, depth + 1);
        } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          found.push({ path, mtime: statSync(path).mtimeMs });
        }
      }
    };

    walk(this.#dir, 0);
    found.sort((a, b) => b.mtime - a.mtime);
    return found.slice(0, this.#maxFiles).map((f) => f.path);
  }
}

/** ファイルの末尾だけを読む。大きなロールアウトを丸ごと読まないため。 */
export function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  if (size <= bytes) return readFileSync(path, 'utf8');

  const buffer = Buffer.alloc(bytes);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, bytes, size - bytes);
  } finally {
    closeSync(fd);
  }
  // 先頭は行の途中で切れているので捨てる
  const text = buffer.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline >= 0 ? text.slice(firstNewline + 1) : text;
}
