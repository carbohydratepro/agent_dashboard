# フェーズ 0 — CLI 出力の実採取と検証結果

- 実施日: 2026-08-12
- 対象: `claude` 2.1.228 (Claude Code) / `codex-cli` 0.147.0
- 生キャプチャ: `docs/phase0/captures/*.jsonl`
- 目的: SPEC.md §22 の未決事項のうち、実物を見ないと決まらない 4 点を潰す

---

## 0. 結論サマリ

| # | 検証項目 | 結果 |
|---|---|---|
| 1 | `-p` モードの権限プロンプト | ⚠️ **プロンプトは出ない。即時拒否される。** 設計変更が必要（§3） |
| 2 | トークン使用量のフィールド名 | ✅ 特定。claude は正確に算出可、**codex は概算のみ**（§5） |
| 6 | **使用量（残量）の取得** | ✅ **両方とも取れる**（§7.0）。当初の「取れない」は誤り |
| 3 | codex のサブエージェント | ✅ claude 側は専用イベントあり。**仕様より高機能**（§4）。codex 側は該当機能なし |
| 4 | codex のセッション ID | ✅ `thread.started.thread_id`（§2.2） |
| 5 | 会話継続（両 CLI） | ✅ **実証済み**。ツール未使用で過去の文脈から回答できた（§6） |

副産物として、仕様に無かった有用なイベントを 4 つ発見した（§7）。

---

## 1. 実行時の注意点（実測で判明）

### 1.1 stdin を必ず閉じる

`claude -p` は stdin からの入力を **3 秒待つ**。閉じないと毎ターン 3 秒の無駄が乗る。

```
Warning: no stdin data received in 3s, proceeding without it.
```

codex も同様に `Reading additional input from stdin...` を出す。

> **実装**: 両ドライバとも `stdio: ['ignore', 'pipe', 'pipe']` で spawn する。

### 1.2 codex の引数順序

`codex exec resume` は**オプションを位置引数より前に置く必要がある**。

```bash
codex exec resume --json <SESSION_ID> "<PROMPT>"   # ✅
codex exec resume <SESSION_ID> "<PROMPT>" --json   # ❌ error: unexpected argument
```

さらに **`--sandbox` は `resume` では受け付けない**。

```
Usage: codex exec resume --json <SESSION_ID> <PROMPT>
error: unexpected argument '--sandbox' found
```

> **実装**: サンドボックス設定は初回セッション作成時にのみ指定できる。resume は初回の設定を継承する。採用時に決めた設定が、その社員の生涯にわたって固定されるということ。UI 上もそう説明する。

### 1.3 環境変数

親が Claude Code の場合、`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` などが継承されて子の挙動に影響しうる。プローブでは `env -u` で落とした。

> **実装**: 子プロセスには最小限の環境だけ渡す。`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` は削除する。

---

## 2. イベントスキーマ

### 2.1 claude — `--output-format stream-json --verbose`

1 行 1 JSON。トップレベルの `type` で分岐する。全イベントに `session_id` と `uuid` が付く。

| `type` | `subtype` | 中身 |
|---|---|---|
| `system` | `init` | `session_id`, `model`, `cwd`, `tools[]`, `mcp_servers[]`, `permissionMode`, `slash_commands[]` |
| `system` | `status` | `status: "requesting"` — API 呼び出し中 |
| `system` | `thinking_tokens` | `estimated_tokens`, `estimated_tokens_delta` — 思考量のライブ数値 |
| `system` | `permission_denied` | `tool_name`, `tool_use_id`, `message` |
| `system` | `task_started` | サブエージェント開始（§4） |
| `system` | `task_progress` | サブエージェント進捗（§4） |
| `system` | `task_updated` | `patch: {status, end_time}` |
| `system` | `task_notification` | `status`, `summary`, `output_file` |
| `assistant` | — | `message.content[]` に `text` / `tool_use` ブロック。`message.usage`、`parent_tool_use_id` |
| `user` | — | `message.content[]` に `tool_result`。`tool_use_result` に構造化された詳細 |
| `stream_event` | — | `--include-partial-messages` 指定時。生の API ストリーミングイベントを `event` に内包 |
| `rate_limit_event` | — | `rate_limit_info: {status, resetsAt, rateLimitType, overageStatus, ...}` |
| `result` | `success` | `result`（最終テキスト）, `usage`, `modelUsage`, `total_cost_usd`, `num_turns`, `stop_reason`, `permission_denials[]`, `duration_ms`, `ttft_ms` |

