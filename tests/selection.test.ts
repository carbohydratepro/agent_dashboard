import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Screen, CONTINUATION } from '../src/tui/screen.ts';
import { ScreenSelection } from '../src/tui/selection.ts';

test('表示セルを複製し、逆方向・複数行・全角境界を選択できる', () => {
  const screen = new Screen(12, 3);
  screen.text(0, 0, 'A日本語B');
  screen.text(0, 1, '次の行');
  const selection = new ScreenSelection(screen, 2, 0);
  selection.end = selection.index(3, 0);
  assert.equal(selection.text(), '日本');
  const reverse = new ScreenSelection(screen, 3, 1);
  reverse.end = reverse.index(2, 0);
  assert.equal(reverse.text(), '日本語B\n次の');
  screen.clear();
  assert.equal(reverse.text(), '日本語B\n次の', '状態更新で選択対象が入れ替わらない');
  reverse.draw(screen, 0x334455, 0xffffff);
  assert.equal(screen.get(1, 0).ch, '日');
  assert.equal(screen.get(2, 0).ch, CONTINUATION);
  assert.equal(screen.get(2, 0).bg, 0x334455);
  assert.equal(screen.get(0, 0).bg, undefined);
});

test('画面外は端へ丸め、行末の空白・全角継続セルをコピーしない', () => {
  const screen = new Screen(8, 2);
  screen.text(0, 0, '日本');
  screen.text(0, 1, 'ok');
  const selection = new ScreenSelection(screen, -10, -5);
  selection.end = selection.index(1000, 1000);
  assert.equal(selection.text(), '日本\nok');
});
