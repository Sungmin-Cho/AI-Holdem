# 리플레이 보관함과 내 시점 복기 설계

작성: 2026-10-15 · 작성 모델: gpt-6-astra · 단계: 구현 전 설계·계획 (검토 결과는 replay-study-review.md 참조)

준비 상태: 조건부. 3차 독립 리뷰는 PASS_WITH_CHANGES/PASS였고, 아래 최종 명확화는 작성자가 반영했다. 이 마지막 수정본은 독립 재리뷰 전이며 구현 gate의 증거가 필요하다.

기준 코드: `b239dd72261070f8834ee36d3d7129f40f0fb546`.
브랜치: `Sungmin-Cho/replay-study-library`. 이 문서는 구현 전 설계이며 제품 구현 완료를 뜻하지 않는다.

## 1. 목적과 1차 범위

게임을 마친 뒤 저장된 핸드를 찾아 당시 내 정보로 결정을 돌아본다. 기존 테이블 재생기를 재사용하고, 학습실에서 게임 → 핸드 → 복기로 연결한다.

| 포함 | 동작 |
|---|---|
| 게임 보관함 | 현재 store의 관리형 세션 목록과 핸드 목록, 페이지 이동, 새로고침 |
| 완료 핸드 재생 | 과거 게임 및 진행 중 게임의 이미 완료된 핸드 읽기 |
| 내 시점 | 기본값. 내 패와 커서까지 공개된 보드/액션만 표시 |
| 전체 복기 | 사용자가 명시적으로 선택하면 저장된 공개 정책 범위에서 결과·상대 패 공개 |
| 내 결정 이동 | 이전/다음 내 결정 직전으로 이동, 자동 재생 중 내 결정 직전 정지 |
| 설명 | 액션 기록의 내 의도 메모와 기존 사실 카드. 전체 복기에서 허용된 기록 사유 |

1차에서 북마크·검색/손익 필터·새 답안 입력/채점·대안 액션 이후 시뮬레이션·새 LLM 호출·공유 링크·참가자용 보관함은 제외한다. 과거 코치/학습 평가를 임의 JSON에서 다시 꺼내 붙이지 않는다. 기존 라이브 복기의 학습 카드 연결은 보존하고, 보관함의 코치/평가 연결은 검증된 독립 조회 계약을 갖추는 후속 작업이다.

지원 저장소는 `.session-store/sessions/<gameId>`다. legacy `--game-dir` 및 `archive/`를 재귀 탐색하거나 변환하지 않는다. 해당 기록만 있는 경우 “이전 형식의 기록은 아직 보관함에서 지원하지 않습니다”를 표시한다. 게임 삭제/이동/정리 기능은 없다.

## 2. 현재 구현과 설계 필요성

- `server/public/app.js:914`의 로그 → 복기 및 `replayer.js`의 테이블/재생/속도/스트리트 이동이 있다.
- `replay-model.js:buildReplaySteps`는 액션을 상태로 재구성하고 팟·스택·순서·결과를 대조한다. 실패 시 현재 UI는 텍스트 목록을 사용한다.
- `shared/hand-replay.js:replayRecord`는 저장 설정 `replayReveal`과 인간 좌석을 받아 공개 가능한 복기 DTO를 만든다.
- `engine/session-catalog.js`는 영구 세션 디렉터리와 단일 current selector를 제공하지만 과거 세션 목록 API는 없다.
- `tools/drill-server.js:createDrillHandler`는 독립 학습 서비스의 인증·정적 파일·API를 담당한다. 게임 relay 종료와 무관하게 읽기 화면을 제공하기 알맞다.
- 현재 복기에는 승자 헤더, 처음부터 보이는 공개 허용 패, 미래 액션 타임라인, 결과와 설명이 있다. 내 시점은 카드 CSS만 숨겨서는 구현되지 않는다.

설계가 필요한 이유는 새 과거 기록 조회 권한, 완료 여부 판정, 공개 정책, 모든 표시 경로의 가리기, 기존 재생기와 독립 학습실 사이의 모듈 경계 때문이다. 게임 규칙/저장 스키마 변경이나 마이그레이션은 필요하지 않다.

## 3. 사용자 흐름

