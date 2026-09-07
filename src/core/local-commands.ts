/**
 * ダッシュボード側で処理するスラッシュコマンド（SPEC §15.5）。
 *
 * codex は非対話モード（`codex exec`）でスラッシュコマンドを解釈しない。
 * 打っても、ただの指示文としてモデルに渡ってしまう（FINDINGS §9）。
 *
 * ただ、よく使うものは CLI に投げるまでもない。状態や設定はこちらが
 * 持っているので、ここで答えてしまえば codex でも同じように使えるし、
 * 実行の枠も消費しない。
 *
 * ここで扱わないものは、これまでどおり CLI へそのまま渡す。
 */

import type { Session } from './types.ts';
import { STATE_LABEL_JA } from '../tui/theme.ts';
import { readCodexModelInfo } from './models.ts';
import type { CodexModelInfo } from './models.ts';
import { formatTokens } from '../tui/views/format.ts';

export interface LocalCommand {
  name: string;
  /** 候補一覧に出す 1 行 */
  summary: string;
  /** 引数を取るなら、その見本 */
  argHint?: string;
}

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: 'status', summary: 'このセッションの状態・コンテキスト・使用量' },
  { name: 'model', summary: 'モデルを見る / 変える', argHint: '[名前]' },
  { name: 'sandbox', summary: 'サンドボックスの設定を見る' },
  { name: 'compact', summary: 'コンテキストを圧縮する' },
  { name: 'help', summary: 'ここで使えるコマンド一覧' },
];

export type LocalCommandResult =
  /** ここで完結した。text を会話に出す。 */
  | { kind: 'answer'; text: string }
  /** 設定を変えた。text を会話に出す。 */
  | { kind: 'changed'; text: string; model?: string | null }
  /** 圧縮など、アプリ側の操作を起こす */
  | { kind: 'action'; action: 'compact' }
  /** ここでは扱わない。CLI へそのまま渡す。 */
  | { kind: 'passthrough' };

/** 入力を「コマンド名」と「残り」に割る。スラッシュで始まらなければ null。 */
export function parseCommand(input: string): { name: string; rest: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const space = body.search(/\s/);
  if (space < 0) return { name: body, rest: '' };
  return { name: body.slice(0, space), rest: body.slice(space + 1).trim() };
}

export function isLocalCommand(name: string): boolean {
  return LOCAL_COMMANDS.some((c) => c.name === name);
}

export interface LocalCommandContext {
  session: Session;
  /** 使用量の 1 行表示。取れていなければ null。 */
  usageLine?: string | null;
  /** テスト用にモデル情報を差し替える */
  models?: CodexModelInfo;
}

/**
 * 実行する。ここで扱わないものは passthrough を返すので、
 * 呼び出し側はこれまでどおり CLI へ渡せばよい。
 */
export function runLocalCommand(input: string, ctx: LocalCommandContext): LocalCommandResult {
  const parsed = parseCommand(input);
  if (!parsed || !isLocalCommand(parsed.name)) return { kind: 'passthrough' };

  const { session } = ctx;

  // claude は本体が同じコマンドを持っていて、そちらのほうが確実
  // （/compact は本物の圧縮、/status は本体の内部状態）。素直に譲る。
  // ここが埋めるのは、スラッシュコマンドを持たない codex の穴だけ。
  if (session.kind === 'claude') return { kind: 'passthrough' };

  switch (parsed.name) {
    case 'status':
      return { kind: 'answer', text: statusText(session, ctx.usageLine ?? null) };

    case 'model': {
      const info = ctx.models ?? readCodexModelInfo();
      if (parsed.rest === '') return { kind: 'answer', text: modelText(session, info) };
      return {
        kind: 'changed',
        model: parsed.rest,
        text: changeModelText(parsed.rest, info),
      };
    }

    case 'sandbox':
      return { kind: 'answer', text: sandboxText(session) };

    case 'compact':
      return { kind: 'action', action: 'compact' };

    case 'help':
      return { kind: 'answer', text: helpText(session) };

    default:
      return { kind: 'passthrough' };
  }
}

