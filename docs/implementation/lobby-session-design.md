# 웹 로비와 게임 제어 설계

작성일: 2026-09-09. 기준 소스: `cb838484c967f59133bd45ca34fa03c2bdab0a84`.
범위: 설계와 구현 계획. 제품 코드 구현·배포는 이번 작업에 포함하지 않는다.
상태: **구현 착수 가능**. 설계 2회 선별 수정 후 최신 설계를 의존 문서로 포함한 계획 최종 리뷰에서 PASS/PASS를 확인했다. 구현 순서와 테스트 행렬은 별도 [구현 계획](lobby-session-plan.md), 판정 범위는 [검토 기록](lobby-session-review.md)에 둔다. 작성 주체는 OpenAI Codex이며 정확한 세부 모델 ID는 환경에서 확정되지 않았다.

## 1. 사용자 경험과 결정

`start game`은 브라우저에 로비를 연다. 아직 세션 생성, 카드 배분, 플레이어/코치 LLM 호출을 하지 않는다. 사용자는 웹에서 모드와 AI 수를 고르고 **게임 시작**을 누른다. 같은 로비 URL에서 일시정지·이어하기·종료·다음 게임까지 처리한다. 게임 중 딜러 AI 호출은 계속 0회다.

| 요구 | 확정 동작 |
|---|---|
| 모드 선택 | 캐시 연습 / 토너먼트. 별도 학습실 진입 카드 제공 |
| AI 수 | 두 게임 모드 모두 1~8명. `AI 5명 · 나 포함 6인`처럼 총원을 병기 |
| 일시정지 | 테이블 상단 `일시정지 · 메뉴`. 클릭 즉시 조작 차단 및 메뉴 표시, 서버가 확인하기 전에는 `멈추는 중` |
| 이어하기 | 카드·스택·블라인드·현재 결정·같은 gameId를 보존해 재개 |
| 다시 시작 | `같은 설정으로 새 게임`. 확인 후 현재 게임 종료, 새 gameId와 새 랜덤 시드로 처음부터 시작 |
| 다른 모드 | 일시정지 메뉴의 `모드 선택`. 설정 화면을 탐색하는 동안 현재 게임은 정지. 새 게임 확정 때만 기존 게임을 종료 |
| 종료 | `기록을 남기고 종료`. 완료된 핸드를 보존하고 중단 결과를 표시. 승리·패배나 정상 토너먼트 완주로 바꾸지 않음 |
| 기존 게임 | 로비의 `이어서 하기` 카드. 새로고침·브라우저 재접속으로 새 세션이 생성되지 않음 |

추가 기능은 위 동작에 필요한 시작 상태/오류 표시, 중복 클릭 방지, 재접속 복구, 종료 확인, 학습실/종합 리뷰 진입, 키보드·모바일 접근성까지다. 세션 삭제, 다중 동시 테이블, 임의 과거 게임 선택 재개, 설정 중 핸드 규칙 변경, 신규 AI 전략은 범위 밖이다. 현재 게임은 하나만 이어갈 수 있다. 다른 게임 시작을 확정하면 이전 게임의 **이어하기는 종료**되며 기록은 남는다.

## 2. 화면과 설정 계약

### 로비

1. 상단: AI 홀덤, 연결 상태, 현재 게임이 있으면 요약과 이어하기.
2. 게임 모드 카드: 캐시 연습 / 토너먼트. 학습실은 아래 별도 `학습실 열기` 영역에서 기존 서비스로 이동한다.
3. 필수 설정: AI 수, 상대 유형. 기본은 캐시 연습·AI 5명·policy·100BB·20핸드.
4. 고급 설정: 모드별 스택·핸드 수 또는 블라인드 증가 주기, 블라인드, 힌트, 종료 후 카드 공개/복기 공개 범위. 기본 화면은 접어 둔다.
5. 선택 요약과 게임 시작. 서버 검증 오류는 해당 필드 및 요약에 한국어로 표시하고 입력값을 보존한다.

| 선택 | 실제 매핑 / 조건 |
|---|---|
| 캐시 연습 | `mode=cash-training`; 100BB, 20핸드 기본. 스택은 UI에서 BB로 받고 칩 환산은 서버/엔진이 검증 |
| 토너먼트 | `mode=tournament`; 기존 엔진의 칩·블라인드·levelEvery 기본을 재사용. 핸드 한도/stack-bb 필드는 숨기고 전송하지 않음 |
| 기본 AI | `opponentRuntime=policy`; 로비의 두 모드 모두 기본. 기존 CLI의 명시 토너먼트→LLM 기본 동작은 유지 |
| LLM 상대 | `opponentRuntime=llm`; 설치/인증/적격 런타임을 시작 시 검사. 실패하면 policy로 몰래 전환하지 않음 |
| 나를 복제 / 나를 공략 | policy 하위 체크박스. 누적 적격 60핸드 및 필요한 좌석 수(둘 다 선택 시 AI 최소 2명) 검증. 미달 이유 표시 |
| 힌트 | 기존 `hints=on|off`, 기본 off. 지원 여부와 비교 기준표의 한계를 함께 표시 |
| 카드 공개 | 기존 `showdownPolicy=open|standard`, `replayReveal=all|showdown` 사용. 기본 open/all, 진행 중 상대 비공개 정보는 계속 비공개 |
| 학습실 | 기존 자유 연습·연습 후보·오늘 복습·선택 복습·새 문제 평가·지연 재평가 UI를 재사용. AI 수 설정을 적용하지 않음 |

