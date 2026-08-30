/**
 * 永続化（SPEC §14）。
 *
 * ゲーム層（人格・スタッツ・メモ・スロット）をここに保存する。
 * 会話そのものは CLI 側のセッションストアにあるので、こちらは
 * agentSessionId という紐だけを持てばよい。
 *
 * 書き込みは常にアトミック（tmp に書いて rename）。
 * 強制終了でファイルが半端に壊れると、セッションが丸ごと消える。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { Session, Dashboard, RateLimitInfo, Task } from './types.ts';
import type { History } from './analytics.ts';
import { createHistory } from './analytics.ts';
import type { DashboardConfig } from './config.ts';
import { defaultConfig, mergeConfig } from './config.ts';

export const SCHEMA_VERSION = 1;

/** raw.jsonl がこのサイズを超えたら退避する（SPEC §14.2） */
export const RAW_ROTATE_BYTES = 50 * 1024 * 1024;

export interface PersistedDashboard {
  version: number;
  title: string;
    slotCount: number;
  rateLimit: RateLimitInfo | null;
  savedAt: number;
}

export interface LoadedSession {
  session: Session;
  /** 前回の実行中タスク。起動時に interrupted へ倒す（SPEC §14.3 手順 6） */
  unfinishedPrompt: string | null;
}

export function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export class Persistence {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  /** セッションのメタデータ（1 セッション 1 ファイル） */
  get sessionsDir(): string {
    return join(this.root, 'sessions-meta');
  }

  get locksDir(): string {
    return join(this.root, 'locks');
  }

  get worktreesRoot(): string {
    return this.root;
  }

  /** セッションごとの記録（raw.jsonl / tasks.jsonl） */
  logDir(sessionId: string): string {
    return join(this.root, 'logs', sessionId);
  }

  // -------------------------------------------------------------------------
  // 設定
  // -------------------------------------------------------------------------

  loadConfig(): DashboardConfig {
    const path = join(this.root, 'config.json');
    if (!existsSync(path)) return defaultConfig();
    return mergeConfig(defaultConfig(), readJson(path));
  }

  saveConfig(config: DashboardConfig): void {
    writeAtomic(join(this.root, 'config.json'), JSON.stringify(config, null, 2));
  }

  // -------------------------------------------------------------------------
  // オフィス
  // -------------------------------------------------------------------------

  loadDashboard(): PersistedDashboard | null {
    const data = readJson(join(this.root, 'dashboard.json'));
    if (data === null || typeof data !== 'object') return null;
    return data as PersistedDashboard;
  }

  saveDashboard(office: Dashboard, now: number): void {
    const data: PersistedDashboard = {
      version: SCHEMA_VERSION,
      title: office.title,
      // removed: office.// removed,
      slotCount: office.slotCount,
      rateLimit: office.rateLimit,
      savedAt: now,
    };
    writeAtomic(join(this.root, 'dashboard.json'), JSON.stringify(data, null, 2));
  }

  // -------------------------------------------------------------------------
  // セッション
  // -------------------------------------------------------------------------

  sessionPath(id: string): string {
    return join(this.sessionsDir, `${id}.json`);
  }

  /**
   * セッションを保存する。
   * サブエージェントは使い捨てなので残さない。実行中タスクのイベント列も落とす
   * （履歴は tasks.jsonl 側にある）。
   */
  saveSession(session: Session): void {
    const slimTask: Task | null = session.currentTask
      ? { ...session.currentTask, events: [] }
      : null;
    const data = {
      version: SCHEMA_VERSION,
      ...session,
      subagents: [],
      currentTask: slimTask,
    };
    writeAtomic(this.sessionPath(session.id), JSON.stringify(data, null, 2));
  }

  deleteSession(id: string): void {
    try {
      unlinkSync(this.sessionPath(id));
    } catch {
      /* 無ければ何もしない */
    }
  }

  /** 壊れたファイルは飛ばす。1 人のせいで全員が消えないように。 */
  loadSessions(): { loaded: LoadedSession[]; broken: string[] } {
    const loaded: LoadedSession[] = [];
    const broken: string[] = [];
    if (!existsSync(this.sessionsDir)) return { loaded, broken };

    for (const name of readdirSync(this.sessionsDir)) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.sessionsDir, name);
      const data = readJson(path);
      if (!data || typeof data !== 'object') {
        broken.push(name);
        continue;
      }
      const session = data as Session & { version?: number };
      if (typeof session.id !== 'string' || typeof session.name !== 'string') {
        broken.push(name);
        continue;
      }

      const unfinished =
        session.currentTask && session.currentTask.status === 'running' ? session.currentTask.prompt : null;

      loaded.push({
        session: {
          ...session,
          // 走っていたプロセスはもう居ない
          state: session.archived ? 'offline' : 'offline',
          subagents: [],
          currentTask: session.currentTask
            ? {
                ...session.currentTask,
                events: [],
                status: session.currentTask.status === 'running' ? 'interrupted' : session.currentTask.status,
              }
            : null,
        },
        unfinishedPrompt: unfinished,
      });
    }
    return { loaded, broken };
  }

  // -------------------------------------------------------------------------
  // 会計（SPEC §13.3）
  // -------------------------------------------------------------------------

  loadHistory(now: number): History {
    const data = readJson(join(this.root, 'history.json'));
    if (!data || typeof data !== 'object') return createHistory(now);
    const history = data as Partial<History>;
    if (typeof history.currentMonth !== 'string') return createHistory(now);
    return {
      currentMonth: history.currentMonth,
      records: Array.isArray(history.records) ? history.records : [],
      baseline: typeof history.baseline === 'object' && history.baseline !== null ? history.baseline : {},
    };
  }

  saveHistory(history: History): void {
    writeAtomic(join(this.root, 'history.json'), JSON.stringify(history, null, 2));
  }

  // -------------------------------------------------------------------------
  // タスク履歴と生ログ
  // -------------------------------------------------------------------------

  appendTask(sessionId: string, task: Task): void {
    const dir = this.logDir(sessionId);
    mkdirSync(dir, { recursive: true });
    // イベント列は raw.jsonl にあるので、ここでは要約だけ残す
    const slim = { ...task, events: [] };
    appendFileSync(join(dir, 'tasks.jsonl'), `${JSON.stringify(slim)}\n`);
  }

  loadTasks(sessionId: string, limit = 50): Task[] {
    const path = join(this.logDir(sessionId), 'tasks.jsonl');
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter((l) => l !== '');
    const tail = lines.slice(-limit);
    const out: Task[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as Task);
      } catch {
        /* 壊れた行は飛ばす */
      }
    }
    return out;
  }

  rawPath(sessionId: string): string {
    return join(this.logDir(sessionId), 'raw.jsonl');
  }

  /** CLI の生出力を無加工で残す。スキーマが変わったときの生命線（SPEC §5.3）。 */
  appendRaw(sessionId: string, line: string): void {
    const path = this.rawPath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line}\n`);
  }

  /** 大きくなりすぎたら退避する。戻り値は退避したかどうか。 */
  rotateRawIfNeeded(sessionId: string, limit = RAW_ROTATE_BYTES): boolean {
    const path = this.rawPath(sessionId);
    if (!existsSync(path)) return false;
    if (statSync(path).size < limit) return false;
    renameSync(path, join(this.logDir(sessionId), 'raw.1.jsonl'));
    return true;
  }
}