1. 기존 로비의 `학습실 열기` → 학습실의 `플레이 기록` 링크 → 같은 학습 서비스의 `/replay.html`.
2. 새 페이지는 기존 학습 토큰을 URL fragment로 전달받고 동일 `x-drill-token` 인증을 사용한다. query/log/외부 링크에 토큰을 넣지 않는다. 돌아가기 링크도 fragment만 이용한다.
3. 게임 목록은 최근 저장 시각, 게임 종류, 좌석 수, 완료/중단/미종료 상태를 보여준다. 시각은 `state.json`의 파일 수정 시각이므로 “최근 저장”으로 표시하고 시작 시각으로 부르지 않는다. 복사된 파일의 실제 플레이 시각은 알 수 없다. 미종료는 현재 프로세스가 실행 중이라는 뜻이 아니다.
4. 게임 선택 → 핸드 번호·블라인드·내 위치 목록. 기본 내 시점에서는 손익·승자·최종 팟·최종 보드를 목록에도 표시하지 않는다.
5. 핸드 선택 → `내 시점`으로 처음부터 열기. `이전 내 결정`/`다음 내 결정`, 기존 재생 컨트롤, `전체 복기 보기`를 제공한다.
6. `전체 복기 보기`는 현재 핸드에만 적용한다. 다른 핸드/게임/페이지 새로고침에서는 내 시점으로 초기화한다. 다시 내 시점으로 바꾸면 첫 단계로 돌아가고 재생을 멈춘다.
7. 과거 기록 조회는 진행 중인 게임을 일시정지/재개하지 않는다. UI에 “기록을 보는 동안 진행 중인 게임은 계속됩니다”를 표시한다. 학습실 진입 전 일시정지는 기존 로비 기능이다.

직접 게임 재개·current 변경·게임 relay 재기동 없이 열 수 있어야 한다. 새 로비 API는 만들지 않고 기존 학습실 진입을 재사용한다.

## 4. 구조와 소유권

| 모듈 | 책임 |
|---|---|
| 신규 `tools/replay-library.js` | store 내부 세션/핸드의 제한된 읽기, 검증, 목록/상세 DTO 투영 |
| `tools/drill-server.js` | 기존 인증을 지난 GET API, 오류 매핑, 정적 파일 allowlist |
| 신규 `server/drill-public/replay.html`, `replay.js`, `replay.css` | 목록, 로딩/오류/페이지 이동, 선택 세대, 독립 페이지 상태 |
| 신규 `server/public/replay-controller.js` | 재생·속도·커서·내 결정 이동·취소/해제. DOM/네트워크 없는 제어 |
| 신규 `server/public/replay-perspective.js` | 원본 재생 모델 → 현재 관점의 표시 전용 모델 |
| 기존 `replay-model.js`, `replayer.js`, `replay-format.js` | 산술 검증, 테이블, 표시. 선택적 context로 확장 |

기존 app.js의 타이머/커서 로직을 공통 controller로 옮기고 두 진입점이 사용한다. 라이브용 기본 옵션은 기존 전체 복기 동작이며 새 보관함은 내 시점을 명시한다. 게임 API/실시간 SSE/액션 핸들러를 보관함에 import하지 않는다. 미니 테이블 CSS는 필요한 규칙만 공통 파일로 추출해 두 페이지가 로드한다. 테이블 전체 앱/전체 CSS를 학습실에 임베드하지 않는다.

신규 페이지는 drill.js를 실행하지 않는다. 보관함 방문이 드릴 복원/새 문제 생성/프로필 재집계로 이어지지 않아야 한다.

표시 데이터 흐름은 `검증한 전체 replay → 전체 buildReplaySteps → 사실 카드/formatting → 관점 projection → renderer`다. 사실 카드는 전체 모델과 전체 검증 replay를 사용해 현재 replayFactsLine의 decision 매칭·시드를 보존한다. 계산은 필요할 때 원본 단계 index별로 캐시하고 projection이 표시 시점에만 문자열을 내보낸다. renderer 안의 replayFactsLine 호출은 외부 facts provider로 옮긴다. renderer는 projected holes/rows/현재 상태만 받고 원본 replay·전체 모델을 조회하지 않는다. 같은 액션의 사실 줄은 두 관점에서 동일하다.

replayer는 테이블 DOM을 한 번 만들고 projection 갱신 시 타임라인 행을 원본 step.index 키로 추가/제거한다. 전체 재마운트로 커서를 진행하지 않는다. 컨트롤 영역은 관점 전환 시 해당 관점의 버튼 집합으로 재구성할 수 있다. 내 시점은 prefix만, 전체 복기는 전체 행을 만든다. 포커스 키·타임라인 내부 스크롤을 보존하고 제거되는 요소의 포커스는 활성 재생 버튼, 없으면 전체 복기 버튼으로 옮긴다. 전체 길이/미래 결정 탐색은 renderer 밖 controller만 소유하며 renderer에는 관점에 맞는 controls 상태를 전달한다.

`formatReplay`에 `feedback:'live'|'omit'` 옵션을 추가한다(기본 live). 보관함은 omit으로 모든 row.coach/row.study 및 coachSummary를 null로 만들고 대기 문구·학습 카드도 생성하지 않는다. 라이브의 실제 피드백과 대기 동작은 유지한다.

