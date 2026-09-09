## L. 기본 진입: 웹 로비

새 게임 요청(`start game`, `/start-game`)은 웹 로비를 연다. 아직 엔진 init이나 플레이어·코치 LLM을 호출하지 않는다. 모드와 AI 수를 고르고 실제 게임을 시작하는 것은 웹 UI의 `게임 시작` 버튼이다.

1. 저장소 루트와 `node --version`(20 이상)을 확인한다.
2. store의 절대 경로를 정한다(기본은 이 저장소의 `game/`). 기존 게임 파일·락·토큰을 직접 수정하지 않는다.
3. `node tools/app-service.js <absolute-store> --player-runtime <host>`를 실행한다. host는 Claude Code=`claude`, Codex=`codex`, Grok=`grok`이다. 서비스가 있으면 검증 후 같은 인스턴스에 연결한다. app-service가 하나의 game-loop를 직접 소유하므로 별도 game-loop 사이드카를 추가 기동하지 않는다.
4. 반환된 `http://127.0.0.1:<port>/#token=...` 링크를 브라우저로 열고 **“게임 로비를 열었습니다. 모드와 AI 수를 선택해 시작하세요.”**라고 보고한다. 링크는 현재 사용자에게만 제공하며 로그·PR·위키에 토큰을 복사하지 않는다.

명시한 모드·AI 수·스택·블라인드·핸드 수·상대 방식·공개 옵션은 로비 기본 선택으로 보존한다. 구조화 JSON 파일을 작성하고 위 명령에 `--setup-file <absolute-json-file>`을 추가한다. 허용 키는 `shared/game-setup.js`의 SETUP_KEYS이며 `aiCount`는 숫자 1~8이다. raw shell 옵션/모델 문장을 JSON 값이나 argv에 끼워 넣지 않는다. 충돌한 옵션은 검증 오류를 보고하고 임의로 버리지 않는다. cash의 칩 단위 `stack`을 명시했다면 `stackBb`를 추가하지 않는다. 로비 토너먼트의 기본 상대 방식은 policy이며 명시 LLM은 유지한다.

웹 메뉴는 일시정지, 계속하기, 같은 설정의 새 게임, 모드 선택, 게임 종료를 제공한다. 메뉴 닫기·Escape·모드 선택에서 돌아가기는 자동 재개가 아니다. 모드 변경/재시작/종료 확인은 웹 UI에서 처리한다. 앱 종료는 `npm run app:stop -- <absolute-store>`이고 학습 서비스는 독립적으로 유지된다.

기존 standalone loop가 살아 있으면 로비는 외부 실행 상태를 표시한다. 해당 loop를 탈취하거나 강제 종료하지 않는다. 인증된 앱 서비스가 있다면 `resume` 요청도 로비로 연결하여 웹에서 계속하도록 한다. 앱 서비스가 없는 기존 standalone 게임에 사용자가 **명시적으로 legacy 직접 실행 또는 `resume`을 요청했을 때만 아래 기존 §1~§7 절차를 사용한다**. 새 게임 요청에 아래 직접 실행 절차를 적용하지 않는다. 중도 종료는 `phase: aborted`, 정상 완료는 `phase: done`이며 둘을 혼동하지 않는다.