설정 정본은 신규 `shared/game-setup.js`의 순수 스키마/기본값/상충 규칙이다. 엔진 검증을 대체하지 않으며 UI와 launcher가 이 계약을 소비한다. `applyModeDefaults`는 이 모듈의 **CLI profile**로 위임하는 호환 어댑터로 남고 로비는 **lobby profile**을 사용한다. 두 profile의 의도적 차이(토너먼트 상대 기본 등)와 기존 CLI 결과를 parity 테스트로 고정한다. 명시 CLI 값은 로비 초깃값으로 보존하고 사용자가 시작 전 수정할 수 있다. 고급 옵션에서 raw argv, 모델 ID, 실행 경로, store 경로는 받지 않는다.

AI 1~8명은 플레이 가능 범위다. 휴리스틱 기준표 비교는 현재 코드의 6·8·9인 100BB 및 지원 프리플롭 상황으로 제한됨을 해당 선택 옆에 표시한다. 다른 좌석 수를 막거나 평가가 가능한 것처럼 표시하지 않는다. 자기 상대의 표본 자격은 서버가 다시 계산하며 숨은 정책/좌석 정체를 로비에서 공개하지 않는다.

### 테이블 메뉴

메뉴에는 상태, `이어서 하기`, `같은 설정으로 새 게임`, `모드 선택`, `기록을 남기고 종료`, `학습실`이 있다. pause 대기 중에는 탐색만 허용하고 재개/종료/새 게임 실행은 보류한다. 종료/새 게임 확인문은 현재 핸드가 중단되고 이전 게임을 이어갈 수 없음을 명시한다. 취소하면 paused 상태로 돌아간다. 메뉴를 닫는 동작과 게임 재개는 구분하며 Escape는 게임을 자동 재개하지 않는다.

`모드 선택`은 로비의 설정 컴포넌트를 재사용하는 문맥 있는 설정 화면이다. paused 상태에서는 `메뉴로 돌아가기`가 세션을 정지한 채 메뉴로 복귀시키며, `이어서 하기`와 `선택한 설정으로 새 게임`을 명확히 분리한다. 설정값 탐색/뒤로가기는 아무 lifecycle command도 보내지 않는다. `메뉴 닫기`와 Escape는 overlay만 닫고 테이블 상단 `일시정지됨 · 메뉴` 버튼과 상태 배너는 남는다. 이 버튼으로 메뉴를 다시 열 수 있다.

학습실은 별도 탭으로 열고 로비/테이블 탭을 유지한다. paused 게임에서 열 때 `게임은 일시정지 상태로 유지됩니다`를 표시한다. 원래 탭으로 돌아와 명시 이어하기 전에는 게임을 재개하지 않는다. 최초 로비의 학습실 진입에는 게임을 만들지 않는다.

정상 종료 후에는 종합 리뷰 생성 중/준비됨/실패를 구분하고 `같은 설정으로 새 게임`, `모드 선택`, `학습실`을 제공한다. terminal 처리 중 새 게임 시작은 정리가 끝날 때까지 비활성화한다. 브라우저 닫기·탭 숨기기는 자동 종료/자동 pause로 간주하지 않는다. 명시 일시정지가 아닌 연결 단절은 UI에 연결 끊김으로 표시한다.

## 3. 현재 코드와 변경 경계

| 현재 경로 | 확인한 동작과 설계 영향 |
|---|---|
| `.agents/skills/start-game/SKILL.md` §1~7 | AI가 사전 점검 후 `game-loop.js`를 직접 실행. 무인 핸드 루프 유지, 기본 진입만 로비로 전환 필요 |
| `tools/game-loop.js:5918` main | store loop 락→prepare/init→commit current→bootstrap/run. 세션 생성 함수를 추출해 CLI와 로비가 공유해야 함 |
| `engine/session-catalog.js` | 영구 sessions/와 selectionVersion CAS. current를 변경해도 이전 디렉터리를 이동/삭제하지 않음 |
| `tools/game-loop.js:1847,2696,5782` | step+publish 원자 구간, 사용자 wait, AI watchdog. 단순 DOM overlay나 `requestStop` 재사용으로 pause 구현 불가 |
| `tools/game-loop.js:5163` requestStop | adapter/coach/training/relay 정리 후 loop 락 해제. pause에서는 호출하지 않음 |
| `server/server.js:928,1340` | 한 gameDir의 relay. 인증된 snapshot/SSE/action 및 내부 publish/wait-action 혼재 |
| `server/public/app.js:1039` | URL query token 및 절대 `/api/` 경로에 결합. 로비용 transport 어댑터 필요 |
| `server/public/action-controller.js` | gameEpoch별 액션 receipt/localStorage 복구. pause 메뉴가 기존 액션 접수 증거를 삭제하면 안 됨 |
| `engine/cli.js:404` end | abort는 gameOver=true, hand=null. 중단 핸드와 기존 학습 결과의 의미 보존을 추가 검증해야 함 |
| `tools/study-service.js` | 게임과 다른 수명·토큰의 store 서비스. 로비에서도 동일 helper로 열고 재사용 |

