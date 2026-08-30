/** ヘッダーとキーバー。 */

import type { Screen } from '../screen.ts';
import type { Rect } from '../layout.ts';
import type { Dashboard } from '../../core/types.ts';
import { BUSY_STATES } from '../../core/types.ts';
import type { Theme } from '../theme.ts';
import { fillRect, textClipped, textRight } from '../paint.ts';

export interface HeaderState {
  dashboard: Dashboard;
  theme: Theme;
  now: number;
  banner?: { text: string; color: number } | null;
}

function clockText(now: number): string {
  const d = new Date(now);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function drawHeader(screen: Screen, rect: Rect, s: HeaderState): void {
  const { theme, dashboard } = s;
  fillRect(screen, rect.x, rect.y, rect.w, rect.h, theme.bg);

  if (s.banner) {
    textClipped(screen, rect.x + 1, rect.y, rect.w - 2, s.banner.text, {
      fg: s.banner.color,
      bg: theme.bg,
      bold: true,
    });
    return;
  }

  const active = dashboard.sessions.filter((x) => !x.archived);
  const busy = active.filter((x) => BUSY_STATES.has(x.state)).length;
  const blocked = active.filter((x) => x.pendingApprovals.length > 0).length;

  screen.text(rect.x + 1, rect.y, dashboard.title, { fg: theme.accent, bg: theme.bg, bold: true });

  const parts = [`${active.length}/${dashboard.slotCount} セッション`, `実行中 ${busy}`];
  if (blocked > 0) parts.push(`承認待ち ${blocked}`);
  parts.push(clockText(s.now));

  textRight(screen, rect.x, rect.y, rect.w - 1, parts.join('   '), {
    fg: theme.textDim,
    bg: theme.bg,
  });
}

export interface KeyHint {
  key: string;
  label: string;
}

export function drawKeyBar(screen: Screen, rect: Rect, hints: KeyHint[], theme: Theme): void {
  fillRect(screen, rect.x, rect.y, rect.w, rect.h, theme.bg);
  let x = rect.x + 1;
  for (const hint of hints) {
    if (x >= rect.w - 2) break;
    x += screen.text(x, rect.y, hint.key, { fg: theme.accent, bg: theme.bg });
    x += screen.text(x, rect.y, ` ${hint.label}   `, { fg: theme.textDim, bg: theme.bg });
  }
}

export const MAIN_HINTS: KeyHint[] = [
  { key: '↑↓', label: '選択' },
  { key: 'Enter', label: '開く' },
  { key: 'n', label: '追加' },
  { key: 'e', label: '下書き' },
  { key: 'L', label: 'ログ' },
  { key: 's', label: '統計' },
  { key: 'a', label: '履歴' },
  { key: '?', label: 'ヘルプ' },
  { key: 'q', label: '終了' },
];