function statusText(session: Session, usageLine: string | null): string {
  const st = session.stats;
  const ctx = session.context;
  const lines = [
    `${session.name} (${session.kind})  ${STATE_LABEL_JA[session.state]}`,
    `コンテキスト  ${Math.round(ctx.ratio * 100)}%${ctx.estimated ? '（推定）' : ''}  /  ${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.windowTokens)}`,
    `やり取り  完了 ${st.tasksCompleted}  失敗 ${st.tasksFailed}  中断 ${st.tasksInterrupted}`,
    `作業  編集 ${st.filesEdited} ファイル  コマンド ${st.commandsRun} 回  トークン ${formatTokens(st.totalTokensIn + st.totalTokensOut)}`,
    `作業場所  ${session.workspace.actualCwd}`,
    `モデル  ${session.modelOverride ?? session.model ?? '（CLI の既定）'}`,
  ];
  if (session.agentSessionId) lines.push(`CLI セッション  ${session.agentSessionId}`);
  if (usageLine) lines.push(`残量  ${usageLine}`);
  return lines.join('\n');
}

/**
 * いまのモデルと、選べるもの。
 *
 * 「（CLI の既定）」とだけ出しても、それが何なのか分からず選びようがない。
 * config.toml に書かれている実際の名前と、codex が持っている一覧を出す。
 */
function modelText(session: Session, info: CodexModelInfo): string {
  const lines: string[] = [];

  if (session.modelOverride) {
    lines.push(`いまのモデル: ${session.modelOverride}（このセッションで指定）`);
    if (info.defaultModel) lines.push(`  既定は ${info.defaultModel}`);
  } else if (session.model) {
    // CLI が報告してきた実物。config.toml より確か。
    lines.push(`いまのモデル: ${session.model}（codex が報告した実際の値）`);
  } else if (info.defaultModel) {
    lines.push(`いまのモデル: ${info.defaultModel}（~/.codex/config.toml の既定）`);
  } else {
    lines.push('いまのモデル: codex 本体の既定（config.toml に指定なし）');
  }
  if (info.reasoningEffort) lines.push(`  推論の深さ: ${info.reasoningEffort}`);

  if (info.choices.length > 0) {
    const width = Math.max(...info.choices.map((c) => c.slug.length));
    lines.push('');
    lines.push('選べるモデル:');
    for (const c of info.choices) {
      const current = session.modelOverride ?? session.model ?? info.defaultModel;
      const mark = c.slug === current ? '*' : ' ';
      lines.push(`${mark} ${c.slug.padEnd(width)}  ${c.description || c.displayName}`);
    }
    // いま使っているものが一覧に無いことがある。models_cache.json は
    // codex が取得した時点のもので、config.toml のほうが新しい場合がある。
    const current = session.modelOverride ?? session.model ?? info.defaultModel;
    if (current && !info.choices.some((c) => c.slug === current)) {
      lines.push('');
      lines.push(`いまの ${current} はこの一覧にありません。一覧が古い可能性があります。`);
    }

    lines.push('');
    lines.push('/model <名前> で変えられます（次のターンから）。');
  } else if (info.error) {
    lines.push('');
    lines.push(`選べるモデルの一覧は出せませんでした: ${info.error}`);
  }

  return lines.join('\n');
}

function changeModelText(slug: string, info: CodexModelInfo): string {
  const known = info.choices.some((c) => c.slug === slug);
  const lines = [`モデルを ${slug} にしました。次のターンから使います。`];
  if (!known && info.choices.length > 0) {
    // 一覧は codex が取ってきたもので、古いことがある。止めはしないが知らせる。
    lines.push(`ただし ${slug} は一覧にありません。名前を間違えていないか確認してください。`);
    lines.push(`一覧: ${info.choices.map((c) => c.slug).join(', ')}`);
  }
  return lines.join('\n');
}

function sandboxText(session: Session): string {
  const ws = session.workspace;
  const lines = [`サンドボックス  ${ws.sandbox ?? '（CLI の既定）'}`];
  if (ws.isolation === 'worktree') lines.push(`worktree  ${ws.actualCwd}  (${ws.branch})`);
  if (session.kind === 'codex') {
    // FINDINGS §1.2。resume は --sandbox を受け付けず、最初の設定を引き継ぐ
    lines.push('codex は会話の途中でサンドボックスを変えられません（最初の設定を引き継ぎます）。');
    lines.push('変えるには、新しいセッションを作り直してください。');
  }
  return lines.join('\n');
}

function helpText(session: Session): string {
  const lines = ['この画面で使えるコマンド:'];
  for (const c of LOCAL_COMMANDS) {
    const name = c.argHint ? `/${c.name} ${c.argHint}` : `/${c.name}`;
    lines.push(`  ${name.padEnd(18)}${c.summary}`);
  }
  if (session.kind === 'claude') {
    lines.push('');
    lines.push('上記以外は claude 本体へそのまま渡します。');
  } else {
    lines.push('');
    lines.push('codex 本体はスラッシュコマンドを解釈しないため、上記以外は指示文として送られます。');
  }
  return lines.join('\n');
}