観測されたイベント列（サブエージェント使用時）:

```
system/init → rate_limit_event → stream_event×N → assistant → system/task_started
→ system/task_progress×3 → assistant(parent_tool_use_id 付き) → user(parent 付き)
→ system/task_updated → system/task_notification → assistant → result/success
```

### 2.2 codex — `--json`

claude よりフラットで安定した構造。**`type` は `thread.*` / `turn.*` / `item.*` の 3 系統のみ。**

| `type` | 中身 |
|---|---|
| `thread.started` | **`thread_id` ← これがセッション ID**（UUIDv7） |
| `turn.started` | （フィールドなし） |
| `item.started` | `item: {id, type, ...}` |
| `item.completed` | 同上（完了状態） |
| `turn.completed` | `usage: {input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` |

`item.type` の種類:

| `item.type` | フィールド |
|---|---|
| `agent_message` | `text` |
| `command_execution` | `command`, `aggregated_output`, `exit_code`, `status` |
| `file_change` | `changes[]: {path, kind}`（`kind`: `update` / `add` / `delete`）, `status` |

> **重要な差**: codex はファイル読み取りにも `command_execution`（`sed -n '1,240p' calc.js`）を使う。claude のような `Read` ツールは無い。ファイル編集だけが `file_change` として明示的に出る。

---

## 3. ⚠️ 権限プロンプト — 設計変更が必要

### 3.1 実測結果

`--permission-mode manual` で編集を要するタスクを投げた結果:

```
assistant(tool_use: Edit)
  → system/permission_denied
  → user(tool_result is_error=true: "Claude requested permissions to write to
     ...calc.js, but you haven't granted it yet.")
  → assistant(拒否を説明して終了)
  → result/success   ← ターンは「成功」で終わる
```

- **対話的な承認プロンプトは一切出ない。即座に拒否される**
- ファイルは変更されなかった（`git diff` 空）
- `result.permission_denials[]` に**拒否された操作の完全な内容**が入る:

```json
{
  "tool_name": "Edit",
  "tool_use_id": "toolu_012RJ5ba7BVCHeGNRDVCTS8A",
  "tool_input": {
    "file_path": ".../calc.js",
    "old_string": "export function add(a, b) {\n  return a + b;\n}\n",
    "new_string": "export function add(a, b) {\n  return a + b;\n}\n\nexport function sub(a, b) {\n  return a - b;\n}\n",
    "replace_all": false
  }
}
```

- `--permission-prompt-tool` に相当するフラグは、このバージョンの `--help` に**存在しない**

### 3.2 結論と代替設計

**リアルタイム承認（SPEC §7 の `waiting` 状態）は、1 ターン = 1 プロセスの `-p` モードでは実装できない。**

しかし `permission_denials` に完全な `tool_input` が入るため、**後追い承認（稟議）モデル**が成立する。むしろ「社長」というロールには、モーダルダイアログより稟議書のほうが合っている。

```
社員がツールを使おうとする
  → 拒否される（ターンは正常終了）
  → permission_denials を検出 → 社員は blocked 状態
  → 詳細パネルに「稟議書」として表示
     ・誰が / 何のツールで / 何をしようとしたか
     ・Edit なら old_string/new_string から差分を描画できる
  → 社長が y で承認
  → 同じセッションを --resume + --allowedTools "<tool>" で再実行
  → n で却下 → 却下理由をメモに残して次の指示へ
```

これなら 1 ターン = 1 プロセスの方式を崩さずに済み、常駐モード（`--input-format stream-json`）を v1 に前倒しする必要もない。

**代償**: 承認に 1 ターン余分にかかる。ただし既定の権限モードを渡さない方針（CLI 設定を踏襲）なので、ユーザーが `acceptEdits` や `auto` を設定していれば稟議自体がほとんど発生しない。稟議は例外パスとして実装する。

