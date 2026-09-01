# AGENT DASHBOARD — 仕様書 v0.5

`claude` / `codex` のセッションを一覧・監視・操作するターミナルのダッシュボード。
どのセッションが何をしていて、資源をどれだけ使っているかを 1 画面で見せ、
そのまま指示を出せるようにする。

- 最終更新: 2026-08-30
- ステータス: 全機能が実装済み。実 CLI に対するライブテストを含め、全テストが green
- 変更履歴:
  - v0.5 — ゲーム/会社の見立てを撤廃してダッシュボードに作り替え（`docs/RENAME.md`）。
    レベル・給料・演出台詞・人物のドット絵を削除。機能は据え置き
  - v0.4 — フェーズ 0 の実測を反映。承認は後追い方式に（§8.4）、サブエージェントを実イベントに合わせて拡充（§11）、コンテキスト算出を確定（§17.1）
  - v0.3 — ネットワーク変更の検知と自動復帰（§10）、通知、CLI 既定踏襲の方針
  - v0.2 — 会話継続モデルの明文化、次に送るプロンプト、ディレクトリ衝突回避

---

## 1. 方針

**演出を持たない。** 画面に出る数字はすべて実測値で、その根拠が説明できる。
分からないものは推測で埋めず、分からないと書く。

**CLI 側の機能と既定値を踏襲する。** モデル・権限モード・サンドボックスは
CLI のデフォルトに任せ、設定で明示されたときだけ引数を足す。

> v0.5 で、初期にあった会社ごっこの見立て（社員・採用・稟議・給料・レベル）を
> すべて外した。機能は落としていない。対応は `docs/RENAME.md` にある。

---

## 2. スコープ

### やる（v1）
- ターミナル TUI での俯瞰一覧画面（表）
- カーソルキー／vim キーでの完全なキーボード操作
- `codex` / `claude` の実プロセス起動と実行
- マルチターンの会話継続（§6、フェーズ 0 で実証済み）
- セッションの新規作成・一覧・再開・アーカイブ
- セッション単位の識別（名前・見た目・口調・役職・得意分野）
- コンテキスト残量 / 稼働時間 / 状態 / 実績スタッツの可視化
- 会話モード（1 セッションと対話）
- **承認フロー**（権限拒否された操作の後追い承認、§8.4）
- 作業ディレクトリ衝突の自動回避（§9）
- ネットワーク変更の検知と会話の自動復帰（§10）
- サブエージェント検出と親／サブエージェントの演出（§11、**claude セッションのみ**）
- セッションごとの「次に送るプロンプト」（§12）
- 使用量と期間集計の表示（§13）
- 再起動後の状態復帰（§14）
- タスク完了時の端末ベル通知（§15.7）

### やらない（v1）
- Web UI（v2。core を UI 非依存に切ることで後付け可能にする — §3）
- **リアルタイムの権限承認**。`-p` モードでは技術的に不可能（§8.4）
- ~~**スロット数の増減**。6 スロット固定~~ → 既定 8。`config.json` の `ui.slotCount` で変更可（v0.6）
- タスクキュー／自動アサイン
- **モデル選択 UI**。CLI 側のデフォルトに従う
- マルチプレイヤー、ネットワーク同期
- BGM / 効果音（v2 候補）
- セッション同士の自動連携
- マップ上をユーザーキャラが歩く自由移動（v2）

---

## 3. アーキテクチャ

```
                 ┌────────────────────────────┐
                 │      core (UI 非依存)       │
                 │  ・SessionManager           │
                 │  ・AgentDriver 抽象          │
                 │  ・WorkspaceManager          │
                 │  ・NetworkMonitor            │
                 │  ・RecoveryCoordinator       │
                 │  ・ApprovalManager           │
                 │  ・StateStore (EventEmitter) │
                 │  ・Persistence               │
                 └───────┬──────────────┬──────┘
                         │              │
              ┌──────────▼───┐   ┌──────▼─────────┐
              │  TUI (v1)     │   │  Web (v2)      │
              │  Ink / React  │   │  Canvas + WS   │
              └───────────────┘   └────────────────┘
                         │
              ┌──────────▼──────────────┐
              │  AgentDriver 実装        │
              │  ・ClaudeDriver          │
              │  ・CodexDriver           │
              │  ・MockDriver (テスト用)  │
              └──────────┬──────────────┘
                         │ child_process
              ┌──────────▼──────────────┐
              │  claude / codex CLI      │
              └──────────────────────────┘
```

**core は端末 API を一切触らない。** 状態変化はすべて `StateStore` のイベントとして外に出る。TUI はそれを購読して描画するだけ。

### 技術選定

| 層 | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript (Node.js 20+) | 対象 CLI と同じ土俵。child_process と ndjson 処理が素直 |
| TUI | **独自 ANSI ライタ**（ダブルバッファ＋差分フラッシュ） | 画面の主役が表グリッドで、React の差分計算が噛み合わない。依存ゼロを維持でき、全角幅の扱いも自前で正確にできる |
| 色 | chalk (256色 / truecolor) | 端末の色能力を検出してフォールバック |
| ネットワーク監視 | `os.networkInterfaces()` のポーリング | 追加依存なし（§10.2） |
| 永続化 | JSON ファイル（`~/.agent-dashboard/`） | 依存を増やさない |
| テスト | **`node --test`（内蔵）** | Node 26 が TypeScript をネイティブ実行できるため、vitest を入れずに済む。core は実行時依存ゼロ |

> **ツールチェーンの決定（フェーズ 1）**: Node 26 の型ストリッピングで `.ts` を直接実行し、テストは内蔵ランナーを使う。実行時依存はゼロ、開発依存は `typescript` と `@types/node` のみ。
> 型ストリッピングの制約に合わせ、`tsconfig.json` で `erasableSyntaxOnly` と `verbatimModuleSyntax` を有効にしている（enum・namespace・パラメータプロパティは使えない。型のインポートは必ず `import type`）。

### 検証済みバージョン

| CLI | バージョン | 検証日 |
|---|---|---|
| claude | 2.1.228 | 2026-08-12 |
| codex-cli | 0.147.0 | 2026-08-12 |

---

## 4. ドメインモデル