## 4. 소유권과 실행 구조

`tools/app-service.js`가 store마다 하나의 장수 Node 프로세스로 실행된다. **이 프로세스가 관리 모드 사이드카이자 로비 호스트**다. 내부 `session-manager`가 최대 하나의 `createGameLoop()` 인스턴스를 보유한다. 별도의 게임 sidecar 자식을 중첩 생성하지 않는다. 기존 relay와 무도구 LLM 자식의 소유권·정리는 game-loop가 계속 담당한다.

```text
브라우저: 로비 / 테이블 / 메뉴 (같은 origin)
  └ app-server: 앱 인증, lifecycle API, 허용한 테이블 API 중계
      └ session-manager: 직렬 command, 현재 gameId, launcher 호출
          └ game-loop 인스턴스: 엔진/게시/AI/코치/정지/종료의 단일 소유자
              ├ engine CLI + session gameDir
              ├ private per-session relay
              └ 무도구 LLM/학습 작업
  └ study-service helper → 별도 학습실 URL
```

`app.lock.d`는 로비 인스턴스 수명, 기존 store `loop.lock.d`는 현재 loop 인스턴스 수명이다. 다른 락을 대체하지 않는다. launcher는 기존 loop 락을 획득한 뒤에만 세션 init/resume을 진행한다. pause 중 loop 락과 relay를 유지하고, 정상 종료/abort 후 loop 정리가 확인돼도 앱 서버는 로비를 제공한다. app descriptor는 기존 study helper와 같은 pid/startTime/store/instance/authenticated health 검증 패턴을 따른다. PID나 오래된 descriptor만 보고 attach/kill하지 않는다.

launcher 추출 시 gameDir 고정 경계를 유지한다. 엔진·publish·coach에 store 선택 책임을 퍼뜨리지 않는다. service의 run 실패가 전체 HTTP listener를 내리지 않도록 session promise의 종료를 관찰하고 errors를 UI 상태로 투영한다. stop/cleanup은 loop 인스턴스에 국한하고 서비스 종료는 명시 app stop 또는 프로세스 종료 시 수행한다. idle 자동 정지는 최초 버전에서 넣지 않는다; 장수 앱은 의도적으로 유지되며 `app:stop`으로 정지할 수 있다.

loop 공개 API는 기존 bootstrap/resume/run/requestStop에 `requestPause()`, `resumePlay()`, `endGame({operationId})`, `getControlSnapshot()`을 추가한다. app-service는 umask 0077와 프로세스 신호 처리기를 **한 번** 설치하고 모든 session promise rejection을 관찰한다. loop 재생성마다 process listener를 추가하지 않는다. pause 중 run()은 반환하지 않고 내부 제어 대기점에서 park한다. pause completion promise는 별도이므로 HTTP 202 뒤 manager는 run 종료를 기다리지 않고 paused ACK를 수신한다.

## 5. 상태와 명령

엔진 phase나 game-loop finalization phase를 UI 상태로 덮어쓰지 않는다. 신규 `.session-control.json`(session 내부, version=1)은 gameId/gameEpoch, controlRevision, playState, pauseIntent, last command identity와 terminal intent를 보유한다. 쓰기 소유자는 loop이며 launcher 복구 중에는 그 락을 보유한 manager만 초기화한다. 상태가 손상되거나 지원하지 않는 버전이면 제어 불가 오류로 멈춘다. `loop-state.json`에는 읽기용 요약을 둘 수 있지만 원본은 control이다.

| 상태 | 허용 전이 |
|---|---|
| lobby | start → starting |
| starting | bootstrap 완료 → playing; 실패 → error. 새 start 금지 |
| playing | pause → pausing; 게임 자연 종료 → finalizing |
| pausing | 안전 지점 확인 → paused; 불명확한 outcome/저장 실패 → error; 이미 자연 종료한 경우 finalizing |
| paused | resume → playing; confirmed end → stopping; restart/replace-current → old stopping→new starting; setup 탐색은 paused 유지 |
| stopping | abort 확정 및 정리 성공 → ended; 실패 → error |
| finalizing | 기존 종합 리뷰 및 정리 완료 → completed; 실패 → error |
| error | 상태 확인, 호환 코드로 복구. 새 게임은 미해소 소유권/outcome/cleanup이 없는 경우에만 허용 |
| ended / completed | 새 게임 또는 학습실. completed는 기존 phase=done+finishedAt 및 리뷰 증거 확인 필요 |

