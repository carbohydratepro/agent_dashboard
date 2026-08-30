/** セッションの識別名と役割プリセット。 */

import type { AgentKind, Role } from './types.ts';

export const ROLES: readonly Role[] = ['general', 'backend', 'frontend', 'infra', 'research', 'qa'];

export const ROLE_LABEL: Record<Role, string> = {
  general: '汎用',
  backend: 'バックエンド',
  frontend: 'フロントエンド',
  infra: 'インフラ',
  research: '調査',
  qa: 'テスト',
};

/**
 * 役割ごとのシステムプロンプト追記。
 * 表示だけの飾りではなく、実際の応答の傾向を変える。
 */
export const ROLE_PROMPT: Record<Role, string> = {
  general: '',
  backend: 'API 設計・データ整合性・パフォーマンスを重視してください。',
  frontend: 'UI/UX とアクセシビリティを重視してください。',
  infra: 'CI/CD・設定・運用のしやすさを重視してください。',
  research: 'まず読解と要約を優先し、コードの変更は慎重に行ってください。',
  qa: 'テストの作成とエッジケースの列挙を優先してください。',
};

/** 一覧で見分けるための色。意味は持たない。 */
export const SESSION_COLORS = ['sky', 'moss', 'clay', 'plum', 'sand', 'slate'] as const;

export function colorForSlot(slot: number): string {
  return SESSION_COLORS[slot % SESSION_COLORS.length]!;
}

/**
 * 識別名。同じ種別の中で連番にする（claude-1, codex-2 …）。
 * 使用中の名前を渡すと、重複しない番号を選ぶ。
 */
export function nextName(kind: AgentKind, used: Iterable<string>): string {
  const taken = new Set(used);
  for (let i = 1; i < 1000; i += 1) {
    const name = `${kind}-${i}`;
    if (!taken.has(name)) return name;
  }
  return `${kind}-${Date.now()}`;
}