```ts
type AgentKind = 'claude' | 'codex';

type EmployeeState =
  | 'idle'          // 待機。指示待ち
  | 'thinking'      // モデル応答待ち
  | 'working'       // ツール実行中
  | 'delegating'    // サブエージェント稼働中（§11）
  | 'blocked'       // 承認待ち。権限拒否された操作がある（§8.4）
  | 'reconnecting'  // ネットワーク変更により復帰処理中（§10）
  | 'error'         // 直近のターンが失敗
  | 'resting'       // コンテキスト逼迫
  | 'offline';      // プロセス未起動（アプリ再起動直後）

interface Employee {
  id: string;
  agentSessionId: string|null;// CLI 側のセッション ID
  kind: AgentKind;
  seatIndex: number;          // 0..seatCount-1

  persona: {
    name: string; codename: string; title: string;
    specialty: Specialty; tone: Tone;
    sprite: SpriteId; palette: PaletteId;
  };

  state: EmployeeState;
  currentTask: Task | null;
  subordinates: Subordinate[];      // 稼働中のサブエージェント（§11）
  pendingApprovals: ApprovalRequest[]; // 承認中の案件（§8.4）

  workspace: {
    requestedCwd: string;
    actualCwd: string;
    isolation: 'none' | 'worktree';
    branch: string | null;
    sandbox: string | null;   // codex のみ。作成時に固定され変更不可（§5.2）
  };

  recovery: {
    attempts: number;
    lastError: string | null;
    interruptedTaskId: string | null;
    networkFingerprintAtStart: string | null;
  };

  nextMemo: string;
  nextMemoUpdatedAt: number;

  context: {
    usedTokens: number;
    windowTokens: number;
    ratio: number;
    estimated: boolean;       // codex は常に true（概算、§17.1）
    prevInputTokens: number;  // codex の差分計算用
  };
  uptime: { hiredAt: number; activeMs: number; lastActiveAt: number };
  stats: {
    tasksCompleted: number; tasksFailed: number; tasksInterrupted: number;
    filesEdited: number; commandsRun: number;
    subagentsSpawned: number; approvalsRequested: number; approvalsGranted: number;
    reconnects: number;
    totalTokensIn: number; totalTokensOut: number;
    exp: number; level: number;
  };

  archived: boolean;
}

/** 承認内容（§8.4）。claude の result.permission_denials[] から生成 */
interface ApprovalRequest {
  id: string;
  toolName: string;           // "Edit" / "Bash" / "Write" …
  toolUseId: string;
  toolInput: Record<string, unknown>; // 完全な引数。差分描画に使う
  message: string;            // CLI が返した拒否理由
  requestedAt: number;
  taskId: string;             // どのタスク中に発生したか
}

/** サブエージェント（§11）。claude の system/task_* から生成 */
interface Subordinate {
  taskId: string;             // system/task_started.task_id
  toolUseId: string;          // 親の Agent tool_use id
  subagentType: string;       // "Explore" / "Plan" / "general-purpose" …
  name: string;               // 自動生成（例 "CLD-02-a"）
  sprite: SpriteId;           // subagentType から決定
  description: string;        // 担当業務
  currentAction: string;      // task_progress.description
  lastToolName: string;       // task_progress.last_tool_name
  totalTokens: number;        // task_progress.usage.total_tokens
  toolUses: number;           // task_progress.usage.tool_uses
  durationMs: number;         // task_progress.usage.duration_ms
  startedAt: number;
  status: 'running' | 'completed' | 'failed';
  summary: string | null;     // task_notification.summary
  lastText: string;           // parent_tool_use_id 一致の発話
}

interface Task {
  id: string; employeeId: string; prompt: string;
  startedAt: number; endedAt: number | null;
  status: 'running' | 'done' | 'failed'
        | 'cancelled'         // ユーザーが Ctrl+C で止めた
        | 'interrupted'       // ネットワーク等で外的に切れた（§10）
        | 'blocked';          // 権限拒否で完遂できなかった（§8.4）
  events: AgentEvent[];
  summary: string | null;
  recoveredFrom: string|null;
}

// ドライバが正規化して吐く共通イベント
type AgentEvent =
  | { t: 'session_started'; sessionId: string; model: string }
  | { t: 'requesting' }                                    // API 待ち
  | { t: 'thinking'; estimatedTokens: number }             // claude: thinking_tokens
  | { t: 'text'; delta: string; parentToolUseId?: string }
  | { t: 'tool_start'; name: string; detail: string; toolUseId: string }
  | { t: 'tool_end'; name: string; ok: boolean; toolUseId: string }
  | { t: 'subagent_start'; taskId: string; toolUseId: string;
      subagentType: string; description: string }
  | { t: 'subagent_progress'; taskId: string; description: string;
      lastToolName: string; totalTokens: number; toolUses: number; durationMs: number }
  | { t: 'subagent_end'; taskId: string; ok: boolean; summary: string }
  | { t: 'file_edited'; path: string; kind: 'add'|'update'|'delete' }
  | { t: 'command_run'; cmd: string; exitCode: number|null }
  | { t: 'permission_denied'; toolName: string; toolUseId: string;
      toolInput: Record<string,unknown>; message: string }
  | { t: 'usage'; contextTokens: number; estimated: boolean;
      inputTokens: number; outputTokens: number }
  | { t: 'rate_limit'; status: string; resetsAt: number;
      rateLimitType: string; isUsingOverage: boolean }
  | { t: 'turn_end'; ok: boolean; result: string }
  | { t: 'error'; message: string };

type SystemEvent =
  | { t: 'network_changed'; from: string; to: string }
  | { t: 'network_lost' } | { t: 'network_restored' }
  | { t: 'recovery_started'; employeeIds: string[] }
  | { t: 'recovery_progress'; employeeId: string; attempt: number }
  | { t: 'recovery_finished'; ok: string[]; failed: string[] };
```

### 4.1 識別パラメータ

**得意分野 (Specialty)** — 作成時に選択、またはランダム。システムプロンプト追記にも反映する。

| ID | 表示 | 追記の方向性 |
|---|---|---|
| `backend` | バックエンド屋 | API・DB・パフォーマンス重視 |
| `frontend` | フロント屋 | UI/UX・アクセシビリティ重視 |
| `infra` | インフラ屋 | CI/CD・設定・運用重視 |
| `research` | 調査屋 | 読解と要約優先、編集は慎重に |
| `qa` | 品質管理 | テスト作成とエッジケース列挙優先 |
| `generalist` | 何でも屋 | 追記なし |

**口調 (Tone)** — 表示テキストの装飾のみ。AI 本体の応答内容は改変しない。

| ID | タスク受領時 | 復帰時（§10） | 承認時（§8.4） |
|---|---|---|---|
| `polite` | 「承知しました、ユーザー。」 | 「回線が切れていました。失礼しました。」 | 「恐れ入りますが、ご承認をいただけますか。」 |
| `energetic` | 「まかせてください！」 | 「つながりました！続けます！」 | 「ユーザー、ハンコください！」 |
| `laconic` | 「…了解。」 | 「…復帰。」 | 「…承認を。」 |
| `veteran` | 「ふむ、そういうことなら。」 | 「回線か。よくあることだ。」 | 「これは通しておいてくれ。」 |

> **重要**: AI の実出力を口調変換で書き換えることはしない。演出テキストと実出力は画面上でも視覚的に区別する（§15.3）。

**識別名** — `claude-1` のように種別 + 連番。使用中の名前を避けて採番する。

---

## 5. AgentDriver — CLI 連携仕様

```ts
interface AgentDriver {
  kind: AgentKind;
  start(opts: StartOpts): AsyncIterable<AgentEvent>;
  resume(sessionId: string, prompt: string, opts: TurnOpts): AsyncIterable<AgentEvent>;
  cancel(reason: 'user' | 'network'): Promise<void>;
}
```

### 5.0 両ドライバ共通の実行条件（フェーズ 0 で判明）

1. **stdin を閉じる。** `claude -p` は stdin を 3 秒待つ。`stdio: ['ignore','pipe','pipe']` で spawn する
2. **親の環境変数を落とす。** `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_SSE_PORT` を削除して渡す
3. **引数は最小限。** モデル・権限モード・サンドボックスは設定で明示されたときだけ渡す（§1）

### 5.1 ClaudeDriver

```bash
# 1 ターン目（セッション ID をこちらで採番）
claude -p "<prompt>" \
  --session-id <uuid> \
  --output-format stream-json \
  --include-partial-messages \
  --forward-subagent-text \
  --verbose

# 2 ターン目以降
claude -p "<prompt>" --resume <session-id> \
  --output-format stream-json --include-partial-messages \
  --forward-subagent-text --verbose

# 承認承認後の再実行（§8.4）★実機で動作確認済み★
claude -p "承認しました。先ほどの編集をそのまま実行してください。" --resume <session-id> \
  --allowedTools "<承認されたツール名>" \
  --output-format stream-json --verbose
```

> **承認の再実行は実測で確認済み。** `--permission-mode manual` のまま `--allowedTools "Edit"` を付けて `--resume` したところ、拒否されていた `Edit` が実行され、`permission_denials` は空、ファイルも実際に変更された。`--allowedTools` は権限モードより優先される。エージェントは会話の文脈から「先ほどの編集」の内容を復元するので、こちらで `tool_input` を渡し直す必要はない。

- `--session-id <uuid>`: こちらで UUID を採番して渡せる。`system/init.session_id` にそのまま返る（実測確認済み）
- `--output-format stream-json` + `--verbose`: JSONL イベント
- `--include-partial-messages`: `stream_event` として部分メッセージが流れる。タイピングアニメ用。**量が多いので早期に捨てる分岐を入れる**
- `--forward-subagent-text`: サブエージェントの発話が `parent_tool_use_id` 付きで届く（§11）
- `--permission-mode`: **既定では渡さない。** 実測では未指定時 `auto` だった（ユーザー設定に従う）
- `--allowedTools`: 承認承認時のみ使う（§8.4）

**イベントマッピング**（詳細は `docs/phase0/FINDINGS.md` §2.1）:

| claude のイベント | `AgentEvent` |
|---|---|
| `system/init` | `session_started` |
| `system/status` (`requesting`) | `requesting` |
| `system/thinking_tokens` | `thinking` |
| `system/permission_denied` | `permission_denied`（引数は `result.permission_denials[]` から補完） |
| `system/task_started` | `subagent_start` |
| `system/task_progress` | `subagent_progress` |
| `system/task_updated` / `task_notification` | `subagent_end` |
| `assistant`（`text`） | `text` |
| `assistant`（`tool_use`） | `tool_start` |
| `user`（`tool_result`） | `tool_end` |
| `rate_limit_event` | `rate_limit` |
| `result` | `turn_end` + `usage` |

### 5.2 CodexDriver

```bash
# 1 ターン目（サンドボックスはここでしか指定できない）
codex exec "<prompt>" --json [--sandbox <mode>] [-m <model>]

# 2 ターン目以降 ★オプションは位置引数より前★
codex exec resume --json <session-id> "<prompt>"
```

**フェーズ 0 で判明した制約**:

- **`resume` では `--sandbox` を受け付けない。** 初回セッションの設定を継承する。つまり**サンドボックス設定は作成時に決まり、そのセッションの生涯にわたり固定**。UI でもそう説明する
- **オプションは位置引数より前に置く。** `codex exec resume <id> "<prompt>" --json` は `error: unexpected argument` になる
- セッション ID は事前指定できない。`thread.started.thread_id` から拾う
- **サブエージェント機能は無い**（§11.4）

**イベントマッピング**（詳細は `FINDINGS.md` §2.2）:

| codex のイベント | `AgentEvent` |
|---|---|
| `thread.started` | `session_started`（`thread_id` がセッション ID） |
| `item.started` / `item.completed`（`command_execution`） | `tool_start` / `tool_end` + `command_run` |
| `item.completed`（`file_change`） | `file_edited`（`changes[].path`, `changes[].kind`） |
| `item.completed`（`agent_message`） | `text` |
| `turn.completed` | `turn_end` + `usage`（概算、§17.1） |

> codex はファイル読み取りにも `command_execution`（`sed -n '1,240p' …`）を使う。`Read` 相当のツールは無い。編集だけが `file_change` として明示的に出る。

### 5.3 パース戦略

1. 既知のイベント種別のみ解釈し、未知の種別は無視する（クラッシュさせない）
2. 生の JSONL 行は常に `raw.jsonl` にそのまま追記
3. パース不能な行が 20% を超えたら `error` 状態にしてスキーマ警告バナー
4. 起動時に `claude --version` / `codex --version` を記録し、**§3 の検証済みバージョン**と差があれば警告

---

## 6. 会話継続モデル

**マルチターンの会話は完全に成立する。フェーズ 0 で実証済み。**

両 CLI に「ファイルを読み直さずに、さっきの内容を答えて」を投げたところ、**どちらもツールを一切使わず前ターンの文脈だけから正答した**。

| CLI | セッション ID | ツール使用 | 応答 |
|---|---|---|---|
| claude | `1111…1111`（維持） | なし | 「ファイル名: `calc.js` / 関数名: `add`」 |
| codex | `019ff6a3…`（維持） | なし | 「sub」 |

「1 ターン = 1 プロセス」はプロセスのライフサイクルの話であって、会話のライフサイクルではない。会話は CLI 側のセッションストアに永続する。

**代償はプロセス起動コストのみ**（1 ターンあたり 1〜2 秒）。

**副次的な利点**: プロセスが短命なので、ネットワーク変更の影響を受ける窓が「ターン実行中」だけに限定される（§10）。

**v2 の最適化**: claude は `--input-format stream-json` でプロセスを常駐させられる。ただし §8.4 の承認方式を採ったことで、v1 で前倒しする必要は無くなった。

---

## 7. 状態遷移

```
                    ┌─────────┐
      作成 ────────>│ offline │<──────── アプリ再起動
                    └────┬────┘
                         │ 指示送信
                         ▼
                    ┌──────────┐
             ┌─────>│ thinking │────────────────┐
             │      └────┬─────┘                │
             │           │ tool_start           │ turn_end(ok)
             │           ▼                      │
             │      ┌─────────┐  subagent_start │
             │      │ working │─────┐           │
             │      └────┬────┘     ▼           │
             │           │    ┌────────────┐    │
             │           │    │ delegating │    │
             │           │    └─────┬──────┘    │
             │           │          │           │
             │           └────┬─────┘           │
             │                │                 ▼
             │  permission_denied           ┌────────┐
             │                │             │  idle  │
             │                ▼             └────────┘
             │          ┌─────────┐            ▲  ▲
             └──────────│ blocked │────────────┘  │
              y:承認して再実行 └─────────┘  n:却下      │
                                                   │ 復帰成功
   context.ratio >= 0.85                     ┌────────────┐
        ┌──────────────────────────────────  │reconnecting│
        ▼                                    └─────┬──────┘
   ┌─────────┐                                     │ 3回失敗
   │ resting │──── compact / 引継ぎ ──> idle       │
   └─────────┘                                     │
                    turn_end(!ok)      ┌────────┐  │
                    パースエラー ─────>│ error  │<─┘
                                       └────┬───┘
                                            │ 再指示
                                            └──> thinking
```

> `idle` と `offline` は「指示待ち」という意味では同じで、プロセスが生きているかどうかだけが違う。ターン完了後は常に `idle`。`offline` はアプリ再起動直後の未接続状態にのみ使う。

---

## 8. セッション管理

### 8.1 新規作成
1. `n` キー → 作成ダイアログ
2. 選択項目: **AI種別**（claude / codex）、**得意分野**、**作業ディレクトリ**、（codex のみ）**サンドボックス**
   - モデルは選ばせない。CLI のデフォルトに従う（§1）
   - **codex のサンドボックスは後から変更できない**ので、ここで確定する旨を注記する（§5.2）
3. 名前・見た目・口調は自動生成（`r` で振り直し、`e` で手入力）
4. 作業ディレクトリの衝突判定（§9）
5. 空スロットに着スロットアニメ → `idle` で待機
6. 最初の指示を送った時点で実プロセスを起動し、セッション ID が確定

**空スロットが無い場合**: 既定 8（`ui.slotCount`）。「スロットが空いていません」を提示し、セッション履歴（`p`）へ誘導する。

### 8.1.1 既存セッションの取り込み（一覧の外で始まった会話の引き継ぎ）

端末で直接 `claude` / `codex` を動かして始めた会話も、セッションとして迎え入れられる。

| | 保存先 | 取れる情報 |
|---|---|---|
| claude | `~/.claude/projects/<cwd をエンコード>/<セッションID>.jsonl` | ファイル名がセッション ID。レコードの `cwd`、`ai-title` に生成タイトル |
| codex | `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` | 先頭の `session_meta` に `session_id` と `cwd`、`event_msg/user_message` に発話 |

- 一覧は更新の新しい順。各ファイルは**先頭 128KB だけ**読む（会話ログは大きい）
- 注入された指示文（`# AGENTS.md instructions` や `<system-reminder>` で始まるもの）は
  見出しにしない
- **作業ディレクトリは会話が始まった場所を引き継ぐ**。claude のセッションは
  プロジェクト単位で保存されているため、別の場所から `--resume` すると見つからない
- すでに雇っている会話は一覧から除く
- 実 CLI で検証済み: 一覧の外で始めた会話を引き継ぎ、ファイルを読み直さずに
  前の内容を答えられた

**引き継ぐもの**

| | 内容 |
|---|---|
| 会話 | ログから履歴を復元し、会話画面に流し込む。直近 400 項目まで。省略したら冒頭にその旨を出す |
| 実績 | 指示の回数 / 編集ファイル数 / コマンド実行数をログから数える |

| 作業ディレクトリ | 会話が始まった場所 |

- **数字はログの実数**。水増ししない
- 前職の実績は今月の成果に数えない（会計の基準を作成時に取り直す）
- サブエージェント（サブエージェント）の発話、AI の思考ブロック、ツールの実行結果は履歴に入れない
- 引数の改行は 1 行に潰す（ヒアドキュメントがそのまま来て行が崩れるため）
- 一覧では**選択中の会話だけ**中身を読む（全件読むと遅い）。読んだものは覚えておく
- 一覧から外すのは**在籍中**のセッションが握っているものだけ。アーカイブ者まで外すと、一度雇った
  会話に二度と手が出せなくなる。アーカイブ者が担当していた会話には「← 元 〇〇」を出す