앱은 `{instanceId, appRevision, currentGameId, selectionVersion, sessionState, allowedCommands, command}`의 검증된 공개 DTO를 반환한다. 절대 경로·프로세스 내부·토큰·원시 state는 포함하지 않는다. UI는 allowedCommands와 서버 상태를 따르며 optimistic paused/started 표시를 하지 않는다.

명령은 `{requestId, expectedInstanceId, expectedAppRevision, expectedGameId, expectedSelectionVersion, kind, setup?}`. start/resume/pause/end/restart/replace-current 모두 같은 직렬 큐를 통과한다. replace-current는 paused에서 선택한 다른 setup으로 새 게임을 시작하는 명령이다. 동일 ID+정규화 payload는 같은 접수/결과, 동일 ID+다른 payload는 409 `COMMAND_CONFLICT`. 이전 탭/인스턴스/게임/revision은 409. command 접수 journal은 app 관리 디렉터리에 durable write 후 202로 응답한다. 중복 조회는 CAS보다 먼저 동일 payload 여부를 확인한다. 다른 pending command가 있으면 409 `COMMAND_IN_PROGRESS`; HTTP 연결 수명과 실제 실행 수명은 독립이다.

setup은 start/replace-current에만 허용한다. resume/pause/end/restart에 setup이 있으면 400이다. resume은 저장된 config/정책/원본 source를 사용하고 restart는 저장된 resolved setup을 서버에서 복제한다. 로비 폼의 defaults가 resume에 전달되지 않는다. starting은 취소 가능한 플레이 상태가 아니며 기존 bounded probe/bootstrap 종료까지 기다린다. 최초 버전에서 별도 cancel-start는 제공하지 않는다. 한계 시간 뒤의 실패/cleanup은 error로 보이고 새 명령을 중첩 실행하지 않는다.

start는 requestId에 배정된 gameId와 selectionVersion을 **prepare 전에 journal에 예약**한다. `prepareSession`은 검증된 예약 identity를 받아 같은 staging/committed 경로를 확인할 수 있도록 확장한다. 재시도는 디렉터리 이름을 검색해서 다른 세션을 추측하지 않는다. commit 전에 실패하면 기존 current 유지, commit 후 bootstrap 실패면 생성된 같은 gameId를 유지하고 복구한다. 새 requestId로 실패한 세션을 몰래 대체하지 않는다.

순서는 `app 단일 인스턴스/command 직렬화 → accepted journal 기록(짧은 쓰기 종료) → store loop 락 획득 → current 재검증 → gameId/selectionVersion 예약 → prepare/init → catalog transaction 락/commit`이다. journal 쓰기 락을 잡고 loop 락을 기다리지 않는다. loop 락을 얻지 못한 accepted command는 gameId 예약 없이 실패한다. 예약 뒤 crash로 다른 current가 선택됐으면 그 command를 superseded/CURRENT_CHANGED로 확정하고 예약·staging audit는 보존한다. 만료 시간으로 삭제/재실행하지 않는다. control→receipt 락은 이 생성 경로와 중첩하지 않는다.

| 예약 transaction 복구 상태 | 확정 동작 |
|---|---|
| 예약만 있고 두 경로 모두 없음 | 같은 gameId/예약 selectionVersion으로 prepare |
| staging만 존재, 검증된 init-complete 증거 있음 | init을 반복하지 않고 같은 staging을 검증해 commit |
| staging만 존재, init-complete 증거 없음/불일치 | `RECOVERY_REQUIRED`; 자동 삭제·재초기화 금지. 불완전 staging 보존, 해당 게임의 자동 새 시작 차단 |
| final sessionDir 존재, current는 예약 당시 이전 버전 | 같은 transaction 락 아래 예약/gameId/init digest를 검증하고 selector commit만 완주 |
| current가 같은 gameId 및 예약 버전 | committed로 판단하고 bootstrap 또는 startPaused 복구 |
| current가 다른 버전/게임, 경로 둘 다 존재, digest 불일치 | `CURRENT_CHANGED`/`RECOVERY_REQUIRED`; 예약 버전을 재발급하거나 새 current를 덮지 않음 |

외부 direct CLI가 current를 바꿨다면 동일 requestId의 재시도도 CAS 실패를 유지한다. 앱은 검증된 외부 실행 상태를 새로 표시하고 사용자에게 기존 실행 전환을 안내한다. 불완전 staging 복구는 처음 버전에서 자동화하지 않는 명시적 오류 경로다; 손상 기록을 보존한 채 호환 도구로 복구한다.

restart는 하나의 command 안에 `기존 게임의 terminal 확정/정리 → 새 session prepare/init/commit → bootstrap` 단계를 기록한다. old game 종료 이후 new init 실패 시 old game은 ended이고 이어하기 불가다. 이 사실과 실패한 단계, 재시도/설정 수정 진입을 표시하며 전체를 rollback했다고 말하지 않는다. 다른 모드 시작도 같은 replace-current 명령 계약이다.

