/**
 * 引き継ぎ文の組み立て（SPEC §12.4）。
 *
 * 同じスレッドを続けるほど、1 ターンで送り直す量が増える。実測では
 * 5 ターンで 4 倍（23k → 92k トークン）、長いものは 23 万に達していた。
 * 途中で新しいセッションに移れば下地（16k 程度）から始め直せる。
 *
 * ただし何も渡さずに移ると、それまでの経緯を失う。ここでは手元に残っている
 * タスク履歴（指示と結果の要約）から引き継ぎ文を作る。モデルを呼ばないので
 * ただで作れて、作業の質を落とさずにスレッドだけ短くできる。
 */

import type { Task } from './types.ts';

export interface HandoverOptions {
  /** 何ターンぶん載せるか */
  maxTurns?: number;
  /** 1 件あたりの要約の長さ */
  maxSummaryChars?: number;
  /** 作業ディレクトリ。冒頭に添える。 */
  cwd?: string;
}

/** 複数行を 1 行に潰す */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  const line = oneLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * 履歴から引き継ぎ文を作る。渡せるものが無ければ空文字。
 *
 * 新しい順に数えて古い順に並べる。直近のほうが効くので、
 * 削るときは古いほうから落とす。
 */
export function buildHandover(tasks: readonly Task[], opts: HandoverOptions = {}): string {
  const maxTurns = opts.maxTurns ?? 12;
  const maxSummary = opts.maxSummaryChars ?? 300;

  const usable = tasks.filter((t) => t.prompt.trim() !== '');
  if (usable.length === 0) return '';

  const recent = usable.slice(-maxTurns);
  const lines: string[] = [
    'これは前のセッションからの引き継ぎです。',
    '文脈が長くなったため、新しいセッションに移りました。',
    '',
  ];
  if (opts.cwd) lines.push(`作業ディレクトリ: ${opts.cwd}`, '');

  if (usable.length > recent.length) {
    lines.push(`（これ以前に ${usable.length - recent.length} 件のやり取りがあります）`, '');
  }

  lines.push('## これまでのやり取り', '');
  for (const task of recent) {
    lines.push(`### ${clip(task.prompt, 200)}`);
    if (task.summary) lines.push(clip(task.summary, maxSummary));
    else if (task.status === 'cancelled' || task.status === 'interrupted') {
      lines.push('（中断しました）');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('この文脈を踏まえて続けてください。まず、いまの状態を自分で確かめてから作業してください。');
  return lines.join('\n');
}