정적 자원 경로는 학습 서비스 `tools/drill-server.js`의 STATIC, 앱 호스트/공개 참가자 리스너가 공유하는 `tools/app-server.js:serveAsset`, legacy relay의 `server/server.js:serveStatic`을 모두 확인한다. 후자의 두 서버는 public 파일을 경로 규칙으로 서빙하므로 신규 public JS/CSS에 별도 파일명 allowlist 추가는 현재 필요 없고, shared import만 기존 허용 목록을 검사한다. study STATIC에는 새 페이지·공통 모듈의 재귀 import를 명시 추가한다. 구 study handler 호환을 위해 **기존 drill.html/drill.js에는 새 정적 import나 CSS 링크를 추가하지 않고** 기존 허용 자원으로 링크 gate를 구현한다.

공통 live 클라이언트의 shared import 폐포는 기준 커밋 app-server/relay 두 허용 목록의 교집합 안에 둔다. 구 프로세스의 shared 목록 확대를 전제로 새 public 파일을 배포하지 않는다. 새 보관함 전용 자원은 새 study STATIC에 추가할 수 있지만 기존 drill의 import 폐포는 늘리지 않는다. 세 서버별 실제 import 해석을 테스트한다.

## 5. 읽기 계약과 데이터 무결성

### 5.1 경로와 예산

- root는 서비스 시작 시 검증된 store다. API에는 경로를 받지 않고 UUID v4 소문자 gameId와 양의 안전 정수 handNo만 받는다. 핸드 파일명은 서버가 `hand-${String(handNo).padStart(4,'0')}.json`으로 구성한다. 현재 엔진의 private `handFile`(`engine/state.js:68`)과 같은 규칙이며, 엔진 writeHandArchive로 만든 1/9999/10000번 파일을 새 reader로 읽는 패리티 테스트로 고정한다.
- `.session-store`, `sessions`, 세션 디렉터리 및 `hands`는 실제 디렉터리인지 검사한다. 디렉터리 순회도 `opendir`의 제한된 열거와 조상 identity 재검사를 사용한다. staging/알 수 없는 이름은 목록에 넣지 않는다.
- 파일 읽기는 `openContained(storeDir, [...segments], {maxBytes})` 사용. symlink/hardlink/특수 파일/읽는 중 교체를 거부한다. 이 helper의 inspect-open-reinspect는 악성 동시 로컬 쓰기에 대한 완전한 openat 봉쇄가 아니라는 기존 한계를 유지한다. 거부한 바이트를 반환하지 않는다. reader wrapper가 읽기 전후의 조상 identity 및 leaf dev/ino/size/mtime/ctime를 대조해, 조상은 같고 leaf만 교체됐으며 양쪽 모두 안전한 일반 단일 링크 파일임을 확인하면 그 요청은 REPLAY_BUSY(429)로 끝낸다. 자동 재시도 없이 UI 재시도/새로고침으로 새 읽기를 시작한다. 관측이 불충분하거나 경로/타입/링크가 안전하지 않으면 기존 unavailable 거부를 유지한다. busy는 영구 손상으로 저장/캐시하지 않고 목록에서도 “기록을 읽는 중 변경되었습니다 · 다시 시도”로 표시한다.
- 기본/최대 페이지 크기: 게임 25/50, 핸드 50/100. 열거 상한 10,000개 디렉터리 항목, 유효 세션 1,000개, 핸드 번호 10,000. state 2 MiB, 단일 hand 256 KiB, 단일 응답 1 MiB. 상한 초과는 명시적 오류이며 잘린 목록을 전체라고 표시하지 않는다.
- 게임 목록은 이름·state 파일 stat만 수집해 수정 시각 내림차순/gameId 오름차순 정렬하고 요청 페이지의 state만 읽는다. 파일 1건의 읽기/JSON parse마다, 디렉터리 항목 확인은 25건마다 setImmediate로 event loop에 양보한다. 페이지당 state 총 읽기 예산 16 MiB. 요청당 진행 중 build 하나, 같은 페이지 중복 요청은 합치고 서비스 전체 library 작업 동시 2개/초과 429로 제한한다. 상태 읽기를 yield에서 보류한 동안 health 요청이 먼저 완료되는 통합 테스트와 최대 허용 파일 부하의 응답시간 측정을 수행한다. 테스트 대기는 기존 HTTP_WAIT_MS 플랫폼 예산을 사용하며 관측값을 제품 SLA로 주장하지 않는다.
- v1에는 디스크 인덱스/영구 캐시가 없다. offset pagination은 매 요청의 최신 목록이며 라이브 변경 시 중복/이동할 수 있어 새로고침을 제공한다. 전체 스냅샷 일관성이나 완벽한 시간순 이력을 주장하지 않는다.

핸드 목록은 state 포함 요청당 32 MiB의 읽기 예산을 둔다. 최대 100개×256 KiB와 state 2 MiB를 수용하되 파일마다 양보한다. 읽기 중 정상 atomic rename과 겹치면 busy로 재시도 가능해야 하며 POSIX/Windows 통합 fixture로 확인한다.