requestStop 후 loop 락 해제→새 launcher 재획득 사이에 외부 CLI가 먼저 획득할 수 있음을 허용한다. **락 handle 이양/retainLock은 추가하지 않는다.** 재획득 실패 시 새 init 전에 `ACTIVE_GAME`으로 중단하고 기존 종료 결과를 보존한다. `LOCKED`, `ACTIVE_GAME`, `CURRENT_CHANGED`는 외부 owner/current를 재검증한 뒤 외부 실행 안내 또는 recovery_required로 투영한다. cleanup 실패로 이전 락이 남으면 새 launcher 호출 자체를 하지 않는다.

## 6. pause의 안전 지점

pause는 핸드 종료까지 기다리는 기능이 아니다. 다만 이미 시작한 액션 하나의 엔진 반영·일치하는 게시/receipt 해소는 끝내고 멈춘다. 이를 `pausing`으로 표시하므로 클릭 시점의 화면과 최종 정지 화면이 한 액션 다를 수 있다.

1. loop가 pause intent와 revision을 원자 저장한다. 이 지점 이후 새 decision, 새 AI 요청, 새 hand, 새 사용자 액션 수락을 차단한다. app 경로뿐 아니라 managed relay의 handleAction도 control gate를 검사한다. relay의 `gate 확인+receipt accept`와 loop의 `gate 닫기`는 같은 짧은 **프로세스 간 파일 락**으로 직렬화한다. 파일을 읽고 나중에 receipt를 쓰는 TOCTOU는 허용하지 않는다. 락 순서는 control→receipt이고 엔진 step/HTTP wait/LLM 호출 동안 보유하지 않는다. 락 경합은 bounded retry 후 503 `CONTROL_BUSY`, managed control 부재/손상은 503 `CONTROL_UNAVAILABLE`로 거부하며 열린 상태로 fallback하지 않는다. AI/engine 작업에는 gate를 통과할 때 admission generation을 부여해 pause 전에 시작한 단위만 drain할 수 있다.
2. gate 닫기 전에 accepted/delivered인 사용자 액션은 기존 receipt 규약에 따라 적용 결과를 해소한다. gate 뒤에 도착한 요청은 `GAME_PAUSED`로 거부하며 나중에 자동 실행하도록 큐에 넣지 않는다. pause 때문에 receipt/localStorage를 지우지 않는다.
3. 이미 시작한 step+publish는 중간에 죽이지 않는다. 현재 구현은 atomicTransition 안에서 publish 후 사용자 wait도 수행하므로, **게시 commit과 다음 입력 wait를 분리**해야 한다. 관리/일반 loop 경로의 입력 wait는 publish CLI 밖, loop 프로세스 소유의 AbortController를 사용하는 `/api/wait-action` fetch로 이동한다. pause는 그 요청을 abort하고 로컬 결과를 typed `control_interrupted`로 만든다. relay는 response/socket close에서 waiter와 timer를 제거한다. relay API에 외부 cancel 경로를 추가하지 않는다. loop는 이 결과를 waitError/timeout보다 먼저 검사해 park 진입하며 서버 복구/폴드/강제 액션을 호출하지 않는다. abort 시점에 이미 delivered가 된 receipt는 상태 조회와 엔진 결과 대조로 drain하므로 HTTP 응답 유실을 액션 유실로 취급하지 않는다. **payload는 loop가 private wait-action을 같은 expectDecisionId로 재호출해 회수한다.** 현재 `server/action-receipts.js:274` deliver는 accepted를 delivered로 저장하고, 이미 delivered면 같은 requestId/digest/action payload를 재전달한다. 이 멱등 재전달을 유지하며 public proxy 금지는 loop의 private 호출에는 적용하지 않는다. 엔진 적용됨/미적용됨이 불명확하면 OUTCOME_UNRESOLVED로 멈춘다. publish CLI의 standalone `--wait` 호환과 게시 재시도 identity는 그대로 유지한다.
4. AI 추론 중이면 해당 추론이 기존 watchdog으로 settle될 때까지 pausing이다. 이미 gate 전에 admission된 decision은 **기존 watchdog timeout fallback을 포함한 한 번의 outcome**을 적용/게시까지 허용하고 다음 decision은 시작하지 않는다. 차단 대상은 gate 뒤 새로운 decision/그 decision의 watchdog 예약이다. 종료 불명확 또는 outcome 불명확은 paused 성공이 아니라 error다.
5. 코치·training·hint의 신규 작업 예약을 막는다. 이미 시작한 완료 핸드용 작업은 기존 bounded settle/cancel 계약으로 정리하고 durable 소비/게시가 끝난 뒤 paused를 확정한다. 현재 결정의 hint/지연 AI 응답은 gameEpoch+decisionId+generation으로 fencing한다. pause 후 장기 타이머/heartbeat가 새 작업을 시작하지 않는다.
6. pending engine mutation/publication/action outcome/쓰기 작업이 없고, delivered receipt가 없거나 엔진 적용 결과 대조 및 일치하는 ack 게시를 완료했으며, 새 작업 gate가 닫힌 상태에서 paused를 저장한다. engine hand/decisionId/stacks/level은 그대로다. pause가 끝나면 이 상태가 일정 시간 유지됨을 기계 검증한다.

