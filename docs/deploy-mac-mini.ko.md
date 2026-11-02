# 맥미니 상시 서버 배포 가이드 (원격 호스트)

맥미니처럼 늘 켜 두는 Mac에 AI 홀덤을 띄워 두고, 호스트가 노트북·폰·태블릿 어디서든 브라우저로 로그인해 게임을 진행하는 절차다. 기능 설명과 옵션 요약은 [운영 가이드의 "상시 서버와 원격 호스트"](operations.ko.md#상시-서버와-원격-호스트)에 있고, 이 문서는 처음부터 끝까지 따라 하는 순서다.

```
[호스트 기기: 폰·노트북]  --Tailscale(기기 키)-->  [맥미니]
   https://<맥미니 MagicDNS 이름>:8898  ── 비밀번호 로그인 ──>  원격 호스트 리스너(HTTPS)
                                                              루프백 로비(맥미니 안에서만)
[참가자]  --같은 LAN 또는 tailnet-->  http://<주소>:8899/join  참가자 리스너
```

- 원격 호스트 리스너는 서버의 **Tailscale IP에만** 묶는다. 그래서 tailnet에 들어온 기기만 로그인 화면에 닿는다. 앱 비밀번호가 두 번째 층이다.
- "어느 기기든"은 **Tailscale 앱을 켠 기기**라는 뜻이다. 공유기 포트를 열어 인터넷에 직접 공개하지 않는다.
- 아래 명령은 맥미니의 **서비스를 돌릴 사용자 계정**으로 터미널에서 실행한다(관리자 권한이 필요한 줄은 `sudo`로 표시했다).

## 빠른 순서

1. 맥미니 전원·로그인·원격 접속 설정 (§1)
2. Homebrew·Node·저장소·(선택) LLM CLI 설치 (§2)
3. Tailscale 설치, MagicDNS·HTTPS 인증서 켜기 (§3)
4. 인증서 받기 (§4) → 호스트 비밀번호 정하기 (§5)
5. 터미널에서 한 번 띄워 폰으로 로그인 확인 (§6)
6. launchd 상시 실행 + 인증서 매일 갱신 등록 (§7)
7. 호스트 기기에서 접속 (§8)

각 단계를 어떻게 확인했는지는 [§11 확인 기록](#11-확인-기록)에 있다.

## 1. 맥미니 기본 설정

### 1.1 잠자기와 전원

**시스템 설정 > 에너지(Energy)** 에서 다음을 켠다(모델에 따라 일부 항목이 없을 수 있다).

- 디스플레이가 꺼져도 자동으로 잠자지 않음 (Prevent automatic sleeping when the display is off)
- 네트워크 접근 시 깨우기 (Wake for network access)
- 정전 후 자동으로 시동 (Start up automatically after a power failure)

터미널로는 다음과 같다(`pmset` 키 이름은 macOS 매뉴얼에서 확인).

```bash
sudo pmset -a sleep 0 disksleep 0 womp 1 autorestart 1
pmset -g | grep -E ' (sleep|disksleep|womp|autorestart) '
```

### 1.2 재부팅 뒤 로그인 — 자동 로그인과 FileVault

앱은 **LaunchAgent**(로그인한 사용자 세션에서 도는 launchd 작업)로 돌린다. 그래서 재부팅 뒤 **누군가 그 계정으로 로그인해야** 앱이 뜬다. claude CLI 자격도 로그인 키체인에 있어 로그인 세션 안에서만 열린다.

- Apple 안내대로 **FileVault가 켜져 있으면 자동 로그인을 쓸 수 없다.** `fdesetup status`로 확인한다.
- 두 가지 중 고른다.
  - **FileVault 유지(권장).** 정전·업데이트로 재부팅되면 화면 공유나 직접 연결로 한 번 로그인한다. 디스크 보호가 유지된다.
  - **FileVault를 끄고 자동 로그인.** 시스템 설정 > 사용자 및 그룹 > 자동으로 로그인. 재부팅만으로 앱이 뜨지만, 맥미니를 가져간 사람이 그 계정에 바로 들어간다.

### 1.3 관리용 원격 접속

비밀번호를 잊었거나 서비스가 안 뜰 때는 브라우저로 고칠 수 없다. 맥미니에 셸로 들어갈 길을 하나 열어 둔다.

- **시스템 설정 > 일반 > 공유 > 원격 로그인** 을 켜고, "다음 사용자만 허용"으로 이 계정만 고른다.
- 접속은 tailnet 안에서 `ssh <계정>@<맥미니 MagicDNS 이름>`(Tailscale을 켠 기기에서).

### 1.4 방화벽

`/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`가 켜짐(enabled)이면, node가 들어오는 연결을 받도록 허용한다. 방화벽이 켜진 상태에서는 확인하지 못했다(§11). 허용 대화상자가 맥미니 화면에 뜰 수도 있으니, 처음 한 번은 화면 공유로 확인한다.

```bash
NODE_REAL=$(realpath "$(command -v node)")
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_REAL"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_REAL"
```

`brew upgrade node` 뒤에는 실제 경로가 바뀌므로 다시 실행한다.

## 2. 소프트웨어 설치

### 2.1 Homebrew·Node·저장소

```bash
# Homebrew가 없으면 https://brew.sh 의 설치 명령을 먼저 실행한다.
brew install node git          # Node 20 이상
node --version
git clone https://github.com/Sungmin-Cho/AI-Holdem.git ~/AI-Holdem
cd ~/AI-Holdem && npm ci
```

경로는 Homebrew 기준이다(Apple 실리콘 `/opt/homebrew/bin`, Intel `/usr/local/bin` — §7의 plist `PATH`에 둘 다 넣었다). nvm 등으로 설치했다면 plist의 node 경로와 `PATH`를 그 경로로 바꾼다.

### 2.2 LLM CLI (선택)

기본 게임(로컬 정책 상대)은 LLM 없이 돈다. LLM 상대나 코치·리뷰 설명을 쓰려면 서비스 계정에서 CLI에 로그인해 둔다.

```bash
claude auth status     # Claude Code — 로그인 키체인
codex login status     # Codex — ~/.codex/auth.json
```

로그인 안 됐으면 각각 `claude auth login`, `codex login`. claude 자격은 키체인에 있어 §1.2의 로그인 세션이 필요하다. codex는 파일 자격이다.

## 3. Tailscale

### 3.1 설치

- 맥미니에 Tailscale을 설치하고 로그인한다. Tailscale은 **Standalone판**(홈페이지 다운로드)을 기본으로 권하고, App Store판과 함께 설치하지 말라고 한다. 어느 판이든 GUI 앱에 CLI가 들어 있다.

  ```bash
  TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  "$TS" status | head -3
  ```

- 호스트로 쓸 기기(폰·노트북)에도 Tailscale을 설치하고 **같은 계정(tailnet)**으로 로그인한다.

### 3.2 MagicDNS와 HTTPS 인증서 켜기

Tailscale 관리 콘솔의 **DNS** 페이지에서 MagicDNS를 켜고, 아래의 **HTTPS Certificates**를 켠다.
- 켜면 `tailscale cert`를 실행한 기기의 이름이 공개 인증서 투명성 로그에 남는다(Tailscale 안내). 기기 이름에 민감한 정보를 넣지 않는다.
- 인증서는 Let's Encrypt 90일짜리다. 너무 자주 요청하면 발급 한도에 걸린다(§7.2는 하루 한 번만 받는다).

### 3.3 이름과 주소 확인

```bash
TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
NAME=$("$TS" status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')
IP=$("$TS" ip -4)
echo "$NAME $IP"      # 예: mini.tail1234.ts.net 100.101.102.103
```

`"$TS" cert`를 인자 없이 실행하면 쓸 수 있는 이름을 알려 준다("For domain, use …"). HTTPS 인증서가 꺼져 있으면 그렇다고 말한다.

## 4. 인증서 받기

저장소의 스크립트로 받는다.

```bash
cd ~/AI-Holdem
scripts/macmini/renew-tailscale-cert.sh "$NAME" "$HOME/holdem-tls"
# updated: notAfter=…   (두 번째부터 바뀐 게 없으면 unchanged: …)
```

스크립트가 하는 일:
- `tailscale cert --cert-file - --key-file - <이름>` **한 번**으로 인증서와 키를 함께 받는다. 그래서 둘이 항상 짝이 맞는다.
- 표준 출력으로 받으므로 App Store판 CLI의 샌드박스 문제를 피한다. 그 CLI가 파일 경로에 직접 쓰면 실제로는 `~/Library/Containers/…/Data` 아래로 간다.
- 인증서와 키의 공개키가 같은지 확인한 뒤에만 `~/holdem-tls/host.crt`(644)·`host.key`(600)를 바꾼다.

## 5. 호스트 비밀번호

```bash
cd ~/AI-Holdem
node tools/app-service.js host-password "$HOME/AI-Holdem/game"
# 새 원격 호스트 비밀번호(12자 이상):     ← 입력은 화면에 보이지 않는다
# 한 번 더 입력:
```

- store 경로는 절대 경로다. 위 예는 `start game`의 기본 store(`저장소/game`)다.
- 다시 실행하면 비밀번호가 바뀌고, 이전 비밀번호로 로그인한 세션은 모두 끊긴다. 서비스 재시작은 필요 없다.

## 6. 터미널에서 한 번 띄워 확인

launchd에 맡기기 전에 직접 띄워 본다.

```bash
cd ~/AI-Holdem
node tools/app-service.js serve "$HOME/AI-Holdem/game" --player-runtime codex \
  --remote-host-port 8898 --remote-host-listen "$IP" --remote-host-name "$NAME" \
  --remote-tls-cert "$HOME/holdem-tls/host.crt" --remote-tls-key "$HOME/holdem-tls/host.key"
# remote host: https://mini.tail1234.ts.net:8898/
```

1. 폰에서 Tailscale을 켜고 출력된 주소를 연다.
2. 로그인 화면에 비밀번호를 넣는다. 로비가 열리면 성공이다.
3. 확인했으면 터미널에서 Ctrl-C로 끝낸다.

- `--player-runtime`은 LLM 상대를 쓸 때의 기본 런타임이다(`codex` 또는 `claude`).
- 시작하지 않으면 마지막 줄의 오류 코드를 [§10](#10-문제-해결)에서 찾는다.

## 7. launchd 상시 실행

### 7.1 앱 서비스

§3.3의 `NAME`·`IP`가 셸에 있는 상태에서 실행한다.

```bash
REPO="$HOME/AI-Holdem"; STORE="$REPO/game"; TLS="$HOME/holdem-tls"
NODE=$(command -v node)
PLIST="$HOME/Library/LaunchAgents/com.ai-holdem.app.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ai-holdem.app</string>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>tools/app-service.js</string>
    <string>serve</string>
    <string>$STORE</string>
    <string>--player-runtime</string><string>codex</string>
    <string>--remote-host-port</string><string>8898</string>
    <string>--remote-host-listen</string><string>$IP</string>
    <string>--remote-host-name</string><string>$NAME</string>
    <string>--remote-tls-cert</string><string>$TLS/host.crt</string>
    <string>--remote-tls-key</string><string>$TLS/host.key</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$STORE/.app/launchd.log</string>
  <key>StandardErrorPath</key><string>$STORE/.app/launchd.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST"
launchctl bootstrap gui/$(id -u) "$PLIST"
sleep 3
launchctl print gui/$(id -u)/com.ai-holdem.app | grep -E '^\s+(state|pid|last exit code) '
tail -3 "$STORE/.app/launchd.log"     # remote host: https://…:8898/
```

- **`PATH`가 꼭 필요하다.** launchd 기본 `PATH`는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이라 node·claude·codex를 못 찾는다.
- **`KeepAlive.SuccessfulExit=false`.** 비정상 종료(크래시, 시작 실패)는 약 10초 뒤 다시 띄우고, 정상 정지(`npm run app:stop`)는 그대로 멈춰 둔다.
- **Tailscale이 아직 안 떴을 때.** 부팅 직후 Tailscale보다 앱이 먼저 뜨면 바인드 주소가 없어 `EADDRNOTAVAIL`로 끝난다. launchd가 약 10초마다 다시 시도해 Tailscale이 올라온 뒤 뜬다.
- **plist를 고쳤을 때.** 먼저 `launchctl bootout gui/$(id -u)/com.ai-holdem.app` 한 뒤 다시 `bootstrap`한다(이미 등록된 레이블은 `bootstrap`이 거부한다).

### 7.2 인증서 매일 갱신

```bash
RENEW="$HOME/Library/LaunchAgents/com.ai-holdem.cert-renew.plist"
cat > "$RENEW" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ai-holdem.cert-renew</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$REPO/scripts/macmini/renew-tailscale-cert.sh</string>
    <string>$NAME</string>
    <string>$TLS</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>$TLS/renew.log</string>
  <key>StandardErrorPath</key><string>$TLS/renew.log</string>
</dict>
</plist>
EOF
plutil -lint "$RENEW"
launchctl bootstrap gui/$(id -u) "$RENEW"
launchctl kickstart gui/$(id -u)/com.ai-holdem.cert-renew && sleep 5 && tail -2 "$TLS/renew.log"
```

- tailscaled는 인증서 수명의 2/3가 지나면 백그라운드에서 갱신하고, 그다음 호출에서 새 인증서를 돌려준다(Tailscale 소스 확인). 하루 한 번이면 90일 인증서가 만료되기 훨씬 전에 바뀐다.
- 앱은 10분마다 인증서·키의 **내용**을 비교해 바뀌면 재시작 없이 교체한다.
- App Store판을 쓰거나 CLI 위치가 다르면 plist `EnvironmentVariables`에 `TAILSCALE`(CLI 경로)을 넣는다.

## 8. 호스트 기기에서 접속

1. Tailscale을 켠다.
2. `https://<맥미니 MagicDNS 이름>:8898/`을 연다.
3. 비밀번호를 넣으면 맥미니의 로컬 로비와 같은 화면이 열린다. 폰에서는 홈 화면에 추가해 두면 편하다.

- 로그인은 브라우저 탭마다 따로다. 끝낼 때는 **도움말·설정 > 로그아웃**.
- 세션은 2시간 동안 요청이 없거나 로그인 뒤 24시간이 지나면 끝나고, 로그인 화면으로 돌아간다.
- 원격에서는 **앱 정지와 학습실**을 쓸 수 없다. 학습실은 맥미니 앞에서 연다.

참가자를 받을 때(온라인 세션):
- 참가 링크는 참가자 포트 8899다. 같은 LAN의 참가자는 로비가 보여 주는 LAN 주소 링크로 들어온다.
- tailnet 안의 참가자에게 MagicDNS 이름으로 된 링크를 보이려면 §7.1의 `ProgramArguments`에 `--public-host` `<이름>`을 더한다.
- 참가자 포트도 HTTPS로 하려면 `--tls-cert`·`--tls-key`(같은 인증서 파일)를 더한다.

## 9. 운영

| 할 일 | 명령 |
|---|---|
| 상태 | `launchctl print gui/$(id -u)/com.ai-holdem.app \| grep -E '^\s+(state\|pid\|last exit code) '` |
| 로그 | `tail -f ~/AI-Holdem/game/.app/launchd.log` (원격 로그인 기록은 `[remote-host]` 줄, 주소만) |
| 재시작 | `launchctl kickstart -k gui/$(id -u)/com.ai-holdem.app` |
| 정지(다시 안 뜸) | `cd ~/AI-Holdem && npm run app:stop -- "$HOME/AI-Holdem/game"` |
| 다시 띄우기 | `launchctl kickstart gui/$(id -u)/com.ai-holdem.app` |
| 해제 | `launchctl bootout gui/$(id -u)/com.ai-holdem.app` |
| 업데이트 | `cd ~/AI-Holdem && git pull && npm ci && launchctl kickstart -k gui/$(id -u)/com.ai-holdem.app` |
| 비밀번호 변경 | `node tools/app-service.js host-password "$HOME/AI-Holdem/game"` (재시작 불필요, 기존 세션 끊김) |
| 인증서 만료일 | `openssl x509 -in ~/holdem-tls/host.crt -noout -enddate` |

- 서비스가 다시 시작하면(업데이트·크래시·재부팅) 진행 중이던 게임은 저절로 이어지지 않는다. 로비의 **저장된 게임 불러오기**로 이어 간다.
- 맥미니에서 `start game`(에이전트 스킬)을 쓰면, 떠 있는 이 서비스에 연결한다. 새 서비스를 띄우지 않는다.
- 원격 호스트를 끄려면 plist에서 `--remote-…` 옵션을 지우고 `bootout` → `bootstrap` 한다. 남은 `game/.app/host-auth.json`은 원격 리스너가 없으면 쓰이지 않는다.

## 10. 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| launchd.log에 `REMOTE_HOST_LISTEN_REQUIRED`·`REMOTE_HOST_NAME_REQUIRED`·`REMOTE_HOST_TLS_REQUIRED` | plist 옵션 누락 | §7.1 plist 확인 후 `bootout`·`bootstrap` |
| `REMOTE_HOST_TLS_INVALID` | 인증서·키를 못 읽음, 짝 불일치 | §4 스크립트 다시 실행, 경로 확인 |
| `HOST_PASSWORD_NOT_SET` / `HOST_AUTH_INVALID` | 비밀번호 미설정 / 자격 파일 손상 | §5 `host-password` |
| `EADDRNOTAVAIL`이 반복 | 바인드한 Tailscale IP가 없음(Tailscale 꺼짐, IP 바뀜) | Tailscale 상태 확인. `"$TS" ip -4`가 plist 값과 다르면 plist 수정 |
| `EADDRINUSE` | 8898이나 8899를 다른 프로세스가 사용 | `lsof -nP -iTCP:8898 -sTCP:LISTEN` |
| 브라우저 403 `BAD_ORIGIN` | 등록하지 않은 이름·IP로 접속 | `--remote-host-name`의 이름으로 접속(여러 개 등록 가능) |
| 인증서 경고 | 이름이 인증서와 다름, 또는 만료 | MagicDNS 이름으로 접속, `renew.log`·만료일 확인 |
| 로그인 429 `LOGIN_RATE_LIMIT` | 주소별 5회 또는 전체 50회 실패 | 15분 대기 또는 서비스 재시작(잠금은 메모리에만 있음) |
| 재부팅 뒤 안 뜸 | 로그인 전이라 LaunchAgent가 아직 안 돎 | §1.2 — 로그인하면 뜬다 |
| LLM 상대·코치가 안 됨 | CLI 자격 없음, `PATH` 누락 | §2.2 상태 확인, plist `PATH` |

## 11. 확인 기록

2026-11-02, MacBook Pro(Mac17,9, macOS 27.0.1, Node 26.0.0)에서 맥미니 대신 리허설했다. 실제 맥미니와 Tailscale에서는 아직 돌려 보지 않았다.

| 항목 | 방법 | 결과 |
|---|---|---|
| `host-password` TTY 입력 | `expect`로 두 번 입력 | 저장·검증 성공. 이 과정에서 **두 번째 입력이 화면에 찍히는 결함**을 찾아 같은 PR에서 고쳤다(원시 모드를 두 입력 내내 유지) |
| LaunchAgent 환경 | 진단 작업 | `USER`·`HOME`이 설정되고, plist `PATH`로 node·claude·codex를 찾음. `claude auth status`(키체인)·`codex login status` 로그인 상태 |
| `PATH` 없는 launchd | 진단 작업 | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, node·claude·codex 모두 없음 |
| §7.1 plist | `plutil -lint` → `bootstrap`(임시 레이블·시험 인증서, `127.0.0.1`로 Tailscale IP 대신) | 1초 안에 원격 로그인 200, 등록 안 된 Host 403 |
| `start game` 연결 | 서비스가 떠 있을 때 `node tools/app-service.js <store>` | 같은 서비스의 로컬 URL 출력, 새 프로세스 없음 |
| 크래시 복구 | `kill -9` | 약 9초 뒤 launchd가 다시 띄우고 로그인 성공 |
| 정상 정지 | `app:stop` | 20초 동안 다시 안 뜸(`last exit code = 0`) |
| 재시작·해제 | `kickstart -k`, `bootout` | 즉시 재기동, 해제 뒤 프로세스 없음 |
| 바인드 주소 없음 | `--remote-host-listen 192.0.2.123` | `EADDRNOTAVAIL`로 끝나고 launchd가 약 10초마다 재시도(35초에 4회) |
| §7.2 갱신 작업 | 가짜 `tailscale`(인증서·키 출력)로 `kickstart` | launchd 기본 환경에서 `updated:`, `last exit code = 0`, 매일 04:17 등록 |
| 갱신 스크립트 | 시험 `test/macmini-renew-cert.test.js` + ECDSA 키 수동 확인 | 갱신·무변경·교체·짝 불일치 거부·빈 출력 거부 |
| `tailscale cert`·`ip`·`status` | Tailscale 소스(GitHub `cmd/tailscale/cli/cert.go`·`ip.go`, `ipn/ipnstate`, `feature/acme/cert.go`) | 표준 출력(`-`) 지원, App Store판 샌드박스 쓰기 경로, 수명 2/3 지점 백그라운드 갱신, `Self.DNSName`(끝에 점) |
| 에너지 설정 이름·자동 로그인·원격 로그인 | Apple 사용자 안내 | 항목 이름, FileVault 켜짐 시 자동 로그인 불가, 공유 > 원격 로그인 경로 |
| `pmset`·방화벽 명령 | `man pmset`, `socketfilterfw -h` | 키·옵션 존재 확인. 방화벽은 꺼진 상태라 켜진 상태의 동작은 확인 못 함 |

확인하지 못한 것: 실제 Tailscale 인증서 발급·tailnet 접속, 방화벽이 켜진 상태, 자동 로그인 재부팅, 맥미니 특유의 전원 옵션. 처음 배포할 때 §6에서 폰 로그인까지 확인하고, 재부팅 한 번으로 §1.2·§7.1을 확인한다.