> 実測では、フラグ未指定時の `permissionMode` は `auto` だった（`system/init` で確認）。ユーザーの既存設定がそのまま効く。

---

## 4. サブエージェント — 仕様より高機能だった

### 4.1 訂正: ツール名は `Task` ではなく `Agent`

```json
{"type":"tool_use","id":"toolu_01Skj...","name":"Agent",
 "input":{"subagent_type":"Explore","description":"List files and line counts",
          "run_in_background":false,"prompt":"..."}}
```

### 4.2 専用ライフサイクルイベントがある

`tool_use` を見て推測する必要はなく、`system/task_*` を追えばよい。

```json
// 開始
{"subtype":"task_started","task_id":"a3ae4e60e5d3e37a2",
 "tool_use_id":"toolu_01Skj...","description":"List files and line counts",
 "subagent_type":"Explore","task_type":"local_agent","prompt":"..."}

// 進捗（複数回）
{"subtype":"task_progress","task_id":"a3ae4e60e5d3e37a2",
 "description":"Running List all files excluding .git",
 "subagent_type":"Explore","last_tool_name":"Bash",
 "usage":{"total_tokens":8217,"tool_uses":1,"duration_ms":3768}}

// 完了
{"subtype":"task_updated","task_id":"...","patch":{"status":"completed","end_time":1786549304235}}
{"subtype":"task_notification","task_id":"...","status":"completed",
 "summary":"...","output_file":"/tmp/.../tasks/a3ae4e60e5d3e37a2.output"}
```

### 4.3 部下キャラに持たせられる実データ

仕様では「名前と直近の発話」しか想定していなかったが、実際には**部下も社員と同じ密度のステータスを持てる**:

| 表示項目 | 取得元 |
|---|---|
| 部下の職種 | `subagent_type`（`Explore` / `Plan` / `general-purpose` …） |
| 担当業務 | `description` |
| 今やっていること | `task_progress.description`, `last_tool_name` |
| 消費トークン | `task_progress.usage.total_tokens` |
| 作業時間 | `task_progress.usage.duration_ms` |
| ツール実行回数 | `task_progress.usage.tool_uses` |
| 発話 | `parent_tool_use_id` が一致する `assistant` イベント |
| 成果報告 | `task_notification.summary` |

`subagent_type` を部下の「職種」としてスプライトに割り当てられる（調査員 = Explore、設計者 = Plan など）。**仕様 §11 を格上げする価値がある。**

### 4.4 codex 側

codex の JSONL には該当するイベントが存在しない。`item.type` は `agent_message` / `command_execution` / `file_change` のみ。

> **結論**: サブエージェント演出は **claude 社員限定の機能**とする。ゲーム内では「claude 社員は部下を持てる」という差別化になる。

---

## 5. コンテキスト残量の算出

### 5.1 claude — 正確に出せる

**最後の `assistant` イベントの `message.usage` を使う。**

```
contextTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
```

実測（プローブ A1）: `2 + 330 + 14014 = 14346`

**`result.usage` を使ってはいけない。** あれはターン内の全モデル呼び出しの累計で、同じ計算をすると `28362` になり実際の 2 倍になる。

再開後（プローブ A4）は `14389` と自然に増えており、指標として一貫している。

### 5.2 codex — 概算しか出せない

`turn.completed.usage.input_tokens` は**スレッド生涯の累計**であって、文脈サイズではない。

| プローブ | ツール実行 | `input_tokens` | 前ターンからの差分 |
|---|---|---|---|
| B1（新規） | 1 | 32,782 | — |
| B3（新規） | 3 | 85,303 | — |
| B4（B3 を resume） | 0 | 102,769 | +17,466 |
| B5（B4 を resume） | 0 | 120,252 | +17,483 |

「了解とだけ答えて」という一言のターンで 17,483 増えている。会話の実際の増分は数百トークンなので、これは累計値である。ツール実行 0 回のターンの差分（≈17.5k）が、そのときの文脈サイズにあたる。

**推定式**:

