/** ヘルプ画面。キーバインドの一覧。 */

import type { PanelLine } from './panel.ts';
import type { Theme } from '../theme.ts';

interface Section {
  title: string;
  rows: Array<[string, string]>;
}

export const HELP_SECTIONS: Section[] = [
  {
    title: '一覧',
    rows: [
      ['↑ ↓ / k j', '行を選ぶ'],
      ['Tab / Shift+Tab', '次／前のセッション（実行中を優先）'],
      ['1 - 9', '番号で選ぶ'],
      ['Enter', '開く（承認待ちならその内容）'],
      ['Space', '詳細の展開／折りたたみ'],
      ['e', '次に送るプロンプトを書き足す'],
      ['p', '控えを選んで送る（↑↓ で選び Enter。控えは自動では送りません）'],
      ['n', 'セッションを追加'],
      ['X', 'アーカイブ'],
      ['c', 'コンテキストを整理させる'],
      ['R / Shift+R', '再接続（選択中 / すべて）'],
      ['Ctrl+C', '実行中のタスクを中断'],
      ['L / a / s', 'ログ / セッション履歴 / 統計'],
      [', / ?', '設定 / ヘルプ'],
      ['q', '終了'],
      ['Ctrl+L', '画面を再描画'],
    ],
  },
  {
    title: '会話',
    rows: [
      ['文字入力', 'プロンプトを書く'],
      ['Enter', '送信（空のときは何もしません）'],
      ['Ctrl+J', '改行（Alt+Enter / Shift+Enter でも入ります）'],
      ['↑ ↓', '入力欄が空のとき、送信済みプロンプトを遡る'],
      ['Ctrl+U / Ctrl+D', '過去の会話を 2 行ずつ遡る（前回までの履歴も入っています）'],
      ['Ctrl+Shift+U / D', '5 行ずつ。端末が Shift を報告しない場合は Alt+u / Alt+d'],
      ['Tab', 'サブエージェントの行を展開／折りたたみ'],
      ['/', 'スラッシュコマンドの候補を出す'],
      ['Alt+e', '次に送るプロンプトを書き足す'],
      ['Alt+p', '控えを選んで送る'],
      ['Ctrl+C', '中断（入力中なら入力をクリア）'],
      ['Esc', '一覧へ戻る'],
    ],
  },
  {
    title: 'スラッシュコマンド',
    rows: [
      ['/', '打ち始めると候補が出る（claude のみ）'],
      ['Tab / ↑↓', '候補を選ぶ'],
      ['Enter', '決定。もう一度 Enter で送信'],
      ['Esc', '候補を閉じる（会話からは出ない）'],
      ['—', '候補は CLI が返した実際の一覧です'],
      ['—', '端末でしか動かないコマンドは出ません'],
      ['—', 'codex は解釈しないので、送る前に知らせます'],
    ],
  },
  {
    title: '承認待ち',
    rows: [
      ['y', '許可して再実行'],
      ['n', '却下（理由を書ける）'],
      ['a', '以後このツールを常に許可'],
      ['j / k', '複数件を切り替える'],
      ['Esc', 'あとで判断する'],
    ],
  },
  {
    title: '既存セッションの取り込み',
    rows: [
      ['n → 追加方法', '「既存を取り込む」に切り替えて Enter'],
      ['↑ ↓ / j k', '取り込む会話を選ぶ'],
      ['Enter', '取り込む。やり取りと集計を引き継ぐ'],
      ['—', '端末で直接始めた claude / codex の会話も選べます'],
      ['—', '作業ディレクトリは会話が始まった場所を引き継ぎます'],
      ['—', '一覧中のセッションが使っている会話は出ません'],
    ],
  },
  {
    title: 'セッション履歴',
    rows: [
      ['a → ↑↓ → r', 'アーカイブしたセッションを一覧に戻す'],
      ['—', '集計・下書き・会話への紐はそのまま残ります'],
    ],
  },
  {
    title: '日本語入力',
    rows: [
      ['—', 'IME の確定文字列はそのまま文字として入ります'],
      ['—', '入力欄では文字がショートカットになりません'],
      ['—', '右端を越えると入力欄が横に流れます（‹ が出ます）'],
    ],
  },
  {
    title: 'ダイアログ共通',
    rows: [
      ['↑ ↓ / j k', '項目を移動'],
      ['← → / h l', '値を変える'],
      ['Enter / Esc', '決定 / キャンセル'],
    ],
  },
];

export function helpLines(theme: Theme): PanelLine[] {
  const lines: PanelLine[] = [];
  for (const section of HELP_SECTIONS) {
    if (lines.length > 0) lines.push({ text: '' });
    lines.push({ text: section.title, color: theme.accent, bold: true });
    for (const [keys, label] of section.rows) {
      lines.push({ text: `${keys.padEnd(18)} ${label}`, color: theme.text, indent: 1 });
    }
  }
  return lines;
}
