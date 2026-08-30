/** 選択中のセッションの詳細。 */

import type { Screen } from '../screen.ts';
import type { Rect } from '../layout.ts';
import type { AgentEvent, Session } from '../../core/types.ts';
import { BUSY_STATES } from '../../core/types.ts';
import type { Theme } from '../theme.ts';
import { gaugeColor, sessionColor, STATE_LABEL_JA } from '../theme.ts';
import { drawGauge, fillRect, hline, textClipped, textRight, wrapText } from '../paint.ts';
import { ROLE_LABEL } from '../../core/naming.ts';
import { utilization } from '../../core/stats.ts';
import { formatDuration, formatPercent, formatTokens } from './format.ts';

export { formatDuration, formatTokens } from './format.ts';

export interface DetailViewState {
  session: Session | null;
  theme: Theme;
  now: number;
  expanded: boolean;
}

/** いま Enter で下書きをそのまま送れる状態か */
export function canSendDraft(session: Session): boolean {
  return (
    session.state === 'idle' &&
    session.currentTask !== null &&
    session.currentTask.status !== 'running' &&
    session.nextPrompt.trim() !== ''
  );
}

export function drawDetail(screen: Screen, rect: Rect, s: DetailViewState): void {
  const { theme } = s;
  fillRect(screen, rect.x, rect.y, rect.w, rect.h, theme.panelBg);
  hline(screen, rect.x, rect.y, rect.w, { fg: theme.border, bg: theme.panelBg });

  const session = s.session;
  if (!session) {
    textClipped(screen, rect.x + 2, rect.y + 1, rect.w - 4, '空きスロットです。[n] でセッションを追加します。', {
      fg: theme.textDim,
      bg: theme.panelBg,
    });
    return;
  }

  const bg = theme.panelBg;
  const inner = rect.w - 4;
  let y = rect.y;

  // 見出し（罫線に重ねる）
  const head = ` ${session.name}  ${session.kind}  ${ROLE_LABEL[session.role]} `;
  screen.text(rect.x + 2, y, head, { fg: sessionColor(theme, session.color), bg, bold: true });
  textRight(screen, rect.x + 2, y, inner, ` ${STATE_LABEL_JA[session.state]} `, {
    fg: theme.state[session.state],
    bg,
    bold: true,
  });
  y += 1;

  // コンテキストと稼働
  const pct = Math.round(session.context.ratio * 100);
  screen.text(rect.x + 2, y, 'コンテキスト ', { fg: theme.textDim, bg });
  drawGauge(screen, rect.x + 15, y, 20, session.context.ratio, {
    filled: gaugeColor(theme, session.context.ratio),
    emptyStyle: { fg: theme.border, bg },
  });
  textClipped(
    screen,
    rect.x + 36,
    y,
    26,
    `${pct}%${session.context.estimated ? '~ 概算' : ''}  ${formatTokens(session.context.usedTokens)}/${formatTokens(session.context.windowTokens)}`,
    { fg: theme.text, bg },
  );

  const elapsed = Math.max(1, s.now - session.uptime.startedAt);
  textRight(
    screen,
    rect.x + 2,
    y,
    inner,
    `経過 ${formatDuration(elapsed)}  実働 ${formatDuration(session.uptime.activeMs)}  稼働率 ${formatPercent(utilization(session.uptime.activeMs, elapsed))}`,
    { fg: theme.textDim, bg },
  );
  y += 1;

  // 集計
  const st = session.stats;
  textClipped(
    screen,
    rect.x + 2,
    y,
    inner,
    `完了 ${st.tasksCompleted}  失敗 ${st.tasksFailed}  中断 ${st.tasksInterrupted}  編集 ${st.filesEdited}  実行 ${st.commandsRun}  サブ ${st.subagentsSpawned}  承認 ${st.approvalsGranted}/${st.approvalsRequested}  復帰 ${st.reconnects}  in ${formatTokens(st.totalTokensIn)} out ${formatTokens(st.totalTokensOut)}`,
    { fg: theme.textDim, bg },
  );
  y += 1;

  // 作業環境
  const ws = session.workspace;
  const wsText =
    ws.isolation === 'worktree'
      ? `${ws.requestedCwd}  →  worktree ${ws.branch}`
      : ws.requestedCwd + (ws.sandbox ? `  sandbox=${ws.sandbox}` : '');
  textClipped(screen, rect.x + 2, y, inner, wsText, { fg: theme.system, bg });
  y += 1;

  // 承認待ち
  if (session.pendingApprovals.length > 0 && y < rect.y + rect.h) {
    const a = session.pendingApprovals[0]!;
    const target = String(a.toolInput.file_path ?? a.toolInput.command ?? '');
    const more = session.pendingApprovals.length > 1 ? ` ほか ${session.pendingApprovals.length - 1} 件` : '';
    textClipped(
      screen,
      rect.x + 2,
      y,
      inner,
      `[!] 承認待ち ${session.pendingApprovals.length} 件  ${a.toolName}: ${target}${more}`,
      {
      fg: theme.gauge.high,
      bg,
        bold: true,
      },
    );
    textRight(screen, rect.x + 2, y, inner, '[Enter] 内容を見る', { fg: theme.accent, bg });
    y += 1;
  }

  // サブエージェント
  if (session.subagents.length > 0 && y < rect.y + rect.h - 1) {
    textClipped(screen, rect.x + 2, y, inner, `サブエージェント ${session.subagents.length}`, {
      fg: theme.state.delegating,
      bg,
    });
    y += 1;
    for (const sub of session.subagents) {
      if (y >= rect.y + rect.h - 1) break;
      const tool = sub.lastToolName ? `${sub.lastToolName} ×${sub.toolUses}` : '起動中';
      textClipped(
        screen,
        rect.x + 4,
        y,
        inner - 2,
        `${sub.name}  ${sub.agentType}  ${tool}  ${formatTokens(sub.totalTokens)} tok  ${(sub.durationMs / 1000).toFixed(1)}s  ${sub.currentAction}`,
        { fg: sub.status === 'running' ? theme.text : theme.textDim, bg },
      );
      y += 1;
    }
  }

  // 実行中のタスク
  const task = session.currentTask;
  if (task && y < rect.y + rect.h - 1) {
    const taskElapsed = formatDuration((task.endedAt ?? s.now) - task.startedAt);
    const mark = task.status === 'running' ? '▸' : task.status === 'done' ? '✓' : '×';
    const color =
      task.status === 'done'
        ? theme.gauge.good
        : task.status === 'running'
          ? theme.text
          : theme.gauge.high;
    textClipped(screen, rect.x + 2, y, inner - 12, `${mark} ${task.prompt}`, { fg: color, bg });
    textRight(screen, rect.x + 2, y, inner, taskElapsed, { fg: theme.textDim, bg });
    y += 1;

    for (const line of recentActivity(task.events, s.expanded ? rect.y + rect.h - y - 1 : 2)) {
      if (y >= rect.y + rect.h - 1) break;
      textClipped(screen, rect.x + 4, y, inner - 2, line, { fg: theme.textDim, bg });
      y += 1;
    }
  }

  // 次に送るプロンプト
  const draft = session.nextPrompt.trim();
  if (draft !== '' && y < rect.y + rect.h) {
    if (canSendDraft(session) && y + 1 < rect.y + rect.h) {
      textClipped(screen, rect.x + 2, y, inner, '次に送るプロンプト', {
        fg: theme.accent,
        bg,
        bold: true,
      });
      y += 1;
      for (const line of wrapText(session.nextPrompt, inner - 6).slice(0, 2)) {
        if (y >= rect.y + rect.h) break;
        textClipped(screen, rect.x + 4, y, inner - 4, `「${line}」`, {
          fg: theme.textBright,
          bg,
        });
        y += 1;
      }
      if (y < rect.y + rect.h) {
        textClipped(screen, rect.x + 4, y, inner - 4, '[Enter] 送信   [e] 編集   [d] 削除', {
          fg: theme.textDim,
          bg,
        });
        y += 1;
      }
    } else {
      const first = session.nextPrompt.split('\n')[0] ?? '';
      textClipped(screen, rect.x + 2, y, inner, `[P] 次: ${first}`, { fg: theme.accent, bg });
      y += 1;
    }
  }

  if (session.lastError && y < rect.y + rect.h) {
    textClipped(screen, rect.x + 2, y, inner, `× ${session.lastError}`, {
      fg: theme.gauge.critical,
      bg,
    });
  }
  void BUSY_STATES;
}

/** 直近のツール実行を読める行にする */
export function recentActivity(events: AgentEvent[], max: number): string[] {
  if (max <= 0) return [];
  const lines: string[] = [];
  for (const ev of events) {
    if (ev.t === 'tool_start') {
      const indent = ev.parentToolUseId ? '  └ ' : '';
      lines.push(`${indent}${ev.name}  ${ev.detail}`);
    } else if (ev.t === 'subagent_start') {
      lines.push(`Agent (${ev.agentType})  ${ev.description}`);
    } else if (ev.t === 'subagent_progress') {
      lines.push(`  └ ${ev.lastToolName || '実行中'}: ${ev.description}  ${formatTokens(ev.totalTokens)} tok`);
    }
  }
  return lines.slice(-max);
}
