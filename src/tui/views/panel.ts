/** 全画面パネルの共通枠。ログ・ヘルプ・人事ファイルなどで使い回す。 */

import type { Screen } from '../screen.ts';
import type { Theme } from '../theme.ts';
import { drawBox, fillRect, textClipped, textRight } from '../paint.ts';

export interface PanelLine {
  text: string;
  color?: number;
  bold?: boolean;
  dim?: boolean;
  indent?: number;
}

export interface PanelOptions {
  title: string;
  lines: PanelLine[];
  scroll: number;
  theme: Theme;
  footer?: string;
  /** 選択中の行。一覧から選ぶ画面で使う */
  selected?: number;
}

export interface PanelMetrics {
  visibleRows: number;
  maxScroll: number;
}

export function panelMetrics(screen: Screen, lineCount: number): PanelMetrics {
  const visibleRows = Math.max(1, screen.height - 4);
  return { visibleRows, maxScroll: Math.max(0, lineCount - visibleRows) };
}

export function drawPanel(screen: Screen, opts: PanelOptions): PanelMetrics {
  const { theme } = opts;
  fillRect(screen, 0, 0, screen.width, screen.height, theme.bg);
  drawBox(screen, 0, 0, screen.width, screen.height, {
    style: { fg: theme.border, bg: theme.bg },
    title: opts.title,
    titleStyle: { fg: theme.accent, bg: theme.bg, bold: true },
    fill: theme.panelBg,
  });

  const metrics = panelMetrics(screen, opts.lines.length);
  const start = Math.max(0, Math.min(opts.scroll, metrics.maxScroll));
  const inner = screen.width - 4;

  for (let i = 0; i < metrics.visibleRows; i += 1) {
    const line = opts.lines[start + i];
    if (!line) break;
    const indent = line.indent ?? 0;
    const isSelected = opts.selected === start + i;
    if (isSelected) {
      for (let x = 1; x < screen.width - 1; x += 1) {
        screen.set(x, 2 + i, ' ', { bg: theme.border });
      }
    }
    textClipped(screen, 2 + indent, 2 + i, inner - indent, line.text, {
      fg: isSelected ? theme.textBright : (line.color ?? theme.text),
      bg: isSelected ? theme.border : theme.panelBg,
      bold: line.bold || isSelected,
      dim: line.dim && !isSelected,
    });
  }

  if (metrics.maxScroll > 0) {
    textRight(screen, 2, screen.height - 1, inner, ` ${start + 1}-${Math.min(start + metrics.visibleRows, opts.lines.length)}/${opts.lines.length} `, {
      fg: theme.textDim,
      bg: theme.bg,
    });
  }
  if (opts.footer) {
    textClipped(screen, 2, screen.height - 1, inner, ` ${opts.footer} `, {
      fg: theme.textDim,
      bg: theme.bg,
    });
  }
  return metrics;
}