### 8.2 既存セッションの再開
- 起動時に `employees/*.json` を読み込み、`archived: false` をスロットに戻す（`offline`）
- 指示を送ると `resume` でプロセス起動
- **CLI 側にセッションが残っていない場合**: `error` にし、「記憶を失っています。新規セッションとして再開しますか？」を提示。承諾したら新セッション ID を切り、**スタッツ・人格・下書きは引き継ぐ**

### 8.3 会話の終了とアーカイブ — 3 段階

| 操作 | キー | 何が起きるか | 会話は残るか |
|---|---|---|---|
| **会話画面を閉じる** | `Esc` | 俯瞰図に戻るだけ。セッションは在籍 | 残る |
| **実行中タスクの中断** | `Ctrl+C` | SIGINT。ターンを `cancelled` に | 残る（§22-1） |
| **アーカイブ** | `X`（確認あり） | `archived: true`。スロットが空く。worktree の後始末（§9.3） | データは残る。復元可 |

### 8.4 承認フロー（権限承認）

**リアルタイムの承認プロンプトは `-p` モードでは実装できない。** フェーズ 0 の実測により確定した事実:

- 権限が必要なツールは**プロンプトを出さず即座に拒否**される
- ターンは `result/success` として**正常に終了**する（エラーではない）
- ただし `result.permission_denials[]` に**拒否された操作の完全な引数**が残る

これを利用した後追い承認 = **承認**を実装する。ユーザーというロールには、モーダルダイアログより承認内容のほうが合っている。

```
セッションがツールを使おうとする
  → CLI が拒否（ターンは正常終了、ファイルは変更されない）
  → permission_denials を ApprovalRequest に変換
  → セッションは blocked 状態、スロットに 🖋 バッジ、端末ベル
  → 詳細パネルに承認内容を表示
  → ユーザーが判断
      y → 承認。--resume + --allowedTools <tool> で再実行
      n → 却下。理由を入力させ、次の指示として送る
      a → このセッションの以降の同種ツールを常に許可（設定に保存）
```

**承認内容の表示** — `toolInput` が完全に残るので、何をしようとしたかを正確に描画できる。`Edit` なら `old_string`/`new_string` から差分を作れる。

```
┌─ 🖋 承認内容 ── CDX-01 リク より ────────────────────────┐
│ 種別: Edit                                              │
│ 対象: src/auth/session.ts                               │
│                                                         │
│   - export function add(a, b) {                         │
│   -   return a + b;                                     │
│   - }                                                   │
│   + export function add(a, b) {                         │
│   +   return a + b;                                     │
│   + }                                                   │
│   + export function sub(a, b) {                         │
│   +   return a - b;                                     │
│   + }                                                   │
│                                                         │
│ 理由: 書き込み権限が付与されていません                    │
│                                                         │
│ [y] 承認  [n] 却下  [a] 今後このツールは常に承認         │
└─────────────────────────────────────────────────────────┘
```

- 1 ターンで複数の拒否が発生しうる。`pendingApprovals[]` は配列で持ち、`j`/`k` で送る
- 承認は 1 ターン余分にかかる。ただし既定では権限モードを渡さない（ユーザー設定に従う）ため、`acceptEdits` / `auto` を使っていれば承認はほとんど発生しない。**例外パスとして実装する**
- `stats.approvalsRequested` / `approvalsGranted` を記録。承認の多いセッションは「慎重派」としてセッション履歴に現れる

---

## 9. 作業ディレクトリの衝突回避

### 9.1 判定と分岐

```
作成時に requestedCwd を受け取る
  ↓
そのディレクトリを他の在籍セッションが使っているか？
  ├─ No  → isolation: 'none'、actualCwd = requestedCwd
  └─ Yes → git リポジトリか？
            ├─ Yes → git worktree で自動隔離（§9.2）
            └─ No  → ダイアログ:
                      [1] 別のディレクトリを選ぶ
                      [2] 読み取り専用で配置
                      [3] 承知の上で同居する（スロットに警告を常時表示）
```

### 9.2 git worktree による隔離

```bash
git -C <requestedCwd> worktree add \
  ~/.agent-dashboard/worktrees/<employee-id> -b vo/<codename>
```

- `actualCwd` = `~/.agent-dashboard/worktrees/<employee-id>`、`branch` = `vo/<codename>`
- 両ドライバに同じ手が使える（`claude -w` に頼らず自前で切る）
- スロットに `⑂ vo/CDX-01` バッジ

### 9.3 後始末

アーカイブ時、worktree に**未コミットの変更があるかを必ず確認する**。

- 変更なし → `git worktree remove`
- 変更あり → 削除しない。「未コミットの変更が N 件あります」と表示し、①残す ②破棄して削除 を選ばせる。既定は「残す」

### 9.4 実行時ロック

`actualCwd` ごとにロックファイル（`locks/<hash>.lock`、PID 入り）。2 プロセス目は待機列へ。古い PID のロックは起動時に掃除。**§10.4 の復帰順序制御にも使う。**

---

## 10. ネットワーク変更への追従

### 10.1 影響を受ける範囲は狭い

1 ターン = 1 プロセス方式のおかげで、**待機中のセッションはネットワークが変わっても影響を受けない**。

| 状況 | 影響 | 対処 |
|---|---|---|
| 全員 `idle` のときに切替 | **なし** | ログに記録するだけ |
| 誰かがターン実行中に切替 | そのプロセスが固まる | §10.3 の復帰フロー |
| 起動中ずっとオフライン | 起動しても即失敗 | `error`、復旧後に §10.3 |

### 10.2 検知方法（NetworkMonitor）

外部通信を伴わない、インターフェース状態のポーリング。

```ts
fingerprint = sha1(
  os.networkInterfaces()
    .filter(i => !i.internal)
    .map(i => `${name}:${i.family}:${i.address}:${i.mac}`)
    .sort().join('|')
)
```

- **デバウンス**: フィンガープリントが **3 秒間安定**してから判定
- **オフライン判定**: 非 internal のインターフェースが 0 件 → `network_lost`
- **スリープ復帰の検知**: 前回ポーリングから 60 秒以上経っていたらスリープとみなし無条件に再検証
- **到達性プローブ**: 既定では**行わない**。設定に URL を書いたときだけ
- **手動トリガ**: `R` キー

### 10.3 復帰フロー

```
network_changed 検知（3秒安定後）
  ↓
稼働中のセッション（thinking/working/delegating）を列挙
  ├─ 0 名 → ログのみ
  └─ 1 名以上
      ↓
   state → 'reconnecting'、現タスクを 'interrupted' に
   SIGTERM →（5 秒待って残っていれば）SIGKILL
      ↓
   ネットワーク安定を待つ（最大 60 秒。超えたら error）
      ↓
   actualCwd ごとにグループ化し、グループ内は直列に復帰（§10.4）
      ↓
   --resume に「復帰プロンプト」を送る（§10.5）
      ↓
   成功 → idle。stats.reconnects++
   失敗 → 指数バックオフ（2s/8s/32s）で最大 3 回 → error
```

### 10.4 同一ディレクトリでの並行復帰

- 通常は §9 の worktree 隔離により `actualCwd` がセッションごとに別 → **全員を並行に復帰**
- 同居している場合は、`actualCwd` を共有するグループ内で**直列に**復帰（§9.4 のロックを使う）
- 復帰待ちのセッションはスロットに `⏳ 復帰待ち (2/3)` と表示
- **セッションごとに独立して成否が決まる**。1 人失敗しても他は続行

### 10.5 復帰プロンプト — 元の指示を再送しない

元プロンプトをそのまま再送すると**既に完了した作業を二重に実行する危険がある**。状態確認を挟む。

```
ネットワークの切り替えにより、直前の作業が途中で中断されました。
現在の状態を確認し、未完了の作業があれば続きから進めてください。
すでに完了している場合は、その旨だけ報告してください。

中断された指示: <元のプロンプト>
```

- 新しい `Task` が作られ、`recoveredFrom` に中断タスクの ID が入る
- 中断タスクは `interrupted` として履歴に残る。**`failed` とは区別する**

### 10.6 表示

