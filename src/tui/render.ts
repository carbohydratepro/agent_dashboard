/**
 * メイン画面の描画。
 * 画面状態を受け取って Screen に置くだけで、副作用は持たない。
 */

import { Screen } from './screen.ts';
import { computeLayout, tooSmall, MIN_HEIGHT, MIN_WIDTH } from './layout.ts';
import type { AgentKind, Dashboard, Session } from '../core/types.ts';
import type { UsageSnapshot } from '../core/usage.ts';
import type { ResourceSample } from '../core/resources.ts';
import type { Theme } from './theme.ts';
import { DEFAULT_THEME } from './theme.ts';
import { drawTable, tableRows } from './views/table.ts';
import { drawDetail } from './views/detail.ts';
import { drawHeader, drawKeyBar, MAIN_HINTS } from './views/chrome.ts';
import { drawUsage } from './views/usage.ts';
import { fillRect, textCentered } from './paint.ts';

export interface MainScreenState {
  dashboard: Dashboard;
  /** 一覧で選んでいる行 */
  selected: number;
  frame: number;
  now: number;
  expanded: boolean;
  animate: boolean;
  ascii?: boolean;
  availableKinds?: AgentKind[];
  usage?: Partial<Record<AgentKind, UsageSnapshot | null>>;
  theme?: Theme;
  banner?: { text: string; color: number } | null;
  resources?: ResourceSample | null;
}

/** 選択中の行にいるセッション。空きなら null。 */
export function sessionAtRow(dashboard: Dashboard, row: number): Session | null {
  return tableRows(dashboard)[row] ?? null;
}

export function drawTooSmall(screen: Screen, theme: Theme): void {
  fillRect(screen, 0, 0, screen.width, screen.height, theme.bg);
  const mid = Math.floor(screen.height / 2);
  textCentered(screen, 0, mid - 1, screen.width, '画面が小さすぎます', {
    fg: theme.gauge.critical,
    bg: theme.bg,
    bold: true,
  });
  textCentered(
    screen,
    0,
    mid + 1,
    screen.width,
    `${MIN_WIDTH}x${MIN_HEIGHT} 以上にしてください（現在 ${screen.width}x${screen.height}）`,
    { fg: theme.textDim, bg: theme.bg },
  );
}

export function drawMainScreen(screen: Screen, s: MainScreenState): void {
  const theme = s.theme ?? DEFAULT_THEME;
  if (tooSmall(screen.width, screen.height)) {
    drawTooSmall(screen, theme);
    return;
  }

  const layout = computeLayout(screen.width, screen.height, s.dashboard.slotCount);
  screen.clear({ bg: theme.bg });

  drawHeader(screen, layout.header, {
    dashboard: s.dashboard,
    theme,
    now: s.now,
    banner: s.banner ?? null,
    resources: s.resources ?? null,
  });
  drawUsage(screen, layout.usage, {
    theme,
    now: s.now,
    snapshots: s.usage ?? {},
    availableKinds: s.availableKinds,
  });
  drawTable(screen, layout.table, {
    dashboard: s.dashboard,
    selected: s.selected,
    frame: s.frame,
    now: s.now,
    theme,
    animate: s.animate,
    ascii: s.ascii,
  });
  drawDetail(screen, layout.detail, {
    session: sessionAtRow(s.dashboard, s.selected),
    theme,
    now: s.now,
    expanded: s.expanded,
  });
  drawKeyBar(screen, layout.footer, MAIN_HINTS, theme);
}