```
contextTokens ≈ (input_tokens - 前ターンの input_tokens) / (ツール実行回数 + 1)
```

検算: B5 = 17,483/1 ✓ / B4 = 17,466/1 ✓ / B1 = 32,782/2 = 16,391 ✓ / B3 = 85,303/4 = 21,326（初回ターンは文脈が育つ途中なので妥当）

> **実装**: codex 社員のコンテキストゲージには**必ず「概算」マークを付ける**（SPEC §17.1 の想定どおり）。claude 社員は正確値なのでマーク不要。この非対称性は画面上でも区別する。

---

## 6. 会話継続の実証

両 CLI で「ファイルを読み直さずに、さっきの内容を答えて」を投げた。

| CLI | セッション ID | ツール使用 | 応答 | 判定 |
|---|---|---|---|---|
| claude | `1111…1111`（維持） | **なし** | 「ファイル名: `calc.js` / 関数名: `add`」 | ✅ |
| codex | `019ff6a3…`（維持） | **なし** | 「sub」 | ✅ |

どちらもツールを一切使わず、前のターンの文脈だけから正答した。**マルチターンの会話継続は完全に成立する**（SPEC §6 の主張を実証）。

claude は `--session-id` で指定した UUID がそのまま `system/init.session_id` に返り、resume 後も同一だった。

---

## 7. 仕様に無かった有用なイベント

### 7.0 使用量（残量）の取得 ★訂正★

当初「両 CLI とも残量を出す口が無い」と書いたが、**誤りだった**。
どちらも取得できる。ただし場所がまったく違う。

**claude — `/usage` スラッシュコマンドが非対話でも動く**

```bash
claude -p "/usage" --output-format json --no-session-persistence
```

```
Current session: 31% used · resets Aug 24, 2:49am (Asia/Tokyo)
Current week (all models): 22% used · resets Aug 23, 11:59pm (Asia/Tokyo)
```

- **モデル呼び出しは起きない**。実測で `num_turns: 0` / `total_cost_usd: 0` / 約 0.4 秒
- 返るのは人間向けのテキストなので、そこから読み取る
- `--no-session-persistence` を付ければセッション記録も残らない
- 関連コマンド: `/usage-credits`, `/extra-usage`（プランによって内容が変わる）

**codex — セッションのロールアウトに書かれている**

`codex exec --json` の stdout には出ないが、
`~/.codex/sessions/<年>/<月>/<日>/rollout-*.jsonl` に `token_count` イベントとして残る。

```json
{"type":"event_msg","payload":{
  "type":"token_count",
  "info":{ "model_context_window":258400, ... },
  "rate_limits":{
    "limit_id":"codex",
    "primary":{"used_percent":11,"window_minutes":10080,"resets_at":1787916394},
    "secondary":null,
    "credits":{"has_credits":false,"unlimited":false,"balance":"0"},
    "plan_type":"plus"
  }}}
```

- ファイルを読むだけなので API も課金も発生しない
- **`model_context_window` も分かる**（codex の実際の窓は 258,400。既定の 200,000 より広い）
- `codex exec "/status"` は駄目。スラッシュコマンドとして解釈されず、
  ただのプロンプトとしてモデルに送られてトークンを消費する

> 実装は `src/core/usage.ts`。採取した出力は `claude_usage.txt` と
> `codex_rate_limits.jsonl` に置いてあり、パーサのゴールデンテストに使っている。

### 7.1 `rate_limit_event`（claude）

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1786566000,"rateLimitType":"five_hour",
  "overageStatus":"allowed","overageResetsAt":1788220800,"isUsingOverage":false}}
