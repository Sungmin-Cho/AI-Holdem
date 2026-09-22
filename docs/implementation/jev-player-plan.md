# 테이블 전체 JEV 구현 플랜

작성: 2026-09-22 · 상태: 구현·로컬 검증 완료 (원격 CI 후 병합)
정본: [설계](jev-player-design.md). 2026-09-22 사용자 구현·실제 플레이·PR/merge 승인으로 구현을 진행한다.

## 구현 순서

### P1 — 설정·의존성·영속 identity

- .github/workflows/test.yml 및 SDK를 import하는 모든 CI job에 `npm ci`를 테스트 전에 추가한다(현재는 dependency-free라 설치 단계가 없음). Windows shard의 신규 테스트 배정도 확인한다.
- package.json/새 package-lock: `@typesafe-ai/sdk` 0.6.0 정확 버전. Node 지원/CI 설치 단계 점검.
- shared/game-setup.js, engine/cli.js, tools/game-loop.js의 모든 opponentRuntime 두 값 분기 점검 및 jev 추가.
- 공유 브라우저 안전 상수/validator(예: shared/opponent-runtime.js)에 JEV descriptor 및 과거 런타임 해석 규칙 구현. SDK/키는 공유 모듈에 금지.
- engine/game-archive.js init 최초 저장에 config.opponentRuntime 및 config.jev 추가. engineInitFlags/initializePreparedSession/launcher도 같은 계약으로 전달.
- `init --jev-config-file`의 4 KiB/regular/non-symlink/closed supported-tuple 검증과 mutation 전 실패를 구현한다. session-manager의 내부 command row `jevConfig` → launcher internal opts → config file → engine 최초 commit 전달을 테스트한다.
- tools/session-manager.js에서 같은 설정 restart descriptor 보존, resume의 engine/loop/setup/명시 인자 불일치 검사. 기존 저장 설정에 새 비밀 필드는 없음.
- 수용: 새 세 모드 저장/restore 왕복, config 객체는 있으나 opponentRuntime 필드가 없는 실제 구형 llm/policy, JEV descriptor 손상·알 수 없는 버전·runtime 충돌, loop-state 유실 복원, AI 0 예외, mirror/exploit 거부.

### P2 — 전송 projection·합법 후보·응답 검증

- tools/jev-player.js 순수 모듈 작성. 설계 §4의 닫힌 스키마·영어 페르소나·현재 핸드 64개·24 KiB 제한.
- legal-menu-v1 금액 계산, short all-in, canRaise=false, 중복 제거, overflow 검사.
- one Choice 요청 생성과 strict 응답 validator. reason/승률/GTO 변환 금지.
- 안정된 좌석 인덱스 `seat_N` remapping을 publicSeats/actor/priorActions에 동일하게 적용하고 원래 참가자 ID canary 부재를 검사한다. 현재 레벨 snapshot.blinds로 금액 계산하는 토너먼트 사례도 포함한다.
- 테스트 test/jev-player.test.js: hidden-card/deck/seed/note/canary 입력을 넣고 직렬화된 요청 전체를 검사. 자기 패/공개 보드는 남는 양성 검사도 수행.
- 금액 경계: 블라인드 1/2 및 25/50, preflop facing raise, postflop actorBet>0, short call/short all-in, raise 재개 불가, rounding/clamp dedup, safe integer overflow, 단일 후보.
- 응답 경계: unknown/missing/extra probability key, NaN/Infinity/합 오차, 허용 밖 choice/type/model/confidence, 동률. 입력 불변/결정적 후보 순서.

### P3 — HTTP 어댑터와 bounded lifecycle

- tools/jev-runtime.js: lazy import, 키·공식 baseURL, 모델 고정, dependency injection, retry=0, per-call timeout과 abort/dispose. runtime idle/active/disposing/disposed/closure_unconfirmed 및 2s settlement grace 구현. logLevel:off+no-op logger, 공식 baseURL, redirect:error, TYPESAFE_API_KEY 명시 주입.
- SDK fetch fake를 사용하여 실제 SDK serialization/options/AbortSignal 동작 검사; 단순 모사 함수만 테스트하지 않는다.
- typed 에러 매핑: missing SDK/key, 401/403/422/429/529/5xx, timeout, network, malformed response. SDK message/body/headers 로깅 금지.
- P3 → P4 진입 gate: 설치 SDK fake-fetch 검증 후 합성 상태 최대 2회 live 계약 spike(총 10회 예산 포함). response model ID/필수 probabilities/confidence/usage, 실제 abort settle를 확인한다. 실패 시 P4 중단 및 설계 재판정; 임의 필드 생략/오차 완화 금지.
- test/jev-runtime.test.js: 초기화만으로 호출하지 않음, 인증 header가 공식 origin에만 전송됨, abort 이후 settlement, 자동 재시도 0, 시간 제한, model 환경 override 차단, 에러 원문 canary 제거, dispose idempotent. abort를 무시하는 fake client는 2s 내 closure_unconfirmed error, closeConfirmed=false/재시도 금지; 늦은 resolve에서도 적용 0. dispose 이후 새 decide와 동시 두 decide 거부.