### 5.2 완료와 출처

- `state.json`의 알려진 schemaVersion 1/2, seats/config/handNo/lastHand 구조를 읽기 전용 검증한다. 로더의 저장/업그레이드 부수 효과를 사용하지 않는다. 지원하지 않는 schema는 unsupported로 표시한다.
- 완료 핸드의 상한은 유효한 `state.lastHand.handNo`다. lastHand가 null이고 handNo가 0 또는 첫 진행 핸드이면 완료 0; 그 외 근거가 없으면 `REPLAY_UNAVAILABLE`이다. abort의 현재 미완료 hand나 audit 파일은 완료로 세지 않는다.
- 상세는 상한 이내의 `hands/hand-NNNN.json`을 우선한다. **파일이 ENOENT이고 번호가 state.lastHand와 같을 때만** lastHand로 fallback한다. 손상·권한 오류·지원하지 않는 스키마를 fallback으로 숨기지 않는다. archive 복구/재생성은 하지 않는다.
- 목록의 각 손상/누락 핸드는 번호와 unavailable 코드로 남기며 다른 핸드를 막지 않는다. 세션 state가 손상된 경우 해당 세션 행만 unavailable이다. 카탈로그 루트가 안전하지 않으면 요청 전체를 거부한다.
- 한 요청은 한 state 스냅샷을 사용한다. 활성 세션에서 완료 상한 이후 archive는 공개하지 않는다. record.handNo, 좌석 ID, 숫자/카드/배열 구조를 검증한 뒤 replayRecord로 투영한다.
- 상세의 `revision`은 **최종 공개 replay DTO와 gameId/handNo/viewerId/mode/reveal/seats 표시 메타데이터만** 정규화한 SHA-256이다. 원본 record·비공개 필드·state 파일 hash/mtime는 입력에 넣지 않는다. 공개 투영은 같고 숨긴 패/다른 인간의 note만 다른 두 record의 revision은 동일해야 한다. 공개 액션이 바뀌면 달라져야 한다. gameId/handNo/revision을 캐시·선택의 키로 삼고 다른 게임의 같은 handNo를 혼합하지 않는다. 응답이 늦게 도착하면 브라우저 요청 세대 번호로 폐기한다.

세션 내 좌석 ID/name/kind의 출처는 검증한 state.seats다. 현재 createGame이 좌석을 만들고(`engine/hand.js:121`), 탈락은 seat.out만 바꾸며 배열에서 제거하지 않는다(`engine/hand.js:704`). 방이 잠긴 동안 참가자 제거는 거부되고 leaveEliminated는 토큰/접속 정보만 갱신하며 복구 roster를 유지한다(`tools/room-manager.js:305-328`). 이 세션 내 불변 전제를 P1의 탈락·이탈·재접속 fixture로 고정한다. 과거 기록과 seat ID가 불일치하면 현재 방의 roster로 보충하지 않고 unavailable이다. 표시 name은 엔진에 저장된 이름이며 정책 ID/아키타입 객체를 추가하지 않는다.

### 5.3 공개 권한

학습 토큰은 기존 로컬 호스트 학습 권한이다. app/participant/spectator 토큰을 대체 인증으로 받지 않는다. 신규 GET도 기존 auth→sameOrigin→beforeRequest 순서 뒤에서 파일을 읽는다. public participant 포트에 새 보관함 API를 만들지 않는다. 재생기에 필요한 공용 정적 파일 제공과는 구분한다.

`replayRecord(record, {reveal: savedReplayReveal, humanIds})`를 유일한 카드 투영기로 재사용한다. 옵션 누락/불명확 상태에서 `all`을 기본으로 하지 않는다. 알려진 구형 replayReveal 누락은 기존 엔진처럼 `showdown`; 잘못된 명시 값은 unsupported다.

좌석을 먼저 검증한다. `user`는 인간, `h1`…`h8`는 인간이어야 하며, `p1`…`p8`만 AI 후보다. kind가 없던 solo 구형 기록만 user/pN 규칙으로 해석한다. hN의 kind 누락·AI 표기, 중복/알 수 없는 ID, record에만 있는 좌석은 상세를 거부한다. 기존 helper가 kind 누락 hN을 AI로 해석할 수 있으므로 이 검증 없이 humanIdsOf를 호출하지 않는다. `all`도 다른 인간의 미공개 패/메모를 풀지 않는다.

응답은 닫힌 DTO로 새로 구성한다. state/record spread 금지. replayRecord 내부에는 winner spread와 decision 하위 값 복제가 있으므로 그 결과도 **중첩 객체까지 닫힌 v1 스키마로 재투영/검증**한다. 중첩 winner/decision/chosenAction/assistance에 들어간 추가 canary도 내보내지 않는다. sessionToken, seed/deck, 실제 경로, JEV 진단/확률, 다른 인간의 note, 원본 정책 정체를 넣지 않는다. 서버가 권한 밖 정보를 제거한 뒤 클라이언트의 내 시점 표시를 적용한다.

