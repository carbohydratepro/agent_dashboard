/**
 * スラッシュコマンドの補完。
 *
 * 候補は推測せず、CLI の `system/init` が返す実際の一覧を使う
 * （使用量の取得と同じ 1 回の起動で一緒に取れる）。
 * 一覧が取れていないときは何も出さない。存在しないコマンドを勧めない。
 */

export interface CompletionState {
  /** 入力中のコマンド名（`/` を除く） */
  query: string;
  candidates: string[];
  index: number;
}

/** 端末でしか動かないコマンド。この画面から送っても効かない。 */
export interface CompletionSource {
  commands: readonly string[];
  terminalOnly?: readonly string[];
}

/**
 * 入力の先頭がスラッシュコマンドなら、その名前を返す。
 *
 * 補完を出すのは「1 行目が / で始まり、まだ引数を打っていない」ときだけ。
 * 文中の / や、引数を打ち始めたあとには割り込まない。
 */
export function commandPrefix(value: string, cursor: number): string | null {
  const upToCursor = value.slice(0, cursor);
  // 複数行の 2 行目以降は対象外
  if (upToCursor.includes('\n')) return null;
  if (!upToCursor.startsWith('/')) return null;

  const name = upToCursor.slice(1);
  // 空白が入ったら引数を書き始めている
  if (/\s/.test(name)) return null;
  return name;
}

/** 前方一致を優先し、次に部分一致。どちらも名前順。 */
export function matchCommands(query: string, source: CompletionSource): string[] {
  const q = query.toLowerCase();
  const usable = source.commands.filter((c) => !(source.terminalOnly ?? []).includes(c));

  const starts: string[] = [];
  const contains: string[] = [];
  for (const command of usable) {
    const lower = command.toLowerCase();
    if (lower.startsWith(q)) starts.push(command);
    else if (q !== '' && lower.includes(q)) contains.push(command);
  }
  starts.sort();
  contains.sort();
  return [...starts, ...contains];
}

/** 入力とコマンド一覧から補完の状態を作る。出すものが無ければ null。 */
export function completionFor(
  value: string,
  cursor: number,
  source: CompletionSource,
): CompletionState | null {
  const query = commandPrefix(value, cursor);
  if (query === null) return null;

  const candidates = matchCommands(query, source);
  if (candidates.length === 0) return null;
  // 打ち切った状態と候補が完全に一致していれば、もう出す意味がない
  if (candidates.length === 1 && candidates[0] === query) return null;

  return { query, candidates, index: 0 };
}

/** 選択中の候補で入力を置き換える */
export function applyCompletion(state: CompletionState): string {
  const chosen = state.candidates[state.index % state.candidates.length];
  return chosen ? `/${chosen} ` : '';
}

export function moveSelection(state: CompletionState, delta: number): CompletionState {
  const n = state.candidates.length;
  return { ...state, index: ((state.index + delta) % n + n) % n };
}
