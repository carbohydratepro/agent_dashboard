/** キー入力のデコード（SPEC §16）。 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { decodeKeys, isPrintable, keyToString } from '../src/tui/input.ts';
import { MOUSE_OFF, MOUSE_ON } from '../src/tui/ansi.ts';
import { NodeTerminal } from '../src/tui/terminal.ts';
import { TextInput, layoutTextInput } from '../src/tui/widgets/textinput.ts';

function one(raw: string) {
  const keys = decodeKeys(raw);
  assert.equal(keys.length, 1, `1 キーになるはず: ${JSON.stringify(raw)} → ${keys.length}`);
  return keys[0]!;
}

describe('矢印とカーソル系', () => {
  test('F2 を SS3・CSI・チルダ形式で受ける', () => {
    for (const raw of ['\x1bOQ', '\x1b[Q', '\x1b[12~']) {
      assert.equal(one(raw).name, 'f2');
    }
  });
  test('矢印キー', () => {
    assert.equal(one('\x1b[A').name, 'up');
    assert.equal(one('\x1b[B').name, 'down');
    assert.equal(one('\x1b[C').name, 'right');
    assert.equal(one('\x1b[D').name, 'left');
  });

  test('アプリケーションカーソルモードでも読める', () => {
    assert.equal(one('\x1bOA').name, 'up');
    assert.equal(one('\x1bOD').name, 'left');
  });

  test('PgUp / PgDn / Home / End / Delete', () => {
    assert.equal(one('\x1b[5~').name, 'pageup');
    assert.equal(one('\x1b[6~').name, 'pagedown');
    assert.equal(one('\x1b[H').name, 'home');
    assert.equal(one('\x1b[F').name, 'end');
    assert.equal(one('\x1b[3~').name, 'delete');
  });

  test('修飾キー付きの矢印', () => {
    const k = one('\x1b[1;5C');
    assert.equal(k.name, 'right');
    assert.equal(k.ctrl, true);
    const shifted = one('\x1b[1;2A');
    assert.equal(shifted.shift, true);
  });
});

describe('複数行入力の上下移動', () => {
  test('明示改行した行を同じ表示桁で上下する', () => {
    const input = new TextInput();
    input.setValue('abc\ndefgh\nx');

    assert.equal(input.moveVertical(-1, 80), true);
    input.insert('!');
    assert.equal(input.value, 'abc\nd!efgh\nx');
  });

  test('画面幅で折り返した行も上下できる', () => {
    const input = new TextInput();
    input.setValue('abcdef');

    assert.deepEqual(layoutTextInput(input.value, input.cursor, 3).lines, ['abc', 'def']);
    assert.equal(input.moveVertical(-1, 3), true);
    input.insert('!');
    assert.equal(input.value, 'abc!def');
  });

  test('入力の先頭を越えたときだけ送信履歴へ移れる', () => {
    const input = new TextInput();
    input.remember('前の指示');
    input.setValue('上\n下');

    assert.equal(input.moveVertical(-1, 80), true, 'まず入力内の上の行へ動く');
    assert.equal(input.moveVertical(-1, 80), false, '先頭では履歴側へ渡す');
    assert.equal(input.historyPrev(), true);
    assert.equal(input.value, '前の指示');
  });
});

describe('制御キー', () => {
  test('Enter / Tab / Esc / Backspace', () => {
    assert.equal(one('\r').name, 'enter', 'Enter は CR');
    assert.equal(one('\n').name, 'newline', 'Ctrl+J は LF。改行として扱う');
    assert.equal(one('\t').name, 'tab');
    assert.equal(one('\x1b').name, 'escape');
    assert.equal(one('\x7f').name, 'backspace');
  });

  test('Shift+Tab', () => {
    const k = one('\x1b[Z');
    assert.equal(k.name, 'backtab');
    assert.equal(k.shift, true);
  });

  test('Ctrl+文字', () => {
    const c = one('\x03');
    assert.equal(c.ctrl, true);
    assert.equal(c.ch, 'c');
    assert.equal(keyToString(c), 'ctrl+c');
    assert.equal(one('\x0c').ch, 'l', 'Ctrl+L');
    assert.equal(one('\x12').ch, 'r', 'Ctrl+R');
  });

  test('Alt+文字 と Alt+Enter', () => {
    const a = one('\x1ba');
    assert.equal(a.alt, true);
    assert.equal(a.ch, 'a');
    const enter = one('\x1b\r');
    assert.equal(enter.name, 'newline', 'Alt+Enter も改行');
    assert.equal(enter.alt, true);
  });
});

describe('文字入力', () => {
  test('印字可能な文字', () => {
    const k = one('a');
    assert.equal(k.name, 'char');
    assert.equal(k.ch, 'a');
    assert.equal(isPrintable(k), true);
    assert.equal(isPrintable(one('\x03')), false, 'Ctrl は流さない');
    assert.equal(isPrintable(one('\x1ba')), false, 'Alt も流さない');
  });

  test('日本語も 1 キーとして扱う', () => {
    const k = one('あ');
    assert.equal(k.ch, 'あ');
    assert.equal(isPrintable(k), true);
  });

  test('サロゲートペアを分割しない', () => {
    const k = one('𠮷');
    assert.equal(k.ch, '𠮷');
  });

  test('まとめて届いた入力を分解する', () => {
    const keys = decodeKeys('ab\x1b[Ac');
    assert.deepEqual(keys.map((k) => (k.name === 'char' ? k.ch : k.name)), ['a', 'b', 'up', 'c']);
  });

  test('ペーストされた日本語', () => {
    const keys = decodeKeys('こんにちは');
    assert.equal(keys.length, 5);
    assert.equal(keys.map((k) => k.ch).join(''), 'こんにちは');
  });
});

describe('改行のキー（端末に奪われても打てるように）', () => {
  test('送信と改行を別のキーにする', () => {
    assert.equal(one('\r').name, 'enter', 'Enter は送信');
    assert.equal(one('\n').name, 'newline', 'Ctrl+J は改行');
  });

  test('Shift+Enter を CSI-u で受ける', () => {
    const k = one('\x1b[13;2u');
    assert.equal(k.name, 'newline');
    assert.equal(k.shift, true);
  });

  test('Shift+Enter を modifyOtherKeys でも受ける', () => {
    const k = one('\x1b[27;2;13~');
    assert.equal(k.name, 'newline');
    assert.equal(k.shift, true);
  });

  test('修飾なしの Enter は CSI-u でも送信のまま', () => {
    assert.equal(one('\x1b[13;1u').name, 'enter');
  });

  test('CSI-u の他のキーも読める', () => {
    assert.equal(one('\x1b[9;2u').name, 'backtab', 'Shift+Tab');
    assert.equal(one('\x1b[27;1;27~').name, 'escape');
    const c = one('\x1b[97;5u');
    assert.equal(c.ch, 'a');
    assert.equal(c.ctrl, true);
  });
});

// ---------------------------------------------------------------------------

describe('マウスホイール', () => {
  test('実端末ではホイール報告を有効にする', () => {
    let written = '';
    const input = {
      isTTY: false,
      resume() {},
      pause() {},
      on() {},
      off() {},
    } as unknown as NodeJS.ReadStream;
    const output = {
      columns: 80,
      rows: 24,
      write(data: string) {
        written += data;
        return true;
      },
      on() {},
      off() {},
    } as unknown as NodeJS.WriteStream;
    const terminal = new NodeTerminal(input, output);

    terminal.enter();
    assert.ok(written.includes(MOUSE_ON));
    terminal.exit();
    assert.ok(written.includes(MOUSE_OFF));
  });

  test('SGR の報告をホイールとして読む', () => {
    assert.deepEqual(decodeKeys('\x1b[<64;10;5M').map((k) => k.name), ['wheelup']);
    assert.deepEqual(decodeKeys('\x1b[<65;10;5M').map((k) => k.name), ['wheeldown']);
  });

  test('桁が 3 桁でも読める', () => {
    // SGR 形式にしたのは、桁が 223 を超えても壊れないため
    assert.deepEqual(decodeKeys('\x1b[<64;180;42M').map((k) => k.name), ['wheelup']);
  });

  test('左ドラッグは0始まりの座標付きで読む。右クリック・不正座標は捨てる', () => {
    const down = one('\x1b[<0;10;5M');
    assert.equal(down.name, 'mousedown');
    assert.equal(down.x, 9);
    assert.equal(down.y, 4);
    assert.equal(one('\x1b[<32;20;6M').name, 'mousedrag');
    assert.equal(one('\x1b[<0;20;6m').name, 'mouseup');
    assert.equal(one('\x1b[<4;10;5M').shift, true);
    assert.equal(one('\x1b[<68;10;5M').name, 'wheelup');
    assert.deepEqual(decodeKeys('\x1b[<2;10;5M'), []);
    assert.deepEqual(decodeKeys('\x1b[<35;10;5M'), []);
    assert.deepEqual(decodeKeys('\x1b[<0;0;5M'), []);
    assert.deepEqual(decodeKeys('\x1b[<0;10M'), []);
    assert.ok(MOUSE_ON.includes('\x1b[?1002h'));
    assert.ok(!MOUSE_ON.includes('\x1b[?1003h'));
  });

  test('従来のキーは変わらない', () => {
    // '<' を読むようにしたので、他の並びを壊していないか
    assert.deepEqual(decodeKeys('\x1b[A').map((k) => k.name), ['up']);
    assert.deepEqual(decodeKeys('\x1b[5~').map((k) => k.name), ['pageup']);
    assert.deepEqual(decodeKeys('\x1b[27;6;117~').map((k) => k.ch), ['u']);
    assert.deepEqual(decodeKeys('あ').map((k) => k.ch), ['あ']);
  });

  test('ホイールと文字が続けて届いても分かれる', () => {
    const keys = decodeKeys('\x1b[<65;1;1Mあ');
    assert.deepEqual(keys.map((k) => k.name), ['wheeldown', 'char']);
    assert.equal(keys[1]!.ch, 'あ');
  });
});