### 5.4 보관함 replay DTO 필드

아래 표가 보관함 v1 출력 allowlist다. 원본 입력의 추가 필드는 내보내지 않고, 게임 산술/카드/좌석/버전 필드의 잘못된 타입은 거부한다. 보조 텍스트와 decisions의 예외는 표 아래에 정의한다. 배열/객체는 매번 새로 구성한다. `pid`는 검증한 세션 좌석 ID, 칩/카운트는 음수가 아닌 안전 정수, 카드 코드는 `[2-9TJQKA][shdc]`다. record의 known version 계약 검증은 이 최소 투영 전에 유지한다. 위치/레벨/규칙 값이 없는 구형 기록은 아래 선택 필드를 생략한다.

| 경로 | 타입·필수 여부 |
|---|---|
| schemaVersion, reveal, handNo | 필수: 1, all 또는 showdown, 양의 안전 정수 |
| level, button, blinds | level 선택 정수; button 필수 pid; blinds 필수 양의 정수 2개 |
| board, folded, allIn | 필수: 카드 배열(0/3/4/5개), 중복 없는 pid 배열, 중복 없는 pid 배열 |
| startStacks, endStacks | 필수: pid→칩. start는 딜된 좌석, end는 세션 좌석. 시작 좌석은 end에도 존재 |
| posts[] | 필수 배열. 각 항목은 playerId:pid, amount:칩, allIn:boolean만 |
| uncalledReturns | 필수 pid→칩 객체(없으면 빈 객체) |
| holes | 필수 객체. 공개 투영기가 허용한 pid→정확히 카드 2개만 |
| positions | 선택 pid→1~16자 위치 문자열 |
| rulesVersion | 선택. 알려진 2만 출력; 누락은 기존 legacy 규칙, 알 수 없는 명시 버전은 unsupported |
| showdown | 필수 null 또는 {reveals,mucks} |
| showdown.reveals[] | playerId:pid, cards:카드 2개, 선택 handName:1~128자 문자열만 |
| showdown.mucks | 중복 없는 pid 배열 |
| pots[] | 필수 배열. potIndex:정수, amount:칩, eligible:pid 배열, winners 배열만 |
| pots[].winners[] | playerId:pid, share:칩만 |
| actions[] | 필수 배열. 필수 playerId:pid, action:fold/check/call/raise; 나머지는 아래 선택 필드만 |
| actions[].decisionId, street, amount | 선택: 1~128자 ID, preflop/flop/turn/river, 칩. call/raise의 amount는 필수 |
| actions[].potTotal/callAmount/minRaiseTo/maxRaiseTo/currentBet/board | 선택 칩 필드 및 카드 배열. 기존 숫자 대조에 사용 |
| actions[].forced, reasonKind | 선택 true, forced/policy/model/none/human/hidden 중 하나 |
| actions[].reason, note | 선택 UTF-8 4096바이트 이하 문자열. reason은 공개 투영기가 허용한 model 사유만, note는 user 액션만 |
| decisions[] | 필수 배열(원본 누락은 []). user 결정만 순서 보존; 항목은 decisionId:1~128자 문자열, potBefore:칩, toCall:칩만. 유효한 원본 필드만 선택적으로 출력 |

decisions의 나머지 필드(holeCards/chosenAction/assistance/forced/position 등), hintContractVersion, dealSelection/dealSelectionContractVersion 및 모든 표 밖 키는 보관함 응답에서 제외한다. 이미 공개된 내 패는 holes.user에서 읽고 사실 계산은 action+전체 모델과 decisions의 세 필드를 쓴다. 편향 딜/힌트 provenance를 지우거나 수정하는 저장 변경은 없으며 이 화면은 점수/실력 평가를 생성하지 않는다. 기존 라이브 replayRecord 응답은 축소하지 않는다.

decisions는 원본의 user 결정 항목 수/순서를 보존하고 무효 선택 필드만 생략한다(빈 객체 허용). reason/note는 타입 불일치나 4096바이트 초과이면 그 텍스트 필드만 생략한다. 현재 엔진 작성 경로는 shared/free-text.js와 engine/cli.js:572,580의 160자 및 바이트 상한을 사용하므로 정상 작성 기록을 이 제한으로 잘라내지 않는다. 유효 기록의 facts는 기존 live 계산과 같은 입력/시드를 보존한다. 잘못된 decisionId를 가진 기록은 정상화된 입력의 fallback을 사용하고 두 보관함 관점 사이 동일성을 보장한다; 손상 입력을 그대로 쓰는 live 화면과의 동일성을 주장하지 않는다.

## 6. API v1