사용자 무제한 대기에서는 waiter 중단으로 pause가 즉시 진행돼야 한다. LLM 실행 중의 지연은 해당 runtime의 기존 timeout 범위이며 무조건 1초 정지를 약속하지 않는다. UI는 진행 상태와 지연 사유를 표시한다. 일시정지 대기에 시간 초과가 생겼다고 강제 종료/새 게임으로 바꾸지 않는다.

run()은 다음 user/AI/new-hand dispatch 전에 `await control.waitUntilPlayable()`에서 park하고 동일 실행을 유지한다. `resumePlay()`는 gate를 열기 전에 읽기용 engine step 동기화 및 view-only 게시를 수행해 **최신 out(stateVersion/next/decisionId)**을 run에 인계한다. stale out으로 dispatch하지 않는다. 그 뒤 gate를 열고 대기를 깨운다. run()을 다시 호출하거나 살아 있는 loop에 bootstrap/resume을 중첩 호출하지 않는다. requestStop은 park와 input wait 모두를 깨우고 기존 cleanup을 수행한다. endGame은 park 상태를 terminal branch로 깨워 abort→publish→requestStop을 loop 안에서 실행하고 run promise를 종료한다.

resume은 같은 gameId로 최신 엔진/receipt/게시를 대조하고, 복구 가능한 대기 작업을 처리한 뒤 control gate를 열고 playing을 게시한다. 본래 요청한 현재 액션이 pause 직전 적용됐다면 새 decision을 보여주고 같은 액션을 반복하지 않는다. managed 서비스 재시작 시에는 재개 버튼을 누르기 전 새 hand/AI decision이 시작되지 않도록 **startPaused 복구 경로**를 둔다. 독립 study-service에서 사용자가 수행한 학습은 pause의 session 상태 불변 범위에 포함하지 않는다.

## 7. 종료·기록·복구

사용자 종료는 paused 안전 지점에서만 시작한다. terminal intent를 먼저 기록하고, 현재 핸드가 있으면 engine mutation과 같은 복구 단위로 **중단 핸드 audit**를 보존한 후 abort를 확정한다. 감사 기록에는 게임/핸드/상태 버전, 중단 전 상태 digest와 원인만 공개용으로 투영한다. 원시 미완료 상태는 session의 private audit에 보존하며 일반 완료 핸드 archive로 취급하지 않는다.

abort된 미완료 핸드는 정상 완료 핸드/승패/핸드 순손익/신규 평가·profile 분모에 넣지 않는다. 이미 완료된 핸드의 평가와 이전 원본 event는 삭제하거나 다시 채점하지 않는다. 중간 핸드의 팟 칩을 승패로 정산하거나 UI에 확정 손익으로 표시하지 않는다. partial hand audit와 abort mutation의 crash window는 deterministic operation ID로 복구하며 중복 end도 같은 terminal 결과를 반환한다.

그 뒤 종료 상태를 publish하고 loop.requestStop의 기존 자식/relay/락 정리를 완주한다. abort는 일반 종합 LLM 리뷰를 요구하지 않고 완료 핸드 기준 중단 요약을 표시한다. 사용자 종료 결과 `ended`와 정상 완료 `completed`를 별도 표기한다. 향후 중단 세션 전용 종합 리뷰는 별도 기능이다.

abort intent 확정 후 loop-state의 전용 phase는 `aborted`, result는 `abort`, 시간은 `endedAt`이다. `phase=done`/`finishedAt`를 만들지 않는다. engine mutation과 loop metadata 쓰기 사이에 crash가 가능하므로 run/resume/bootstrap recovery는 기존 FINAL_PHASES/gameOver 분기보다 먼저 durable abort intent 또는 engine.result=abort를 검사한다. intent만 있으면 동일 operation을 완주하고, abort가 확정됐으면 요약/게시/정리만 복구한다. 어느 경로에서도 종합 리뷰·finishDoneLifecycle로 보내지 않는다. metadata가 없는 legacy abort도 engine.result를 우선한다. 이 phase와 cleanup 판정은 resume-check/rollback-guard의 소비자에도 함께 반영한다.

| aborted 소비자 | 확정 처리 |
|---|---|
| resolveForPhase / run / resume / bootstrap recovery | 별도 ABORTED_PHASES로 검사, FINAL_PHASES에는 넣지 않음. player/upper adapter를 만들지 않고 요약/필요한 relay 게시/cleanup만 수행 |
| 직접 CLI --resume | 남은 abort cleanup이 있으면 완주; 성공 시 `{ok:true,code:GAME_ENDED,phase:aborted,resumed:false}`를 보고하고 정상 exit. 플레이·정상 리뷰를 재시작하지 않음 |
| resume-check / rollback-guard | terminal-but-not-done으로 인정하되 pending publish/action/coach/training/cleanup 오류는 기존 gate로 차단. aborted라는 이유만으로 정리 성공 처리하지 않음 |
| 로비/학습실 | 공개 snapshot으로 ended 표시, 학습실은 explicit open helper로 사용 가능. 로비 조회만으로 upper LLM을 시작하지 않음 |

