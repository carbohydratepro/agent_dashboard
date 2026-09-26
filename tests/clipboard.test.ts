import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyText, runClipboardCommand, windowsClipboardCommand } from '../src/tui/clipboard.ts';

test('WSLはclip.exeへUTF-16LEで渡し、OSC52を送らない', async () => {
  const writes: string[] = [];
  const commands: string[] = [];
  await copyText('日本語\nhello😀', (data) => writes.push(data), { WSL_DISTRO_NAME: 'Ubuntu' }, 'linux', async (cmd) => {
    commands.push(cmd.file);
    assert.deepEqual(cmd.args, []);
    assert.equal(cmd.input.toString('utf16le'), '\ufeff日本語\r\nhello😀');
  });
  assert.deepEqual(commands, ['/mnt/c/Windows/System32/clip.exe']);
  assert.deepEqual(writes, []);
  assert.equal(windowsClipboardCommand('a\r\nb', 'win32').input.toString('utf16le'), '\ufeffa\r\nb');
});

test('WSLコピー失敗時もOSC52へフォールバックしない', async () => {
  const writes: string[] = [];
  await assert.rejects(copyText('test', (data) => writes.push(data), { WSL_INTEROP: 'test' }, 'linux', async () => {
    throw new Error('failed');
  }), /failed/);
  assert.deepEqual(writes, []);
});

test('その他の端末ではUTF-8をbase64化したOSC52書込みのみ行う', async () => {
  let output = '';
  await copyText('日本語', (data) => { output += data; }, {}, 'linux');
  assert.equal(output, `\x1b]52;c;${Buffer.from('日本語').toString('base64')}\x07`);
});

test('コピー子プロセスの成功・起動失敗・時間切れを処理する（実クリップボードは変更しない）', async () => {
  await runClipboardCommand({ file: process.execPath, args: ['-e', 'process.stdin.resume()'], input: Buffer.from('test') });
  await assert.rejects(runClipboardCommand({ file: '/nonexistent/clipboard-test', args: [], input: Buffer.from('test') }));
  await assert.rejects(runClipboardCommand({ file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], input: Buffer.alloc(0) }, 100), /タイムアウト/);
});