모든 성공 응답은 `{ok:true,schemaVersion:1,...}`. 오류는 `{ok:false,code}`이며 경로·원문 예외를 반환하지 않는다. `Cache-Control:no-store`와 기존 referrer 정책을 유지한다.

| GET | 응답 핵심 |
|---|---|
| `/api/replays/games?offset=0&limit=25` | games, nextOffset 또는 null, legacyPresent |
| `/api/replays/games/:gameId/hands?offset=0&limit=50` | game, hands, nextOffset 또는 null |
| `/api/replays/games/:gameId/hands/:handNo` | game, handNo, revision, replay |

game 허용 필드: gameId, savedAt(파일 수정 시각), mode, status(`unfinished|completed|aborted|unavailable`), seatCount, completedHandCount(확인 불가 null), unavailableCode. mode 누락은 기존 엔진과 같이 tournament로 해석하며 알 수 없는 명시 값은 unsupported다. 상세 응답에만 seats의 playerId/name/kind, viewerId=`user`를 추가한다. 손익·최종 스택은 목록 game에 없다.

| 검증한 state | status / 표시 |
|---|---|
| gameOver=false, result=null | unfinished / 미종료 (실행 여부 미확인) |
| gameOver=true, result가 win/lose/completed | completed / 완료 (승패는 노출하지 않음) |
| gameOver=true, result=abort | aborted / 중단 |
| 위 조합 이외, 읽기 실패/지원 불가 | unavailable / 기록 확인 불가 |

상태 표시를 위해 loop-state/프로세스 상태를 조회하지 않는다. 미종료 표시 자체로 계속 플레이 중이라고 안내하지 않는다.

hand 행 허용 필드: handNo, blinds, heroPosition, available, unavailableCode. `replay`는 기존 schemaVersion 1 공개 DTO다. hand 액션의 구조/카드/정수 검증 실패는 unavailable; 구조는 유효하지만 모델 수치 대조 실패인 경우 전체 복기의 텍스트 fallback만 허용한다.

호스트가 탈락한 뒤 다른 인간이 남아 진행한 핸드도 지원한다. startStacks에 user가 없으면 heroPosition=null/“참여 안 함”으로 표시한다. viewerId는 권한 주체 user 그대로이고 합성 좌석을 만들지 않는다. 화면 배치는 첫 실제 좌석을 기준으로 하되 “이 핸드에 참여하지 않았습니다”를 보여준다. 내 시점은 패 없이 공개 사건만 보이며 user 사실 카드는 없다. 다음 내 결정은 아래 공통 탐색 규칙으로 처리한다.

알 수 없는/중복 query, 잘못된 범위는 400 `REPLAY_BAD_REQUEST`; 없는 게임/핸드는 404 `REPLAY_NOT_FOUND`; 아직 완료 안 된 핸드는 409 `REPLAY_NOT_COMPLETED`; 손상/지원 불가/unsafe는 422 `REPLAY_UNAVAILABLE` 또는 `REPLAY_UNSUPPORTED`; 예산 초과 413 `REPLAY_LIMIT_EXCEEDED`; 동시 상한 429 `REPLAY_BUSY`. `CLIENT_ERRORS` 매핑과 UI 문구를 함께 추가한다. POST 등 다른 method는 404다.

`/api/health`에 선택적 `capabilities.replayLibrary:1`을 추가한다. 기존 protocolVersion/descriptor 스키마는 유지한다. **학습실의 drill.js가 링크를 표시하기 전에** health를 조회한다. `replayLibrary===1`일 때만 `/replay.html` 링크를 활성화하고, 누락이면 “구버전 학습 서비스가 실행 중입니다. 서버에서 학습 서비스를 종료한 뒤 다시 열어 주세요”로 안내한다. 도움말/운영 문서는 `npm run study:stop -- /absolute/store` → 기존 학습실 열기를 명시한다. 단순히 학습실 열기를 재호출하면 구 서비스를 재사용하므로 해결되지 않음을 테스트한다. 조회 실패는 재시도 상태이며 기능 지원으로 간주하지 않는다. replay 페이지도 직접 진입/새로고침 시 capability를 확인한다. 구 handler가 새 디스크 drill.html/js를 서빙하지만 새 replay 정적 경로는 모르는 조합을 테스트한다. 장기 실행 중인 구버전 service를 자동 종료하지 않으며 게임 시작/기존 학습을 이 capability로 막지 않는다.

## 7. 내 시점 표시와 결정 이동

### 7.1 표시 계약

`내 시점`은 호스트의 사후 학습을 위한 화면 가리기다. 서버는 기존 공개 정책을 만족하는 전체 핸드 DTO를 전달한다. 개발자 도구까지 막는 시험/부정행위 방지 기능으로 주장하지 않고, 이 모드에서 채점/성취도 이벤트를 만들지 않는다.

표시용 projection은 원본 모델을 수정하지 않고 현재 커서 이하의 정보만 생성한다. renderer에 원본 replay의 임의 필드를 다시 조회하는 우회가 없어야 한다.