journal에는 accepted end/restart/replace-current가 있으나 control intent가 없는 crash window는 startPaused 복구와 identity 검증 후 **같은 operationId로 이미 확인받은 명령을 자동 완주**한다. 사용자에게 확인을 다시 받지 않으며, terminal intent/engine abort가 이미 있으면 중복 mutation 없이 그 단계를 이어간다. current identity가 바뀌었으면 재실행하지 않고 CURRENT_CHANGED로 끝낸다.

서비스 crash 뒤 다음 start game은 descriptor와 loop/relay owner를 확인한다. live/unknown 외부 owner가 있으면 탈취하지 않는다. 같은 store에 관리 서비스가 살아 있으면 검증 후 그 로비를 연다. 이전 direct CLI loop가 살아 있으면 기존 테이블 링크와 `기존 실행 방식의 게임이 진행 중` 안내를 제공하며 새 관리 게임 시작/제어는 차단한다. 사용자가 기존 게임을 종료한 뒤 관리 모드로 전환한다.

앱 사망·loop owner 사망이 확인되면 pending command와 current를 대조한다. 복구는 기존 publish/receipt/coach/training의 production resume 경로를 사용하되 startPaused gate를 **복구 엔진 진행보다 앞에** 설치한다. 고아 relay는 기존 identity 검증·채택/정리 절차로 해소한다. init 중 crash, current commit 뒤 crash, abort 뒤 crash, cleanup 실패는 별도 UI 오류 코드와 재시도 경로를 가진다. disk-full, selector 손상, 살아 있는 owner 불명은 빈 로비로 정상화하지 않는다.

## 8. HTTP와 보안 경계

새 앱은 loopback 전용으로 bind한다. Host는 실제 `127.0.0.1:port` 및 명시 허용한 `localhost:port`만 허용하고, 모든 `/api/*`는 Authorization 헤더 인증 실패 시 401이다. 앱 접속 token은 service instance마다 생성하고 최초 URL fragment에서 읽어 sessionStorage로 옮긴 뒤 URL에서 제거한다. 앱 제어는 같은 origin 검증, JSON 및 body 상한으로 보호한다. GET은 부작용이 없다. 앱 SSE는 fetch stream을 사용해 헤더 인증하며 lifecycle reconnect는 snapshot부터 수행한다. 로그·스크린샷·산출물에는 토큰을 쓰지 않는다.

| API (신규 app-server) | 역할 |
|---|---|
| GET /api/app | authenticated snapshot, command status, 현재 선택 및 기본 설정 |
| GET /api/capabilities | 설정 스키마와 캐시된 자격. GET만으로 LLM probe를 시작하지 않음 |
| POST /api/commands | start/pause/resume/end/restart/replace-current. 202 accepted 또는 명확한 4xx |
| GET /api/commands/:requestId | pending/succeeded/failed/recovery_required 확인 |
| GET /api/app-events | lifecycle change 통지. appRevision/instanceId 불일치 시 resync |
| POST /api/study/open | 기존 ensureStudyService helper 사용, 검증된 별도 URL만 반환 |
| /api/game/:gameId/{snapshot,events,action-status,training-detail,action} | 현재 session에만 결박한 제한적 relay 중계 |

중계 경로는 위 method/path allowlist로 고정한다. `/publish`, `/wait-action`, 임의 URL/port/path/token 전달을 절대 허용하지 않는다. relay 토큰은 서버 측만 보유하고 내부 요청에 넣는다. 클라이언트가 보낸 token/authorization/host/upstream 지정 필드는 전달하지 않는다. 매 요청은 gameId+selectionVersion+gameEpoch와 현재 소유 relay identity에 고정한다. old tab 요청은 새 current로 재지정하지 않고 409로 거부한다. SSE는 switching 시 닫고 새 epoch snapshot으로 시작한다.

relay의 managed 여부는 control 파일 존재 여부로 추측하지 않는다. launcher/loop가 relay 기동 시 명시한 `controlProtocolVersion=1`과 고정 gameEpoch/control 경로를 server lock·authenticated health identity에 결박한다. 이 계약으로 기동된 relay에서는 파일 삭제/손상도 503이며 legacy mode로 내려가지 않는다. 인자가 없는 기존 standalone relay는 기존 동작이다. relay 자가치유/재기동 때도 같은 managed identity를 다시 전달하고 검증한다.

