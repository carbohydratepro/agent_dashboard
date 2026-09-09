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

## スマホ側の手順

### 1. 鍵を作る

SSH クライアント（Termius、Blink など）で鍵を作る。**秘密鍵は PC から持ち出さず、
スマホ側で作って公開鍵だけを渡す**。

### 2. 公開鍵を PC に登録する

```bash
echo 'ssh-ed25519 AAAA... phone' >> ~/.ssh/authorized_keys
```

### 3. Windows 側で転送する（WSL2 のため必要）

WSL2 は Windows とは別の IP を持つので、そのままでは外から届かない。
**管理者権限の PowerShell** で次を実行する。

```powershell
# WSL の現在の IP を調べて転送する
$ip = (wsl -d Ubuntu -e sh -c "ip -4 addr show eth0 | grep -oP 'inet \K[\d.]+'").Trim()
netsh interface portproxy add v4tov4 listenport=2222 listenaddress=0.0.0.0 connectport=2222 connectaddress=$ip
New-NetFirewallRule -DisplayName "WSL dashboard SSH" -Direction Inbound -LocalPort 2222 -Protocol TCP -Action Allow
```

**WSL の IP は再起動のたびに変わる**ので、そのつど登録し直す必要がある。
毎回やりたくなければ、`C:\Users\masas\.wslconfig` に次を書いて WSL を再起動する
（Windows 11 22H2 以降）。IP が Windows と共有になり、転送そのものが不要になる。

```ini
[wsl2]
networkingMode=mirrored
```

### 4. 繋ぐ

```
ssh -p 2222 carbohydratepro@<PC の IP> -t ~/agent_dashboard/scripts/dash
```

`scripts/dash` は tmux セッション `dash` に繋ぐ（無ければ作る）。
SSH が切れても中は動き続けるので、入り直して同じコマンドを打てば元の画面に戻る。

## 外出先から

上記は同じ LAN にいる前提。携帯回線から使うなら、ルータのポート開放ではなく
**Tailscale** を勧める。PC とスマホに入れるだけで、WSL の IP が変わる問題も、
ポート開放の危険も避けられる。

## 画面の狭さ

一覧は幅に応じて列を落とす。最小 36x14 まで動く。

| 幅 | 出る列 |
|---|---|
| 124 以上 | 全部（モデルまで） |
| 90 前後 | 経過・タスク・トークン・印 |
| 70 前後 | 状態・コンテキスト・作業内容 |
| 45 以下 | セッション名・コンテキスト（数字だけ）・作業内容 |

会話画面は幅に合わせて折り返すので、狭くても読める。