```
│ ⚡ ネットワークが切り替わりました — 2 名を復帰中… (1/2)       │
│  ▓  ╔══════════════╗   ┌──────────┐                     ▓  │
│  ▓  ║   (@_@)⚡    ║   │  (·_·)⏳ │                     ▓  │
│  ▓  ║ RECONNECTING ║   │ 復帰待ち  │                     ▓  │
```

- 復帰完了後 5 秒でバナーは自動的に消える
- `autoRecover: false` にすると検知して通知するだけ（`R` で手動）

### 10.7 自動復帰を諦める条件

- 3 回リトライしても失敗 → `error`
- ネットワークが 60 秒以上復旧しない → `error`。復旧後 `R` で手動
- **セッション ID が未確定のまま中断された**（codex の 1 ターン目）→ 復帰不可。`idle` に戻し、元の指示を「次に送るプロンプト」に自動で書き込む

---

## 11. サブエージェント演出（親とサブエージェント）

**claude セッションのみの機能。** codex には該当機能が無い（フェーズ 0 で確認）。画面内では「claude セッションはサブエージェントを持てる」という差別化として扱う。

### 11.1 検出 — 専用イベントがある

`tool_use` から推測する必要はない。`system/task_*` を追えばよい。

| イベント | 用途 |
|---|---|
| `system/task_started` | サブエージェントの登場。`subagent_type`, `description`, `task_id` |
| `system/task_progress` | 進捗更新。`last_tool_name`, `usage.{total_tokens, tool_uses, duration_ms}` |
| `system/task_updated` | `patch.status` が `completed` に |
| `system/task_notification` | 成果報告。`summary`, `output_file` |
| `parent_tool_use_id` 付き `assistant` | サブエージェント自身の発話（`--forward-subagent-text` が必要） |

> 訂正: サブエージェント起動ツールの名前は **`Agent`**（`Task` ではない）。ただし上記の専用イベントを使うので、ツール名に依存する必要はない。

### 11.2 サブエージェントもセッションと同じ密度のステータスを持つ

実イベントから以下が全部取れる。仕様 v0.3 の想定（名前と発話だけ）より大幅に豊かになった。

| 表示項目 | 取得元 |
|---|---|
| 職種 | `subagent_type`（`Explore` / `Plan` / `general-purpose` …） |
| 担当業務 | `description` |
| 今やっていること | `task_progress.description` + `last_tool_name` |
| 消費トークン | `usage.total_tokens` |
| 作業時間 | `usage.duration_ms` |
| ツール実行回数 | `usage.tool_uses` |
| 発話 | `parent_tool_use_id` 一致の `assistant` |
| 成果報告 | `task_notification.summary` |

`subagent_type` ごとにスプライトを割り当てる（`Explore` = 虫めがねを持った調査員、`Plan` = 図面を広げた設計者、`general-purpose` = 汎用）。

### 11.3 表示

```
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
▓   ╔══════════════╗            ▓
▓   ║    (・∀・)    ║  ← 親     ▓
▓   ║  CLD-02      ║             ▓
▓   ║  DELEGATING  ║             ▓
▓   ╚══════════════╝             ▓
▓    (·-·)🔍   (·-·)📐           ▓
▓    Explore   Plan              ▓
▓    Bash 3回  読解中             ▓
▓    8.2k tok  4.1k tok          ▓
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

- サブエージェントの名前は親のコードネームから自動生成（`CLD-02-a`, `CLD-02-b`…）
- 親は `delegating` 状態、役職バッジが一時的に「主任 → 課長（代行）」に上がる
- サブエージェントは使い捨て。完了で退場し、永続化しない
- `stats.subagentsSpawned` にのみ累計を残す
- ネットワーク中断時はサブエージェントも一緒に消える

### 11.4 codex セッションの場合

`item.type` は `agent_message` / `command_execution` / `file_change` の 3 種のみで、サブエージェントに相当するものは無い。codex セッションは常に単独で作業する。**「一人でやりきるタイプ」としてセッション履歴に表示する。**

---

## 12. 次に送るプロンプト

### 12.1 仕様

- `Employee.nextMemo` に文字列を保持。**永続化される**
- `m` キーで編集（一覧画面でも会話モードでも）
- スロットと詳細パネルに `📝` と 1 行目を表示
- **タスク完了時**、下書きが空でなければ提示:

```
│ ✓ TASK #15 完了（04:12）                        │
│ 📝 次やること                                    │
│   「テスト書いたらドキュメントも更新して」        │
│   [Enter] このまま指示を出す                     │
│   [m] 編集してから出す   [d] 下書きを消す          │
```

- `Enter` で送信、下書きはクリア
- 自動送信は**既定オフ**（`autoSendNextMemo`）
- **§10.7 の復帰不可ケースでは、元の指示がここに自動で書き込まれる**

### 12.2 なぜキューではなく下書き 1 件か

キューにすると順番管理・編集・実行中表示の UI が要る。次の 1 手だけ持てれば運用は成立する。件数はスロット数（既定 8）が上限。

---

## 13. 集計と使用量

擬似的な指標は持たない。出すのは実測値だけ。

### 13.1 期間の集計

月初にスナップショットを取り、累計との差で今月ぶんを出す。

```
完了タスク数 / 失敗数 / 消費トークン / セッション数
```

- 月をまたいだら締めて履歴に残す。履歴は 36 か月で打ち切る
- **1 か月以上起動しなかった場合**: 起動時にまとめて締め、飛んだ月は「起動なし」として残す
- 取り込んだ会話の実績は今月に数えない（取り込み時に基準を取り直す）

### 13.2 セッションごとの指標

| 指標 | 出し方 |
|---|---|
| 稼働率 | 実際に動いていた時間 / 起動からの経過時間 |
| 1 タスクあたりのトークン | 総トークン / 完了タスク数 |
| 完了・失敗・中断 | それぞれの実回数 |

### 13.3 使用量（残量）

**両 CLI とも残量を取得できる**（`docs/phase0/FINDINGS.md` §7.0）。

| | 取得元 | 負荷 |
|---|---|---|
| claude | `claude -p "/usage"` の出力を解析 | モデル呼び出しなし・課金なし・約 0.4 秒 |
| codex | `~/.codex/sessions/**/rollout-*.jsonl` の `token_count.rate_limits` | ファイルを読むだけ |

- 起動時・5 分ごと・実行完了後に取り直す（最短 30 秒間隔）
- 取得前は「取得中…」、失敗したら理由を出す。**推測で数字を埋めない**
- CLI が入っていなければ「未導入」
- codex のロールアウトには `model_context_window` も入っており、
  コンテキストゲージの分母を実測値に置き換える

### 13.4 レート制限

`status` が `allowed` 以外になったら、実行中でないセッションを `resting` に倒し、
新しい実行をブロックする。送っても失敗するだけなので。

## 14. 永続化と状態復帰

### 14.1 二層

| 層 | 持ち主 | 中身 |
|---|---|---|
| **ダッシュボード層** | `~/.agent-dashboard/` | 識別名・集計・スロット・下書き・worktree・承認待ち |
| **会話層** | CLI 側のセッションストア | 会話履歴・ツール使用履歴・文脈そのもの |

`agentSessionId` 一本で紐づく。この ID があれば `--resume` で会話が復活する。

> codex のセッション実体は `~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` に置かれている（実測）。

### 14.2 ファイル構成

```
~/.agent-dashboard/
  config.json / office.json
  employees/<employee-id>.json
  sessions/<employee-id>/raw.jsonl, tasks.jsonl
  worktrees/<employee-id>/
  locks/<hash>.lock
  logs/app.log