브라우저용 gameEpoch는 기존 `gameEpochOf(sessionToken)` 결과와 **동일한 비밀이 아닌 식별자**다. 인증용으로 사용하지 않으며 원래 토큰을 되찾을 수 있는 별도 endpoint는 없다. app transport가 이를 제공해 기존 action-controller/localStorage/receipt의 결박을 유지한다. 숨은 카드/정책/코치 원문은 기존 `publish.js`와 relay public projection을 그대로 거친다. 앱 로비는 `state.json` 전체를 HTTP로 반환하지 않는다. 내부 relay에 접근하는 과거 standalone 클라이언트의 호환 경로는 유지하되 managed 세션의 pause gate를 우회하지 못한다.

relay 종료 후에도 current의 완료 리뷰/중단 요약을 읽을 수 있도록 기존 loadUiState/publicSnapshot의 **검증된 공개 snapshot reader**를 추출한다. 앱은 pinned session의 마지막 게시만 이 reader로 읽고 실시간 snapshot과 같은 필터를 적용한다. live SSE/action은 종료되고 terminal view는 read-only다. service 재시작 후에도 이 경로로 리뷰를 표시하며 snapshot 손상은 결과 없음/오류로 보인다. raw review/state 파일을 정적 serving하지 않는다.

## 9. 호환성·활성화·접근성

새 `start game` 및 모드/AI 수 옵션이 있는 일반 요청은 로비를 열고 값을 prefill한다. 명시 `resume`은 기존 의미의 재개 요청이므로 검증된 동일 current에 대해 재개하고 테이블로 이동할 수 있다. 옵션 없는 start game은 저장된 게임이 있어도 자동 재개하지 않는다. 기존 `node tools/game-loop.js ...`, legacy `--game-dir`, 원본 v1/v2 학습 기록은 유지한다. 원하면 직접 실행하는 CLI 경로를 문서화하며 자연어 일반 시작과 구분한다.

새 제어 metadata 없는 종료된/중단된 구버전 session은 기존 판정 후 처리한다. 관리 resume으로 선택한 비종료 세션에만 version=1 control metadata를 초기화하고 startPaused로 복구한다. 기존 config/정책/평가 source를 새 기본값으로 덮지 않는다. 새 metadata를 소비한 실행 중 세션을 구버전 바이너리로 열어 pause를 무시하는 rollback은 지원하지 않는다. quiescent 상태와 호환성 확인 후 이전 코드 사용 또는 roll-forward한다.

기능은 opt-in 앱 CLI에서 먼저 통합 검증한 뒤 스킬 기본을 마지막에 전환한다. macOS뿐 아니라 현재 지원 Node 20/22·Windows 프로세스 identity와 cleanup 경로를 검증한다. 실제 사용자 store로 개발 smoke하지 않는다.

모드 카드와 메뉴는 실제 button/fieldset/label을 사용한다. dialog focus trap, 닫기 후 focus 복귀, aria-live 상태, 좁은 화면 스크롤, 키보드만으로 시작→pause→resume을 제공한다. 기존 카드 복기/리뷰 overlay와 동시에 두 modal이 활성화되지 않게 우선순위를 둔다. 폴드·콜 단축키가 열린 메뉴 뒤에서 실행되지 않아야 한다.

pause 명령이 409/연결 실패이면 snapshot과 같은 requestId의 status를 재조회한다. 서버가 playing임을 확인한 뒤에만 조작을 복원하고 실패 사유를 aria-live로 알린다. 상태 불명은 연결 복구 화면에서 조작 차단을 유지한다. 스킬은 기존 macOS open/Windows start 및 브라우저 없는 환경의 링크 안내를 재사용한다.

## 10. 설계 수용 기준

U1: bare start는 로비만 열고 엔진 init/LLM 호출/카드 배분이 0회다.
U2: UI만으로 두 모드, AI 1~8명, 기존 상대 옵션 및 학습실에 진입 가능하다.
U3: 사용자 대기/AI 추론/step+publish/핸드 경계에서 pause가 안전 지점에 도달하고, 이후 상태가 불변이다.
U4: resume은 같은 게임을 이어가며 accepted 액션을 누락·중복 적용하지 않는다.
U5: restart/모드 변경/종료는 명시 확인과 terminal/cleanup 증거를 요구하고 이전 기록을 보존한다.
U6: 중복 클릭·응답 유실·다중 탭·프로세스 재시작으로 새 게임이나 terminal event가 중복 생성되지 않는다.
U7: 이전 session token/새 app token/hidden state가 섞이지 않고 internal relay API가 웹에 노출되지 않는다.
U8: 기존 CLI/resume/학습실·v1/v2 데이터/정상 종합 리뷰 수명이 회귀하지 않는다.
U9: 실제 브라우저에서 로비→플레이→pause→setup 취소→resume→restart→종료→학습실 여정을 검증한다.

리뷰 시 제품 모호성, 상태 전이, action/command 선형화, crash recovery, 보안, rollback, 테스트 충분성을 확인한다. 리뷰 지적은 수용/부분 수용/기각 및 근거를 별도 기록하고, 런타임 증명이 필요한 항목은 구현 단계 검증 gate로 이월한다.