```

月額固定でコストが動かない以上、**これが唯一の「本物の残リソース指標」**。SPEC §13 の給料/予算は擬似通貨だが、これは実測値。

> **提案**: 会社全体の指標として「今日の営業体力」バーを出す。`resetsAt` までのカウントダウンを「定時まであと N 分」として表示できる。`isUsingOverage` は「残業中」。ゲーム的な見立てと実データが素直に噛み合う数少ない例。

### 7.2 `system/thinking_tokens`（claude）

```json
{"subtype":"thinking_tokens","estimated_tokens":350,"estimated_tokens_delta":100}
```

思考量がライブで増える。`thinking` 状態のアニメを**この数値で駆動できる**（頭上の「？」の数を増やす、汗の量を増やすなど）。8fps の固定アニメより情報量のある演出になる。

### 7.3 `system/status`

`status: "requesting"` — API 応答待ち。`thinking` に入る正確なトリガとして使える。

### 7.4 `stream_event`

`--include-partial-messages` 指定時に、生の API ストリーミングイベント（`message_start`, `content_block_delta` …）が `event` フィールドに入って流れる。タイピングアニメの駆動用。プローブ A3 では 59 行中 34 行がこれだった。

> **注意**: 量が多い。`raw.jsonl` のローテーション閾値（SPEC §14.2 の 50MB）は妥当だが、パース側で早期に捨てる分岐を入れないと CPU を食う。

---

## 8. SPEC.md への反映が必要な項目

| SPEC の箇所 | 変更内容 | 重大度 |
|---|---|---|
| §7 状態遷移 / §4 `EmployeeState` | `waiting` を廃止し `blocked`（稟議中）に置換 | **大** |
| 新規 | 稟議フロー（§3.2）を追加 | **大** |
| §11 サブエージェント | ツール名 `Task`→`Agent`、`system/task_*` に基づく実装へ。部下のステータスを大幅拡充 | **中** |
| §11 | codex は非対応と明記 | 中 |
| §5.2 CodexDriver | `resume` の引数順序、`--sandbox` 不可（初回で固定） | 中 |
| §17.1 コンテキスト | claude=正確 / codex=概算、算出式を確定 | 中 |
| §5 両ドライバ | stdin を閉じる、環境変数を落とす | 小 |
| 新規 | `rate_limit_event` を「営業体力」として活用 | 小（提案） |
| §15.2 | `thinking_tokens` でアニメを駆動 | 小（提案） |

---

## 9. 残る未検証項目

1. **`Ctrl+C` 中断後のセッション状態**（SPEC §22-4）
   今回は未検証。復帰プロンプト（SPEC §10.5）の文面設計に影響する。フェーズ 2 でドライバを書きながら確認する。

2. **codex の `file_change.kind` の全種**
   `update` のみ観測。`add` / `delete` は推定。

3. **`--include-partial-messages` の `stream_event` 詳細**
   タイピングアニメを実装する段（フェーズ 11）で `content_block_delta` の構造を詰める。

4. **権限拒否からの再実行**（§3.2 の稟議フロー）
   `--allowedTools` を付けた `--resume` で実際に通るかは未検証。フェーズ 2 で確認する。

## 8. codex のスレッドは書き手 1 人まで（2026-09-01 追記）

同じスレッド ID に対して 2 つ目の `codex exec resume` を走らせると、終了コード 1 で落ちる。

```
ERROR codex_core::session::session: failed to initialize thread persistence:
  thread-store conflict: thread <id> already has an active writer
Error: thread/resume: thread/resume failed: thread <id> already has an active writer (code -32600)
```

同時実行に限らず、ダッシュボード側の記録が 2 つ同じ `agentSessionId` を持っているだけで、
片方は以後ずっと会話できなくなる。取り込み時に新しい記録を作らず、
アーカイブ済みの記録を戻すようにしたのはこのため（SessionManager.resolveDuplicateAgentSessions）。

### rollout ファイルはスレッドと 1 対 1 ではない

`codex exec resume` のたびに新しい `rollout-*.jsonl` ができるが、`session_meta.session_id` は同じ。
そのため会話一覧はファイル単位ではなくスレッド ID 単位でまとめる必要がある
（実データで 36 ファイル → 11 スレッド）。

再開時のファイルには、先頭のユーザー発話として次のような前置きが入る。見出しには使えない。

- `The following is the Codex agent history …`
- `<user_instructions>` / `<environment_context>`
- `# AGENTS.md instructions for <cwd>`

`session_meta` 行は `base_instructions` を丸ごと含むため 18KB 前後ある。
先頭だけ読む実装では、読む量をこれより十分大きく取らないと本文に届かない（現在 128KB）。