### P4 — game-loop 통합과 pending v3

- 설계 §4 능력 표대로 bootstrap 7263/7316/7335/7345, resume 7503/7513/7516/7528, run 7952/7962/7990의 각 분기를 교체한다. `!policyMode`가 LLM을 뜻하는 잔여 분기 전수 검색.
- decideWithJev 경로 및 명시적인 policy/llm/jev dispatch 추가. JEV upper-only/플레이어 세션 생략, coach reclaim 유지.
- 작은 공통 engine commit helper 추출 시 기존 LLM 동작 유지 테스트를 먼저 고정한다. HTTP와 CLI의 종료 의미를 분리한다.
- 기존 run VERSION_MISMATCH catch의 pending 제거를 재사용하되 자신의 running identity/HTTP 미시작/proposed 없음으로 guard한다. peek 버전 불일치→pending 제거/SDK 0/정상 resync, pending durable write 실패→추론·step 0, retryable 없는 running v3 crash→검증 성공/recovery 전이 fixture를 추가한다.
- engine envelope로 identity 확정 후 fallible peek/projection 전에 pending을 기록한다. 입력 구성 오류는 retryable=false/End만, 단일 후보는 HTTP=0이지만 동일 proposedAction/atomic step/reconcile 절차. 각 crash 지점과 SDK 호출 0을 검사한다.
- pending v3 validator 및 소비 지점 전체 확장: resume schema 검사, retryDecision, requestStop pending patch, interruptDecision, terminal exit, session-manager 및 server의 recovery projection.
- JEV disposable을 requestStop이 명시적으로 소유한다. settle/atomic/engine/coach 종료 확인 전 lock 해제·closeConfirmed 쓰기 금지. 미확인 시 2s 후 bounded error, pending unsafe, capability revoke, 새 게임 금지; 늦은 settle의 trusted closure observer는 identity/락/현재 엔진 차례를 검사해 recovery로 전환하고 stop 실패 latch의 closure 오류만 재시도한다. 끝내 settle하지 않으면 서비스 종료→검증된 소유자 종료→사망 확인→정상 앱 재개의 운영 경로를 문서화한다. 소유 프로세스 종료 후 resume fixture까지 검사.
- generation/decisionId/playerId/stateVersion/gameEpoch, settled request와 proposedAction commit 경계 검사. late response·중복 retry는 engine step 0 또는 정확히 1.
- engine 적용 결과를 먼저 reconcile; proposedAction 없는 HTTP crash만 명시적 재시도 허용. 불확실한 engine CLI 실행은 unsafe.
- 시작 preflight는 launcher의 init/선택 변경 앞에 배치하고 current/archive/engine init/reservation이 불변임을 각각 검사한다. 앱 command journal 및 일시적인 room lock은 요청 처리 기록으로 허용하되 실패 시 room lock을 반드시 풀어야 한다.
- 시작 preflight는 launcher의 init/선택 변경 앞에 배치, resume 누락 키는 종료 기능을 막지 않게 처리. JEV finalizing/done은 SDK를 로드하지 않는다.
- test/jev-loop.test.js 및 기존 recovery 테스트 확장: normal→softWait→interrupt, softWait 이전 interrupt no-op/버튼 숨김, hard timeout, pause 중 응답(사전 소유 결정은 정확히 1회 적용/게시 후 paused), stop/end 중 응답(적용 경계 전이면 0회), SDK error, SDK settle 지연, 재시도 클릭 중복, 취소/응답 경합, engine version mismatch, engine step 후 publish 실패.
- crash fixtures: 요청 전후, 응답 후 proposed 전, proposed 후 step 전, step 후 pending clear 전; running/recovery/retry_authorized/unsafe 각각 재개. 기존 LLM v1/v2 recovery 불변.

### P5 — 로비·CLI·온라인 UX 및 진단

