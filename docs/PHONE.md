# スマホから見る（SSH）

実行は PC のまま。スマホからは SSH で入って、tmux の中で動いている
ダッシュボードに繋ぐ。電波が切れても作業は続く。

## PC 側（設定済み）

`sshd` を 2222 番で動かしている。Windows 側の OpenSSH が 22 番を使うことが
あるので、ぶつからないようにずらしてある。

```
Port 2222
PasswordAuthentication no      # 鍵だけ。パスワードは受け付けない
PermitRootLogin no
AllowUsers carbohydratepro
ClientAliveInterval 30         # 電波が悪いところで切れかけを落とす
```

設定は `/etc/ssh/sshd_config.d/60-dashboard.conf`。`systemctl status sshd` で状態を見る。

## 外から届ける（Tailscale）

WSL2 の中に Tailscale を入れてある（`tailscaled` は systemd で常駐）。
Tailscale の IP が WSL に直接付くので、Windows 側の portproxy や
`.wslconfig` の mirrored 設定は要らない。ルータのポート開放もしない。

この文書は公開リポジトリにあるので、実際の IP は書かない。`tailscale status` で調べる。
IP は端末を削除して登録し直さない限り変わらない。

### Tailscale SSH は使わない

2026-10-25 に Tailscale SSH の未修正の脆弱性（Tailworm）が公開された。
ここでは Tailscale を通り道にだけ使い、ログインは OpenSSH（2222 番）で行う。

- PC は `--ssh=false` で上げてある（`sudo tailscale debug prefs` の `RunSSH` が false）
- ACL には `ssh` 節を置かない。Serve / Funnel も使わない
- ACL は「スマホから PC の 2222 番だけ」に絞ってある

```json
{
  "hosts": {
    "pc":    "<PC の Tailscale IP>",
    "phone": "<スマホの Tailscale IP>"
  },
  "grants": [
    { "src": ["phone"], "dst": ["pc"], "ip": ["tcp:2222"] }
  ]
}
```

端末を足すときは `hosts` と `grants` に追記する。

PC の Tailscale ログインが切れたら（既定で 180 日）、`sudo tailscale login` で
出る URL を開いて承認し直す。

## スマホ側の手順

### 1. 鍵を作る

Termius の Keychain → ＋ → Generate Key で ED25519 の鍵を作り、パスフレーズを付ける。
**秘密鍵はスマホから出さず、公開鍵だけを PC に渡す**。

### 2. 公開鍵を PC に登録する

```bash
echo 'ssh-ed25519 AAAA... phone-termius' >> ~/.ssh/authorized_keys
```

端末ごとに別の鍵にする。なくしたらその行を消せば締め出せる。

### 3. 繋ぐ

Termius の Host 設定:

| 項目 | 値 |
|---|---|
| Address | PC の Tailscale IP |
| Port | `2222` |
| Username | `carbohydratepro` |
| Key | 1 で作った鍵（Password は空のまま） |
| Use SSH | オン（Mosh はオフ） |

初回はホスト鍵の確認が出る。Termius は ECDSA の鍵を見せるので、
`ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub` の値と照らす。

入ったら `~/agent_dashboard/scripts/dash` を打つ。tmux セッション `dash` に繋ぐ
（無ければ作る）。SSH が切れても中は動き続けるので、入り直して同じコマンドを打てば
元の画面に戻る。

## 画面の狭さ

一覧は幅に応じて列を落とす。最小 36x14 まで動く。

| 幅 | 出る列 |
|---|---|
| 124 以上 | 全部（モデルまで） |
| 90 前後 | 経過・タスク・トークン・印 |
| 70 前後 | 状態・コンテキスト・作業内容 |
| 45 以下 | セッション名・コンテキスト（数字だけ）・作業内容 |

会話画面は幅に合わせて折り返すので、狭くても読める。