- 내 패만 보인다. 상대 패는 쇼다운 단계에서도 `전체 복기 보기`를 누르기 전까지 뒷면이다. 카드 alt/title/aria/좌석 요약에도 동일하다.
- 현재 단계의 board, stack, bet, pot, fold/all-in 상태만 보인다. 아직 도달하지 않은 보드와 결과 객체에서 가져온 endStacks/net/winners/awards/팟별 분배/handName/승리 태그/결과 요약은 표시하지 않는다. 현재 팟·스택이 결과 수치와 우연히 같거나 runout에서 보드 5장이 공개되는 것은 허용한다. 테스트는 숫자 값 일치만으로 유출을 판정하지 않고 필드 출처와 비공개 전용 canary를 검사한다.
- 표시용 타임라인은 커서 이하로 절단한다. 미래 행/placeholder/전체 단계 수/남은 단계 수/비공개 스트리트 버튼/`끝` 버튼을 만들지 않는다. 진행률은 분모 없이 `단계 N`으로 표시한다. 도달한 스트리트로 돌아가는 버튼만 허용한다. 같은 공개 prefix를 갖고 미래 액션 수만 다른 두 핸드의 DOM·접근성 텍스트는 완료 상한에 도달하기 전 같은 커서에서 동일해야 한다.
- 내 시점의 재생 상한은 `kind`가 showdown 또는 result인 첫 단계의 index-1이다. 그 지점에서 멈추고 `전체 복기 보기`를 제시한다. 그 앞의 return/runout은 실전에서도 도달하면 공개되는 사건이므로 재생에 포함하고 해당 단계의 보드를 표시한다. fold 종료, uncalled return 뒤 runout, 블라인드 올인으로 액션 없이 끝나는 핸드도 같은 규칙이다.
- 이유/내 메모/사실 카드/코치·학습 링크는 결정 직전에 숨긴다. 내 액션을 진행한 뒤에는 그 액션의 내 메모와 결정 시점의 공개 산술 사실만 허용한다. 상대 사유 및 결과를 언급하는 설명은 전체 복기에서만 표시한다.
- 보조 텍스트, 목록 보기, 도움말에 끼워 넣은 핸드 값, 반응형 레이아웃과 접근성 트리에도 같은 계약이다. 미래 값을 CSS hidden만 한 채 DOM에 남기지 않는다.

전체 복기는 기존 표시 방식과 savedReplayReveal을 따른다. 알려지지 않은 상대 패는 어떤 모드에서도 공개하지 않는다. 내 시점에서 모델 검증이 실패하면 텍스트 목록으로 자동 전환하지 않고 안내 및 명시적 전체 복기 전환만 제공한다.

내 시점 display projection의 닫힌 출력은 다음과 같다. renderer에 formatReplay의 원본 view를 별도로 넘기지 않는다.

| 표시 경로 | 허용 내용 |
|---|---|
| header | handNo, blinds, “내 시점 · 결과와 상대 패를 가리고 있습니다”만. winners/최종 board/전체 복기 고지 제외 |
| seats | 관측 가능한 순서/이름/위치, 현재 스택·베팅·fold/allIn, 내 패만. 호스트 미참여는 패 없음 |
| current/steps | 커서 이하의 공개 index/kind/street/board/stacks/bets/pot/total/folded/allIn/actor/actionIndex/verb/amount/put/posts/returned/collected만. showdown/result의 결과 필드 없음 |
| rows | 관측한 액션의 street/playerId/decisionId/name/position/verb/verbLabel/amount/pot. user 액션이 이미 진행된 경우에만 note/noteText와 사실 줄 |
| controls | 과거/현재 위치와 관점에서 계산한 활성 상태. 전체 수·미래 결정 존재를 전달하지 않음 |

row.cards/상대 reasonKind/reasonText/coach/study/coachSummary는 내 시점에 없다. 정책 범례와 정책 결정 태그도 전체 복기에서만 만든다. 미래에만 정책 AI가 행동하는 쌍에도 prefix 동일성 검사를 적용한다.

### 7.2 커서 계약

`buildReplaySteps`의 각 `kind==='action' && actor==='user'` 단계 index를 찾는다. 해당 결정 직전 커서는 `index-1`이다. 이미 현재가 결정 직전인 경우 “다음 내 결정”은 그보다 뒤의 결정으로 간다. 이전은 엄격히 앞의 결정이며 없으면 비활성화한다. 기록된 decisions 배열 유무에 의존하지 않는다. **내 시점의 다음 내 결정 버튼은 cap 이전이면 미래 user 액션 유무와 무관하게 활성**이다. 눌렀을 때 다음 결정이 없으면 cap으로 이동하고 “더 이동할 내 결정이 없습니다”를 표시한다. cap에 도달했을 때만 다음 버튼을 비활성화한다. 아직 보지 않은 user 액션의 유무를 버튼 상태로 공개하지 않는다.

