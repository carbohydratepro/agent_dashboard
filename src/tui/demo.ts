/**
 * 静的な見本を描いて標準出力に流すデモ。
 *   node src/tui/demo.ts            色付き
 *   node src/tui/demo.ts --plain    レイアウト確認用のプレーンテキスト
 *   node src/tui/demo.ts --ascii    ブロック文字を使わない描画
 */

import { Screen } from './screen.ts';
import { drawMainScreen } from './render.ts';
import { detectColorMode } from './ansi.ts';
import { sampleDashboard, FIXTURE_NOW } from '../../tests/fixtures/dashboard.ts';

const plain = process.argv.includes('--plain');
const ascii = process.argv.includes('--ascii');
const width = Number(process.env.VO_COLS ?? 100);
const height = Number(process.env.VO_ROWS ?? 32);

const screen = new Screen(width, height, plain ? 'none' : detectColorMode());
drawMainScreen(screen, {
  dashboard: sampleDashboard(),
  selected: 0,
  frame: 0,
  now: FIXTURE_NOW,
  expanded: false,
  animate: true,
  ascii,
});

if (plain) {
  console.log(screen.toStrings().map((r, i) => `${String(i).padStart(2)}|${r}`).join('\n'));
} else {
  process.stdout.write(screen.render());
  process.stdout.write('\n');
}