- server/public/lobby.html/js에 JEV option, 전송 정보 설명, llm/jev 공통 대기 예산 표시. 서버도 fresh-session의 JEV 요청 거부.
- 온라인 참가자 입장 전 공개 플레이 정보의 JEV 전송 고지 및 잠긴 setup으로부터 aiProvider 표시를 추가한다. 참가자의 private 패/이름/ID 미전송과 runtime 표시만의 공개 payload를 검사한다.
- v3 session-manager 투영에서 CLI diagnosticsQuarantined/retryWillCorrect/freshSessionAvailable=false, retryable=false 입력 오류는 End만, closure 미확인은 제어 명령 없음과 운영 안내, late settle 후 명시 retry 허용을 검사한다.
- setup summary와 retry/interrupt 문구 provider 중립화; LLM 전용 기능은 유지. controls는 기존 호스트 인증/epoch/command 중복 방지 사용.
- 최소 AI pace 간격 적용, 저장된 pace로 resume/restart.
- 공개 metrics와 private `loop-state.jevDiagnostics`를 별도 schema로 구현한다. 각각 5,000건/dropped, loop-state 유실 시 리셋 의미를 검사. host summary도 분포/usage/confidence 제외. SDK debug 환경변수를 강제로 설정한 상태에서 stdout/stderr/log sink canary 누출이 없는지 검사.
- bounded 로컬 metrics/log projection만 추가. host/participant/SSE/replay/export 경계에서 raw payload/확률/private 패가 새로 노출되지 않는지 검사.
- table-wide 계측: 연속 AI 차례는 각 행동자의 자기 패만 포함한 JEV 호출, 인간 차례 호출 0. policy/llm 및 AI 0 JEV에는 SDK import/키 조회/원격 호출 0. upper CLI spawn은 별도로 구분하고 JEV player CLI spawn 0.
- test/jev-session.test.js: 앱 start/resume/restart/end, 키 누락 후 종료, host/participant 권한, AI 0, finalizing upper fallback, restart descriptor 고정.
- browser fixture로 JEV 선택→시작→soft wait→취소→재시도→종료 흐름 확인. 실제 외부 API와 혼합하지 않고 fake 어댑터 주입.
- README 및 .agents/skills/start-game/SKILL.md와 AGENTS.md의 런타임/재개 안내 갱신. 새 start game은 여전히 앱 로비.

### P6 — 통합 검증·실제 API smoke·인수

1. 신규 4개 내외 테스트와 영향받는 game-setup/player-decision/player-runtime/policy-loop/회복·session controls/coach·멀티플레이어 suite 실행. 실제 파일명은 구현 시 rg로 확인한다.
2. `npm run test:ci`, `npm run benchmark:policies`, 관련 browser journey. 기존 CI Node 20/22 및 Windows shard 계약에서 신규 dependency install/lockfile 및 import 지원 확인. 로컬에서 실행하지 않은 OS 결과를 통과로 표시하지 않는다.
3. 전용 임시 디렉터리에서 실제 SDK 합성 포커 상태 총 최대 10개 요청(P3 spike 포함), 동시 1개, 총 요청 제한은 실패·취소도 포함. preflop/flop/turn/river와 forced one-option을 포함. one-option은 API 0. 기준 model ID/응답 검증/합법성/지연/usage/실패율 기록. provider 요청 전송을 승인받은 구현 범위에서 실행하며 키·실제 게임 데이터를 산출물에 넣지 않는다.
4. 실제 API 성공과 포커 품질을 분리. 승률 우위는 인수 조건이 아니다. 합성 smoke 실패는 인증/SDK/계약/서비스 오류로 구분하고 기능 완료로 표시하지 않는다.
5. 구현 diff 독립 리뷰(model-router)를 재수행하고 채택한 결함 수정 후 영향 테스트만 재실행. 이번 문서 리뷰는 구현 코드 리뷰를 대신하지 않는다.
6. 검증 보고서에 실제 실행 명령/결과, API 요청 수/실제 model/관측 지연, 미실행 OS, 잔여 제한, 다운그레이드 절차를 기록한다. 사용자 요청 전 merge/deploy/사용자 실제 store 게임 실행은 하지 않는다.

## 실패·중단 기준

- legacy llm/policy 회귀, private 정보 유출, 이중 적용, 잘못된 모드로 재개, 중단 후 적용이면 구현 완료 불가.
- 외부 API 장애/키 오류는 mock 통과로 덮지 않는다. 연결 검증 미완료로 보고한다.
- 전략 결과가 기대보다 약해도 임의로 policy/LLM fallback을 추가하지 않는다. 사실을 보고하고 후속 튜닝 범위를 분리한다.

## 문서 리뷰 인수

설계/플랜 쌍을 하나의 해시된 artifact로 독립 리뷰한다. 작성 모델 gpt-6-astra를 리뷰 좌석에서 제외하고 model-router의 dispatch_seats만 실행한다. 리뷰어의 최종 token보다 지적의 재현/근거를 우선한다. 수용/부분 수용/기각 및 이유를 별도 review 문서에 남긴다. 최대 3라운드 내 주요 미해소 설계 문제가 없으면 구현 준비 상태로 보고하며, 코드로 증명할 사항은 P1–P6 테스트에 명시적으로 이월한다.