```

- 書き込みは**アトミック**（tmp に書いて rename）
- 保存タイミング: 状態遷移時・ターン完了時・下書き編集時・承認発生/解決時・復帰処理の前後・終了時
- `raw.jsonl` は無加工で残す。50MB でローテーション
- **`stream_event` は量が多い。** `raw.jsonl` には残すが、パース側で早期に分岐して捨てる

### 14.3 起動シーケンス

```
1. config.json / office.json を読む
2. employees/*.json を読み、archived: false をスロットに配置（offline）
3. locks/ の死んだ PID を掃除
4. worktrees/ の実在確認（消えていたら isolation を none に戻して警告）
5. claude / codex の存在とバージョンを確認（§3 の検証済みと比較）
6. 前回中断されたタスク（running のまま）を interrupted に倒し、
   元の指示を「次に送るプロンプト」に書き戻す（空の場合のみ）
7. NetworkMonitor 起動、初期フィンガープリントを記録
8. 月次の締め処理（§13.3）
9. 描画開始
```

セッション ID の生存確認は**起動時にはやらない**。最初の指示で `--resume` が失敗したら §8.2 のフローへ。

---

## 15. 画面仕様（TUI）

### 15.1 レイアウト

最小サポートサイズ **100×32**。

```
┌─ VIRTUAL OFFICE ────── セッション 3/6 ─ 稼働 2 ─ リセットまで 2:14 ─ 09:12 ─┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
│  ▓  ╔══════════╗   ┌──────────┐   ┌──────────┐           ▓  │
│  ▓  ║  (^o^)🖋 ║   │  (・∀・)  │   │  (-.-)z  │           ▓  │
│  ▓  ║ ▄▄▄▄▄▄▄▄ ║   │ ▄▄▄▄▄▄▄▄ │   │ ▄▄▄▄▄▄▄▄ │           ▓  │
│  ▓  ║ CDX-01 ⑂ ║   │ CLD-02   │   │ CLD-03 📝│           ▓  │
│  ▓  ║ ███████░ ║   │ ████░░░░~│   │ ██░░░░░░ │           ▓  │
│  ▓  ║ BLOCKED  ║   │DELEGATING│   │  IDLE    │           ▓  │
│  ▓  ╚══════════╝   └──────────┘   └──────────┘           ▓  │
│  ▓      ▲          (·-·)🔍(·-·)📐                         ▓  │
│  ▓   選択中         Explore  Plan   [☕休憩室] [＋空スロット×3]  ▓  │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │
├─ CDX-01 リク ── 主任・バックエンド屋 ── Lv.4 ── 月給 3,000 ──────┤
│ CTX ████████░░ 78% (156k/200k)   勤務 01:12:40  稼働率 62%      │
│ 完了 14  失敗 1  編集 37  実行 82  サブエージェント 5  承認 3  復帰 2        │
│ ⑂ vo/CDX-01（隔離中）                                           │
│ 🖋 承認 1 件 — Edit: src/auth/session.ts        [Enter で確認]   │
│ 📝 次: テスト書いたらドキュメントも更新して                       │
├──────────────────────────────────────────────────────────────────┤
│ [←→]スロット [Enter]会話 [m]下書き [n]作成 [$]経営 [?]ヘルプ [q]終了     │
└──────────────────────────────────────────────────────────────────┘
```

- コンテキストゲージ末尾の `~` は**概算表示**の印（codex セッションに付く、§17.1）

### 15.2 表の描画方式

**半ブロック文字による縦 2 倍解像度**。`▀` (U+2580) の前景色に上ピクセル、背景色に下ピクセル。

```
16×16 のスプライト → 16 列 × 8 行
サブエージェントスプライトは 8×8 → 8 列 × 4 行
```

- スプライトは `assets/sprites/*.txt` に 1 文字 = 1 ピクセル = パレットインデックス
- パレット 16 色。truecolor → 256色 → ASCII と段階的にフォールバック
- アニメーションは **8fps** 固定。ただし `thinking` は `system/thinking_tokens` の値で駆動する（§15.6）
- 静止中のセッションは再描画しない

| 用途 | サイズ | フレーム数 |
|---|---|---|
| セッション idle | 16×16 | 2（まばたき） |
| セッション thinking | 16×16 | 4（思考量で段階変化、§15.6） |
| セッション working | 16×16 | 4（タイピング） |
| セッション delegating | 16×16 | 3（指示を出す仕草） |
| セッション blocked | 16×16 | 2（承認内容を掲げる） |
| セッション reconnecting | 16×16 | 3（頭上に ⚡、受話器） |
| セッション error | 16×16 | 2（頭上に「！」点滅） |
| セッション resting | 16×16 | 3（☕ 湯気） |
| サブエージェント Explore | 8×8 | 2（虫めがね） |
| サブエージェント Plan | 8×8 | 2（図面） |
| サブエージェント 汎用 | 8×8 | 2 |
| ユーザー | 16×16 | 4（正面・移動） |
| 机 / 椅子 / 観葉植物 / 休憩室 | 各種 | 各 1 |

### 15.3 会話モード

```
┌─ CLD-02 ミナ との会話 ─────────────────────────────────────────┐
│  (・∀・) 「まかせてください！」        ← 演出テキスト（淡色・鉤括弧）│
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ src/auth/session.ts のトークン検証を見直しました。         │ │  ← AI 実出力
│  │ 期限切れの判定が UTC を仮定していたため…                   │ │    （通常色・枠）
│  └───────────────────────────────────────────────────────────┘ │
│  ⚙ Agent 「認証の周辺コードを調査」 (Explore)                   │
│    └ (·-·) CLD-02-a: src/auth 配下 8 ファイルを確認…  8.2k tok │  ← サブエージェント（インデント）
│  ⚙ Edit  src/auth/session.ts (+12 -4)                          │
│  ─── ⚡ ネットワーク切替により中断（10:42:15）──────────────── │  ← システム（区切り線）
│  ─── 復帰（10:42:23）─────────────────────────────────────── │
│  ⚙ Bash  npm test -- auth                   ✓ 24 passed        │
├─────────────────────────────────────────────────────────────────┤
│ 📝 次: テスト書いたらドキュメントも更新して      [Enter で送信]  │
├─────────────────────────────────────────────────────────────────┤
│ > _                                                             │
├─────────────────────────────────────────────────────────────────┤
│ [Enter]送信 [m]下書き [Esc]戻る [Ctrl+C]中断 [PgUp/PgDn]スクロール │
└─────────────────────────────────────────────────────────────────┘
```

**4 種類のテキストを視覚的に区別する。** 演出（淡色＋鉤括弧）／ AI 実出力（枠付き通常色）／ サブエージェント（インデント）／ システム由来の出来事（区切り線）。ユーザーが「どこまでが本物か」を誤認しない設計を最優先とする。

### 15.3.1 マークダウンの表示

モデルの応答は記法のまま出さず、装飾に置き換える（`src/tui/markdown.ts`）。

| 記法 | 表示 |
|---|---|
| `# 見出し` | 強調色・太字（`#` は出さない） |
| `**太字**` | 明るい色 + 太字 |
| `*斜体*` / `~~打消~~` | イタリック / 取り消し線 |
| `` `コード` `` | 強調色 + 背景 |
| ` ```lang ` | 背景を変えたブロック。**中は一切解釈しない** |
| `- ` / `1. ` | `•` / 番号。入れ子は下げる |
| `> 引用` | 左に縦線 |
| `\|表\|` | 桁を揃え、見出しの下に罫線 |
| `[text](url)` | 下線 + **URL も残す** |
| `---` | 罫線 |

**原則: 中身を変えない。** 記号を装飾に置き換えるだけで、文字は落とさない。

- コードブロックの中は解釈しない（`**bold**` があってもそのまま）
- リンクの URL を捨てない
- 記法として成立していない記号（`2 * 3`、`snake_case`、閉じていない `**`）は
  そのままの文字として出す
- 装飾を保ったまま表示幅で折り返す。全角の途中では割らない

### 15.3.0 改行のキー

**`Enter` は送信、`Ctrl+J` は改行。** raw モードでは Enter が CR（0x0D）、
Ctrl+J が LF（0x0A）で別のバイトなので、端末の対応に関係なく区別できる。

改行として受けるもの:

| 入力 | 並び |
|---|---|
| `Ctrl+J` | `\n` |
| `Alt+Enter` | `ESC \r` |
| `Shift+Enter`（kitty 系） | `ESC [ 13 ; 2 u` |
| `Shift+Enter`（xterm modifyOtherKeys） | `ESC [ 27 ; 2 ; 13 ~` |

> **`Alt+Enter` を主にしない理由**: 端末やウィンドウマネージャが先に横取りする
> ことがある（Alacritty の全画面切り替えなど）。アプリまで届かないので、
> 画面の案内には `Ctrl+J` を出す。届いた場合は改行として扱う。

CSI-u と modifyOtherKeys の解釈は他のキーにも効く（`Shift+Tab`、`Ctrl+文字` など）。

### 15.3.2 スラッシュコマンドの補完

会話で `/` を打つと候補を出す。

| | 内容 |
|---|---|
| 候補の出どころ | claude の `system/init` が返す `slash_commands`（実測 47 件） |
| 取得のしかた | 使用量の取得（`claude -p "/usage" --output-format stream-json`）に相乗り。**追加の起動も課金も無い** |
| 除外 | `terminal_slash_commands`（端末でしか動かないもの。実測 `doctor` / `color`） |
| 出す条件 | 1 行目が `/` で始まり、まだ引数を打っていないとき |
| 操作 | `Tab` / `↑↓` で選ぶ、`Enter` で確定、`Esc` で閉じる（会話からは出ない） |

- **一覧が取れていなければ何も出さない。** 存在しないコマンドを勧めない
- 文中の `/`（`src/auth`）や引数を打ち始めたあとは割り込まない
- **codex には出さない。** `codex exec` はスラッシュコマンドを解釈せず、
  ただのプロンプトとして送られてトークンを消費する（実測: `codex exec "/status"` が
  51,666 トークンを消費して git を叩いた）。送ろうとしたら知らせる

`/usage` `/context` `/compact` は CLI 内部で処理され、モデル呼び出しは起きない
（実測: `num_turns: 0` / `total_cost_usd: 0`）。

### 15.4 承認画面

`blocked` のセッションを選んで `Enter` → §8.4 の承認内容。複数件は `j`/`k` で送る。

### 15.5 その他の画面
- **ログ画面** (`L`): 全セッションの AgentEvent と SystemEvent を時系列で
- **セッション履歴** (`p`): アーカイブ者含む全セッションのスタッツ、復元、月次履歴
- **統計** (`$`): §13 の会計画面＋使用量
- **ヘルプ** (`?`) / **設定** (`,`)

### 15.6 思考量に連動したアニメーション

`system/thinking_tokens` の `estimated_tokens` を使い、`thinking` の見た目を段階変化させる。固定 8fps ループより情報量が出る。

| `estimated_tokens` | 演出 |
|---|---|
| 0–200 | 頭上に「？」1 つ |
| 200–800 | 「？」2 つ、たまに首をかしげる |
| 800–2000 | 「？」3 つ、汗 |
| 2000+ | 頭から湯気、机に突っ伏しかける |

詳細パネルには数値もそのまま出す（`思考中… 1,350 tok`）。

### 15.7 通知

- **端末ベル**（`\x07`）。設定 `notifications.bell` でオフ可（既定オン）
- 鳴らす契機: タスク完了 / タスク失敗 / **承認発生** / 復帰失敗 / 営業時間外突入
- 鳴らさない契機: 通常の状態遷移、ネットワーク検知そのもの、復帰の成功
- **連続抑制**: 3 秒以内は 1 回にまとめる
- OS 通知は v1 では実装しない

### 15.8 アクセシビリティ / フォールバック
- `--ascii` / `--no-anim` フラグ
- 色数の自動検出と段階的フォールバック
- 状態は色だけでなく必ずテキストラベルを併記

---

## 16. キーバインド

**方針**: 矢印キーと vim キーの両対応。すべての機能がキーボードのみで到達可能。

### グローバル（一覧画面）

| キー | 動作 |
|---|---|
| `←` `→` / `h` `l` | スロット選択を左右 |
| `↑` `↓` / `k` `j` | スロット選択を上下 |
| `Tab` / `Shift+Tab` | 次／前のセッション（稼働中を優先して巡回） |
| `1`–`6` | 番号でスロットを直接選択 |
| `Enter` | 会話モードへ（承認中なら承認画面、下書き提示中なら下書き送信） |
| `Space` | 詳細パネルの展開／折りたたみ |
| `m` / `d` | 次に送るプロンプトの編集 / 削除 |
| `n` / `X` | 新規作成 / アーカイブ（確認あり） |
| `c` | compact 指示 |
| `R` / `Shift+R` | 手動再接続（選択中 / 全員） |
| `Ctrl+C` | 実行中タスクを中断 |
| `L` / `p` / `$` / `,` / `?` | ログ / セッション履歴 / 統計 / 設定 / ヘルプ |
| `q` | 終了（稼働中のセッションがいれば確認） |
| `Ctrl+L` | 画面再描画 |

### 承認画面

| キー | 動作 |
|---|---|
| `y` | 承認 → `--allowedTools` 付きで再実行 |
| `n` | 却下 → 理由を入力して次の指示に |
| `a` | 今後このツールは常に承認（設定に保存） |
| `j` / `k` | 複数件を送る |
| `Esc` | 保留して一覧画面へ |

### 会話モード

| キー | 動作 |
|---|---|
| `Enter` | 送信（入力欄が空で下書きがあれば下書きを送信） |
| `Ctrl+J` | 改行 |
| `m` | 下書き編集（入力欄が空のときのみ） |
| `Esc` | 一覧画面へ戻る |
| `Ctrl+C` | 実行中タスクの中断（入力中なら入力クリア） |
| `PgUp`/`PgDn`/`Ctrl+U`/`Ctrl+D` | 履歴スクロール |
| `↑` `↓` | 入力欄が空のとき、送信済みプロンプトの履歴を遡る |
| `Ctrl+R` | 過去プロンプトの検索 |
| `Tab` | サブエージェントの発話の展開／折りたたみ |

### ダイアログ共通

`↑`/`↓`/`j`/`k` 項目移動、`←`/`→`/`h`/`l` 値変更、`Enter` 決定、`Esc` キャンセル、`r` ランダム再生成。

---

## 17. 数値仕様

### 17.1 コンテキスト残量 — CLI により精度が違う

**claude（正確）** — 最後の `assistant` イベントの `message.usage` を使う。

```
contextTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

> **`result.usage` を使ってはいけない。** ターン内の全モデル呼び出しの累計なので、実測では実際の 2 倍（14,346 に対し 28,362）になった。

**codex（概算のみ）** — `turn.completed.usage.input_tokens` は**スレッド生涯の累計**であって文脈サイズではない。

```
contextTokens ≈ (input_tokens - 前ターンの input_tokens) / (ツール実行回数 + 1)
```

実測での検算: 一言だけのターンで累計が 17,483 増えた（実際の会話増分は数百）。ツール実行 0 回のターンの差分が、そのときの文脈サイズにあたる。

> **実装**: codex セッションのゲージには**必ず `~`（概算）マークを付ける**。`Employee.context.estimated` で区別する。claude セッションは正確値なのでマーク不要。

| ratio | 表示 | 演出 |
|---|---|---|
| 0.00–0.49 | 緑ゲージ | 通常 |
| 0.50–0.74 | 黄ゲージ | 汗マーク |
| 0.75–0.84 | 橙ゲージ | 「そろそろ限界です…」 |
| 0.85–1.00 | 赤ゲージ点滅 | `resting` へ。コーヒー演出＋引継ぎ提案 |

`windowTokens` はモデル別の既定値テーブル。不明なモデルは 200,000。

### 17.2 稼働時間
- **総勤務時間** = `now - hiredAt`
- **実働時間** = `activeMs`。`thinking`/`working`/`delegating`/`reconnecting` の累計。**`blocked` は含めない**（セッションは待たされているだけで働いていない）
- **稼働率** = 実働 / 総勤務
- 状態遷移のたびに `lastActiveAt` との差分を加算（タイマー不要、ドリフトしない）

### 17.3 集計

すべて実回数を数えるだけで、加重や係数は持たない。

```
tasksCompleted / tasksFailed / tasksInterrupted
filesEdited / commandsRun / subagentsSpawned
approvalsRequested / approvalsGranted / reconnects
totalTokensIn / totalTokensOut
```

- 中断（`interrupted`）と承認待ち（`blocked`）は失敗に数えない
- 取り込んだ会話の実績はログの実数をそのまま入れる。水増ししない

## 18. 設定

```jsonc
{
  "companyName": "株式会社バーチャル",
  "presidentName": "ユーザー",

  // null = CLI のデフォルトに任せる（引数を付与しない）
  "defaults": {
    "claude": { "permissionMode": null, "model": null, "contextWindow": 200000 },
    "codex":  { "sandbox": null,        "model": null, "contextWindow": 200000 },
    "cwd": "~/projects"
  },

  "approvals": {
    "alwaysAllow": []      // "a" で承認したツール名が溜まる。--allowedTools に渡す
  },

  "workspace": { "autoWorktree": true, "worktreeBranchPrefix": "vo/" },

  "network": {
    "watch": true, "pollIntervalMs": 5000, "stabilizeMs": 3000,
    "maxWaitMs": 60000, "maxRetries": 3, "sleepDetectThresholdMs": 60000,
    "reachabilityProbe": null, "autoRecover": true
  },

  "behavior": { "autoSendNextMemo": false },
  "notifications": { "bell": true },

  "finance": {
    "monthlyBudget": 20000,
    "salaryByLevel": { "1": 2000, "3": 3000, "6": 4500, "10": 6000 }
  },

  "ui": {
    "animations": true, "fps": 8, "ascii": false,
    "theme": "office-green", "seatCount": 6,
    "showSubordinates": true, "showRateLimitBar": true
  },

  "thresholds": { "contextWarn": 0.75, "contextRest": 0.85 }
}
```

---

## 19. エラー処理

| 事象 | 挙動 |
|---|---|
| CLI が見つからない | 起動時に検出し、該当種別の作成を無効化。バナー表示 |
| CLI のバージョンが検証済みと違う | 警告バナー。動作は継続 |
| CLI が異常終了 | `error`。stderr の末尾 10 行を詳細パネルに保持 |
| JSONL パース失敗 | その行を無視。失敗率 >20% で `error` ＋スキーマ警告 |
| セッション再開失敗 | §8.2 の新規セッション提案フロー |
| **権限拒否** | `blocked`。§8.4 の承認フロー |
| **レート制限到達** | 全セッション `resting`。「営業時間外」表示、指示送信をブロック |
| ネットワーク変更 | §10 の復帰フロー |
| ネットワーク断が継続 | 60 秒で諦めて `error`。復旧後 `R` |
| worktree が消えている | 起動時に検出、`isolation: none` に戻して警告 |
| ディレクトリの二重使用 | §9 で事前回避。すり抜けたらロックで待機 |
| 端末リサイズ | 再レイアウト。最小サイズ未満なら警告画面 |
| アプリ異常終了 | 次回起動時に §14.3 のシーケンスで復帰 |

---

## 20. 実装フェーズ

| # | 内容 | 完了条件 | 状態 |
|---|---|---|---|
| **0** | CLI 出力の実採取 | イベントマッピング表の確定 | ✅ **完了**（`docs/phase0/FINDINGS.md`） |
| **1** | core: SessionManager + MockDriver | ヘッドレスで「作成→指示→完了→次の指示」がテストで通る | ✅ **完了**（41 テスト green、strict 型チェック通過） |
| **2** | core: ClaudeDriver / CodexDriver | 実 CLI でマルチターンの往復が成立。承認の再実行も一周 | ✅ **完了**（`npm run test:live` が実 CLI に対して green） |
| **3** | core: WorkspaceManager | worktree 隔離とロックが動く | ✅ **完了**（実 git に対して 39 テスト green） |
| **4** | core: NetworkMonitor + RecoveryCoordinator | MockDriver で復帰シナリオがテストで通る | ✅ **完了**（33 テスト green） |
| **5** | TUI: 静的レイアウト | 俯瞰図＋詳細パネル（状態は固定値） | ✅ **完了**（38 テスト green） |
| **6** | TUI: キー操作 | §16 の全バインドが動く | ✅ **完了**（43 テスト green） |
| **7** | TUI: 会話モード | 実 CLI と往復できる | ✅ **完了**（17 テスト + 実 CLI 往復 green） |
| **8** | 承認フロー | 拒否検出 → 承認内容表示 → 承認 → 再実行 | ✅ **完了**（19 テスト + 実 CLI で一周 green） |
| **9** | 次に送るプロンプト | 編集・永続化・完了時提示・送信 | ✅ **完了**（17 テスト green） |
| **10** | 永続化・復帰 | 落として立ち上げ直すと会話の続きができる | ✅ **完了**（25 テスト + 実 CLI で再起動をまたいだ会話継続 green） |
| **11** | ネットワーク復帰の実機確認 | WiFi を実際に切り替えて会話が維持される | ✅ **自動分は完了**（実 CLI の中断→復帰で二重実行なしを確認）。WiFi の物理切替は `docs/NETWORK-CHECK.md` の手順で要実機確認 |
| **12** | 表・アニメ | スプライト描画、思考量連動アニメ | ✅ **完了**（20 テスト green） |
| **13** | サブエージェント演出 | サブエージェントの登場・ステータス・退場 | ✅ **完了**（13 テスト + 実 CLI でサブエージェントが登場 green） |
| **14** | 集計・使用量・通知 | 期間集計、使用量表示、端末ベル | ✅ **完了** |
| **15** | 仕上げ | エラー処理、フォールバック、ヘルプ | ✅ **完了**（通し確認 8 テスト、README） |

---

## 21. 決定済み事項

1. **実行形態**: TUI 優先。core を UI 非依存に切り、Web は後付け
2. **AI 連携**: 実プロセスを起動する
3. **画面表現**: ハイブリッド。俯瞰図＋カーソルでスロット選択＋Enter で会話モード
4. **ステータス**: コンテキスト残量 / 稼働時間・状態 / 実績スタッツ / 性格・役職
5. **会話**: マルチターン継続。1 ターン = 1 プロセス（フェーズ 0 で実証）
6. **スロット数**: 6 固定
7. **サブエージェント**: 専用イベントで検出。**claude セッションのみ**（§11）
8. **タスク管理**: キューは作らない。セッションごとに「次に送るプロンプト」1 件
9. **ディレクトリ衝突**: 自動回避。git なら worktree 隔離
10. **コスト表示**: 実測のトークン数と、CLI が返す残量のみ。擬似的な金額は持たない
11. **CLI 既定の踏襲**: モデル・権限モード・サンドボックスは CLI に任せる
12. **通知**: 端末ベルのみ。設定でオフ可
13. **月次リセット**: 実カレンダー月初。長期未起動時は起動時にまとめて締める
14. **ネットワーク変更**: 検知して自動復帰。元の指示は再送せず状態確認を挟む
15. **同一ディレクトリの復帰**: worktree なら並行、同居なら直列。セッションごとに独立
16. **承認モデル**: リアルタイム承認は不可能。**後追いの承認方式**を採る（§8.4）
17. **コンテキスト精度**: claude は正確、codex は概算。画面上で `~` で区別（§17.1）
18. **codex のサンドボックス**: 作成時に固定。resume では変更できない（§5.2）
19. **使用量**: `rate_limit_event` を実データとして表示（§13.4）

---

## 22. 未決事項

### フェーズ 2 で確認するもの

1. **`Ctrl+C` 中断後のセッション状態**
   プロセスを殺したとき、CLI 側のセッションに部分的な履歴が残るか。§10.5 の復帰プロンプトは「残る」前提で書いているので、実挙動に合わせて文面を調整する。

2. **codex の `file_change.kind` の全種**
   `update` のみ観測。`add` / `delete` は推定。

### 実装しながら決めるもの

4. **codex のセッション ID 未確定期間の見せ方**
   1 ターン目の実行中は ID が未定。追加指示はキューに積む。「まだ名刺ができていません」のような演出を想定。

5. **会話履歴の表示範囲**
   直近 20 ターンを下書きリに、それ以前は `tasks.jsonl` から遅延ロードで進める。

6. **`stream_event` の詳細構造**
   タイピングアニメを実装する段（フェーズ 12）で `content_block_delta` の構造を詰める。量が多いので捨てる分岐を先に入れる。

7. **ネットワーク検知の実機での感度**
   ポーリング 5 秒 / 安定判定 3 秒は机上の値。VPN・テザリング切替で過剰検知・検知漏れが出ないかフェーズ 11 で実測して調整。

8. **復帰プロンプトの文面**
   §10.5 の文面は暫定。エージェントが「二重実行を避けつつ続きをやる」判断を安定して下せるか確認して詰める。