첫 진입은 0, 자동 재생은 내 행동 직전에서 멈춘다. **재생을 시작한 현재 커서가 결정 직전이면 그 결정은 한 번 통과**하고 다음 내 결정 직전에서 멈춘다. 첫 진입 0이 결정 직전인 경우도 같다. 같은 위치에서 무한 정지하지 않는다. 수동 “다음”은 액션 하나를 진행한다. forced 액션도 위치 이동은 가능하되 기록대로 강제 액션임을 표시하고 자발적 판단으로 채점하지 않는다. 내 액션이 없는 핸드도 다음 버튼은 cap 이전까지 활성이고 이전 버튼은 비활성이다. 전체 복기에서는 미래 정보가 이미 공개되므로 실제 남은 결정 기준으로 비활성화할 수 있다.

controller는 timer를 하나만 소유한다. 핸드/게임 전환·닫기·pagehide·요청 오류로 기존 model을 폐기할 때 dispose해 늦은 tick을 막는다. 관점 전환은 타이머를 멈추고 전체 모델/facts cache는 유지한다. 속도 변경은 커서를 보존하고 BB/칩 변경은 관점과 커서를 보존한다.

| 이벤트 | 커서·모델·재생 |
|---|---|
| 내 시점 → 전체 | cap 포함 현재 커서 보존, 정지, 모델/facts cache 유지, 컨트롤만 관점별 재구성 |
| 전체 → 내 시점 | 0, 정지, 모델/facts cache 유지 |
| 내 시점 cap 도달 | 재생/다음/다음 내 결정 비활성, 이전/처음/전체 복기 가능 |
| 전체 복기 끝에서 재생 | 기존 live처럼 0부터 재시작 |
| 핸드/게임 선택 변경 | 이전 controller 폐기, 새 모델/0/내 시점/정지 |

보관함은 기존 인증된 `/api/heartbeat`로 페이지가 visible인 동안만 수명 신호를 보내고 pagehide에 중단한다. 주기는 기존 학습 서비스 idle 예산을 코드에서 확인해 그보다 짧게 정하며, 게임/드릴 시작을 호출하지 않는다. heartbeat 실패/토큰 만료는 로딩한 기록을 수정하지 않고 재연결 안내를 표시한다. 브라우저 테스트는 짧은 주입 idle 예산으로 수명 신호와 종료를 검증한다.

## 8. 접근성·오류·회귀

모바일 390px 및 데스크톱 1280px, 2~9인 좌석을 지원한다. 키보드만으로 목록→핸드→재생→뒤로 이동 가능해야 한다. 로딩/오류는 재시도와 목록 복귀를 제공한다. unavailable 행을 빈 핸드나 무승부로 표시하지 않는다. 포커스는 화면 전환 제목/원래 선택 행으로 복원하고 자동 재생 중 aria-live 발화를 제한한다.

새 정적 allowlist는 replay renderer의 상대 import 전체(카드·좌석·facts·shared 계산 모듈 포함)를 실제 브라우저에서 검증한다. 기존 라이브 복기, 로그·결과·최종 요약 진입점과 드릴은 영향 회귀 대상이다.

## 9. 수용 기준

- A1: 서로 다른 두 저장 세션의 같은 핸드 번호를 각각 정확히 읽는다. relay 종료 이후에도 학습실에서 재생된다.
- A2: 인증 실패/다른 역할 토큰은 파일을 읽기 전에 거부된다. 다른 인간의 미공개 패·메모 및 모든 비밀 canary가 상세/목록에 없다.
- A3: 읽기 전후 selector, engine state, hand archive, loop-state, training/profile/event 파일 해시가 동일하다. 서비스 heartbeat/수명 메타데이터 갱신은 기존 서비스 운영 동작으로 별도 관측한다.
- A4: 완료 상한·lastHand ENOENT fallback·abort 미완료·손상/구형/누락·예산 제한이 명시적으로 동작한다.
- A5: 내 시점에서 상대 패/미래 액션/결과가 화면·DOM·접근성 텍스트·목록 fallback에 없고, 전체 복기는 권한 범위만 공개한다.
- A6: 내 결정 직전 이동/자동 정지·재생 재개·빈 결정·forced·모드/핸드 전환·늦은 fetch/timer가 정의대로 작동한다.
- A7: legacy 라이브 복기의 기존 동작과 학습 서비스/드릴 동작이 회귀하지 않는다.
- A8: 모바일/데스크톱/키보드 접근과 모든 정적 모듈 로드가 독립 브라우저 여정에서 검증된다.

구현 순서와 구체 검증은 [구현 계획](replay-study-plan.md)에 정의한다. 코드로 확인해야 할 항목은 구현 gate이며 문서 리뷰 통과만으로 충족되지 않는다.
