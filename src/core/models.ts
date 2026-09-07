/**
 * codex が使えるモデルの一覧と、いま既定になっているもの。
 *
 * codex 本体はスラッシュコマンドを解釈しないので（FINDINGS §9）、
 * モデルの確認と切り替えはダッシュボード側で面倒を見る。
 * 出どころは codex 自身が置いているファイルで、こちらでは推測しない。
 *
 *   ~/.codex/config.toml       … 既定のモデルと推論の深さ
 *   ~/.codex/models_cache.json … codex が取得したモデルの一覧
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ReasoningLevel {
  effort: string;
  description: string;
}

export interface ModelChoice {
  slug: string;
  displayName: string;
  description: string;
  /** そのモデルが受け付ける推論の深さ。無いモデルもある。 */
  reasoningLevels: ReasoningLevel[];
  defaultReasoning: string | null;
}

export interface CodexModelInfo {
  /** config.toml の既定。書かれていなければ null（codex 本体の既定に従う） */
  defaultModel: string | null;
  /** model_reasoning_effort。無ければ null */
  reasoningEffort: string | null;
  /** 選べるモデル。取れなければ空 */
  choices: ModelChoice[];
  /** 読めなかった理由。全部読めていれば null */
  error: string | null;
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

/**
 * config.toml のトップレベルから 1 つ読む。
 *
 * 最初の [セクション] より前だけを見る。`[notice.model_migrations]` のような
 * 別のテーブルにも model を含むキーがあり、素朴に全文を探すと拾ってしまう。
 */
export function readTopLevelString(toml: string, key: string): string | null {
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    if (line === '' || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m && m[1] === key) return m[2] ?? null;
  }
  return null;
}

/** models_cache.json から、一覧に出してよいものだけを取り出す */
export function parseModelsCache(json: unknown): ModelChoice[] {
  if (typeof json !== 'object' || json === null) return [];
  const models = (json as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];

  const out: Array<ModelChoice & { priority: number }> = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const m = entry as Record<string, unknown>;
    // codex 自身が隠しているものは出さない（内部用・レビュー専用など）
    if (m.visibility !== 'list') continue;
    if (typeof m.slug !== 'string' || m.slug === '') continue;
    out.push({
      slug: m.slug,
      displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
      description: typeof m.description === 'string' ? m.description : '',
      reasoningLevels: parseReasoningLevels(m.supported_reasoning_levels),
      defaultReasoning:
        typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : null,
      priority: typeof m.priority === 'number' ? m.priority : 999,
    });
  }
  // codex の並び順（priority）に合わせる。こちらで良し悪しを決めない。
  out.sort((a, b) => a.priority - b.priority);
  return out.map(({ priority, ...rest }) => {
    void priority;
    return rest;
  });
}

function parseReasoningLevels(raw: unknown): ReasoningLevel[] {
  if (!Array.isArray(raw)) return [];
  const out: ReasoningLevel[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.effort !== 'string' || r.effort === '') continue;
    out.push({
      effort: r.effort,
      description: typeof r.description === 'string' ? r.description : '',
    });
  }
  return out;
}

export interface CodexModelOptions {
  /** テスト用に置き場所を差し替える */
  home?: string;
}

export function readCodexModelInfo(opts: CodexModelOptions = {}): CodexModelInfo {
  const home = opts.home ?? codexHome();
  const info: CodexModelInfo = {
    defaultModel: null,
    reasoningEffort: null,
    choices: [],
    error: null,
  };
  const problems: string[] = [];

  const configPath = join(home, 'config.toml');
  if (existsSync(configPath)) {
    try {
      const toml = readFileSync(configPath, 'utf8');
      info.defaultModel = readTopLevelString(toml, 'model');
      info.reasoningEffort = readTopLevelString(toml, 'model_reasoning_effort');
    } catch (err) {
      problems.push(`config.toml が読めません（${(err as Error).message}）`);
    }
  }

  const cachePath = join(home, 'models_cache.json');
  if (existsSync(cachePath)) {
    try {
      info.choices = parseModelsCache(JSON.parse(readFileSync(cachePath, 'utf8')));
    } catch (err) {
      problems.push(`models_cache.json が読めません（${(err as Error).message}）`);
    }
  } else {
    problems.push('モデル一覧がまだありません（codex を 1 回動かすと作られます）');
  }

  info.error = problems.length > 0 ? problems.join(' / ') : null;
  return info;
}
