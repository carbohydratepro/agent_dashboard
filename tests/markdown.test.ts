/**
 * マークダウンの表示。
 * 記号を装飾に置き換えるだけで、中身は変えない。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseInline, renderMarkdown, wrapSpans } from '../src/tui/markdown.ts';
import type { MarkdownLine } from '../src/tui/markdown.ts';
import { DEFAULT_THEME } from '../src/tui/theme.ts';
import { displayWidth } from '../src/tui/width.ts';

const theme = DEFAULT_THEME;
const opts = { theme, width: 60 };

function text(lines: MarkdownLine[]): string {
  return lines.map((l) => ' '.repeat(l.indent) + l.spans.map((s) => s.text).join('')).join('\n');
}

function styleOf(lines: MarkdownLine[], needle: string) {
  for (const line of lines) {
    for (const span of line.spans) {
      if (span.text.includes(needle)) return span.style;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

describe('インライン', () => {
  test('太字は記号を外して強調する', () => {
    const tokens = parseInline('これは**重要**です', opts);
    const joined = tokens.map((t) => t.text).join('');
    assert.equal(joined, 'これは重要です', '記号が消える');
    assert.equal(tokens.find((t) => t.text === '重要')?.style.bold, true);
  });

  test('コードは色を変えて中身をそのまま出す', () => {
    const tokens = parseInline('`Date.now()` を使う', opts);
    assert.equal(tokens[0]!.text, 'Date.now()', 'バッククォートの中は解釈しない');
    assert.equal(tokens[0]!.style.fg, theme.accent);
  });

  test('コードの中の記号は装飾にしない', () => {
    const tokens = parseInline('`**not bold**`', opts);
    assert.equal(tokens[0]!.text, '**not bold**');
    assert.notEqual(tokens[0]!.style.bold, true);
  });

  test('斜体と打ち消し', () => {
    assert.equal(parseInline('*strong*', opts)[0]!.style.italic, true);
    assert.equal(parseInline('~~old~~', opts)[0]!.style.strike, true);
  });

  test('リンクは URL も残す', () => {
    const tokens = parseInline('[RFC](https://example.com) を参照', opts);
    const joined = tokens.map((t) => t.text).join('');
    assert.ok(joined.includes('RFC'));
    assert.ok(joined.includes('https://example.com'), 'URL を捨てない');
    assert.equal(tokens[0]!.style.underline, true);
  });

  test('記法でない記号はそのまま残す', () => {
    assert.equal(parseInline('2 * 3 = 6', opts).map((t) => t.text).join(''), '2 * 3 = 6');
    assert.equal(parseInline('a_b_c', opts).map((t) => t.text).join(''), 'a_b_c');
  });

  test('閉じていない記号を食べない', () => {
    assert.equal(parseInline('**未完', opts).map((t) => t.text).join(''), '**未完');
    assert.equal(parseInline('`未完', opts).map((t) => t.text).join(''), '`未完');
  });
});

describe('折り返し', () => {
  test('装飾を保ったまま折り返す', () => {
    const tokens = parseInline('**あいうえおかきくけこさしすせそ**', opts);
    const lines = wrapSpans(tokens, 10, 0);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(displayWidth(line.spans.map((s) => s.text).join('')) <= 10);
      for (const span of line.spans) assert.equal(span.style.bold, true, '装飾が続く');
    }
  });

  test('全角の途中で割らない', () => {
    const lines = wrapSpans([{ text: 'あいうえお', style: {} }], 5, 0);
    for (const line of lines) {
      assert.ok(displayWidth(line.spans.map((s) => s.text).join('')) <= 5);
    }
    assert.equal(text(lines).replace(/\n/g, ''), 'あいうえお', '文字を落とさない');
  });
});

describe('ブロック', () => {
  test('見出しは記号を外して強調する', () => {
    const lines = renderMarkdown('## やったこと', opts);
    assert.equal(text(lines), 'やったこと');
    assert.equal(styleOf(lines, 'やったこと')?.bold, true);
  });

  test('箇条書きは中黒にする', () => {
    const out = text(renderMarkdown('- 一つ目\n- 二つ目', opts));
    assert.ok(out.includes('• 一つ目'));
    assert.ok(out.includes('• 二つ目'));
    assert.equal(out.includes('- 一つ目'), false);
  });

  test('入れ子の箇条書きは下げる', () => {
    const lines = renderMarkdown('- 親\n  - 子', opts);
    assert.equal(lines[0]!.indent, 0);
    assert.ok(lines[1]!.indent > 0);
  });

  test('番号付きは番号を残す', () => {
    assert.ok(text(renderMarkdown('1. 最初\n2. 次', opts)).includes('1. 最初'));
  });

  test('引用は縦線にする', () => {
    assert.ok(text(renderMarkdown('> 補足です', opts)).includes('│ 補足です'));
  });

  test('水平線は罫線にする', () => {
    const out = text(renderMarkdown('---', opts));
    assert.ok(out.startsWith('─'));
    assert.equal(out.includes('-'), false);
  });
});

describe('コードブロック', () => {
  const code = ['```ts', 'const a = **1**;', '  return a;', '```'].join('\n');

  test('中身をそのまま出す', () => {
    const out = text(renderMarkdown(code, opts));
    assert.ok(out.includes('const a = **1**;'), '中の記号を装飾にしない');
    assert.ok(out.includes('  return a;'), '字下げを保つ');
    assert.equal(out.includes('```'), false, 'フェンス自体は出さない');
  });

  test('言語名を残す', () => {
    assert.ok(text(renderMarkdown(code, opts)).includes('ts'));
  });

  test('背景を変えて本文と区別する', () => {
    const lines = renderMarkdown(code, opts);
    assert.equal(styleOf(lines, 'return a;')?.bg, theme.rowAlt);
  });

  test('閉じていなくても落ちない', () => {
    const out = text(renderMarkdown('```\nconst a = 1;', opts));
    assert.ok(out.includes('const a = 1;'));
  });

  test('長い行は幅で折り返す', () => {
    const long = '```\n' + 'x'.repeat(200) + '\n```';
    for (const line of renderMarkdown(long, opts)) {
      assert.ok(displayWidth(line.spans.map((s) => s.text).join('')) + line.indent <= 60);
    }
  });
});

describe('表', () => {
  const table = [
    '| 項目 | 変更前 | 変更後 |',
    '|---|---|---|',
    '| 判定 | ローカル | UTC |',
  ].join('\n');

  test('桁を揃えて罫線を引く', () => {
    const lines = renderMarkdown(table, opts);
    const out = text(lines);
    assert.ok(out.includes('項目'));
    assert.ok(out.includes('│'), '区切りを引く');
    assert.ok(out.includes('┼'), '見出しの下に罫線');
    assert.equal(out.includes('|---|'), false, '記法は出さない');
  });

  test('見出しを強調する', () => {
    assert.equal(styleOf(renderMarkdown(table, opts), '項目')?.bold, true);
  });

  test('幅に収まる', () => {
    const wide = [
      `| ${'あ'.repeat(40)} | ${'い'.repeat(40)} |`,
      '|---|---|',
      `| ${'う'.repeat(40)} | ${'え'.repeat(40)} |`,
    ].join('\n');
    for (const line of renderMarkdown(wide, { theme, width: 50 })) {
      assert.ok(displayWidth(line.spans.map((s) => s.text).join('')) + line.indent <= 50);
    }
  });
});

describe('情報を落とさない', () => {
  test('素の文章はそのまま', () => {
    const plain = '普通の文章です。記号は入っていません。';
    assert.equal(text(renderMarkdown(plain, opts)), plain);
  });

  test('どの行も幅に収まる', () => {
    const source = [
      '# 見出し',
      '**太字**と`コード`と[リンク](https://example.com/very/long/path)',
      '- 箇条書きがとても長い場合の折り返しを確認する'.repeat(3),
      '```',
      'code',
      '```',
    ].join('\n');
    for (const line of renderMarkdown(source, opts)) {
      const w = displayWidth(line.spans.map((s) => s.text).join('')) + line.indent;
      assert.ok(w <= 60, `はみ出し(${w}): ${line.spans.map((s) => s.text).join('')}`);
    }
  });

  test('空行を保つ', () => {
    const lines = renderMarkdown('上\n\n下', opts);
    assert.equal(lines.length, 3);
    assert.equal(lines[1]!.spans.length, 0);
  });
});
