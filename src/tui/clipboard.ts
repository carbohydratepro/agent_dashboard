import { spawn } from 'node:child_process';

export interface ClipboardCommand { file: string; args: string[]; input: Buffer }

export function windowsClipboardCommand(text: string, platform: string): ClipboardCommand {
  return {
    file: platform === 'win32' ? 'clip.exe' : '/mnt/c/Windows/System32/clip.exe',
    args: [],
    input: Buffer.from('\ufeff' + text.replace(/\r?\n/g, '\r\n'), 'utf16le'),
  };
}

/** 非同期かつ時間制限付き。ユーザーが選択を確定したときだけ起動する。 */
export function runClipboardCommand(command: ClipboardCommand, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('クリップボードへのコピーがタイムアウトしました'));
    }, timeoutMs);
    let settled = false;
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    }
    child.once('error', finish);
    child.stdin.on('error', (error: Error) => { child.kill(); finish(error); });
    child.once('close', (code) => finish(code === 0 ? undefined : new Error('クリップボードへのコピーに失敗しました')));
    child.stdin.end(command.input);
  });
}

export async function copyText(
  text: string, write: (data: string) => void,
  env: NodeJS.ProcessEnv = process.env, platform: string = process.platform,
  run: (command: ClipboardCommand) => Promise<void> = runClipboardCommand,
): Promise<void> {
  if (platform === 'win32' || env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
    // WTのOSC52経路にはハングの報告があるため、WSLではWindowsのclipを直接使用。
    // 失敗時もOSC52へフォールバックせず、F2の端末標準コピーを案内する。
    await run(windowsClipboardCommand(text, platform));
  } else {
    write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  }
}
