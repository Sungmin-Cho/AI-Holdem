# 로비·게임 제어 설계/계획 검토 기록

날짜: 2026-09-09. 소스 HEAD: `cb838484c967f59133bd45ca34fa03c2bdab0a84`.
대상: [설계](lobby-session-design.md), [구현 계획](lobby-session-plan.md).
최종 판정: **READY_FOR_IMPLEMENTATION — 구현 착수 가능**. 구현 코드는 변경하지 않았다. 제품 기능 완료/테스트 통과/릴리스 승인이 아니라 설계·계획 준비 판정이다.

## 범위와 라우팅

- 설계·계획을 작성한 호스트는 OpenAI Codex/GPT-6다. 정확한 세부 모델 ID가 주어지지 않아 router host advisory에는 `gpt-6`(unrecognized)을 기록하고 source author는 확인 가능한 `openai` family로 선언했다. 세부 ID나 reasoning effort를 추정해 넣지 않았다.
- 사용자 확인대로 Claude/GPT/Grok을 사용 가능한 후보로 취급했다. 현재 세션의 read-only READY probe에서 Claude Opus 5/Fable 5.1, GPT-5.6 Sol, Grok-4.6 응답을 확인했다. 과거 메모리의 GPT quota 제한은 적용하지 않았다.
- 설계 HIGH 리뷰: complexity=2, uncertainty=1, blast_radius=2, reversibility=1 → risk 9/HIGH, execution 8/EASY. concurrency/data-integrity/security flags, confidence 0.95. dispatch_seats는 Opus 5 + Fable 5.1, 각각 high. 이미 작성된 문서의 source author family를 제외해 두 리뷰어는 모두 Claude다. 서로 다른 새 CLI 세션이고 peer 결과를 입력에 넣지 않았으나, 서로 다른 provider의 HIGH dual review라고 주장하지 않는다.
- Grok은 레지스트리 tier=1이라 HIGH 리뷰 자리를 대체하지 않았다. 별도 제품 UX 범위(화면/모드/메뉴 요구 충족)만 risk 5/MEDIUM, execution 5/EASY로 분리해 Grok-4.6 high에 배정했다. 이는 설계 상태·보안 HIGH 검토를 대체하지 않는다.
- 모든 실제 리뷰는 모델 라우터 `dispatch_agent.py` supervisor 아래 수행한다. route fingerprint/policy hash/target hash를 기록하고 Darwin receipt guard를 적용한다. bridge stdout의 종료와 verdict, child termination, 모델 선언/관측값을 구분한다.
- Grok의 기본 read-only sandbox는 바깥 receipt sandbox와 중첩 초기화가 실패했다. 해당 시도는 리뷰 0건인 probe 실패다. 도구 목록을 비우고 MCP를 차단한 문서 입력 전용 경로로 다시 probe해 성공했다. receipt guard는 유지했으나 Grok 자체 read-only filesystem sandbox를 적용했다고 주장하지 않는다. 모델 호출 가능성과 특정 dispatch recipe의 성공은 다른 사실이다.

## 설계 1차 리뷰 선별

두 리뷰의 본문 판정은 PASS_WITH_CHANGES였다. Opus는 `confidence: medium` 및 `major/minor`처럼 요청된 출력 schema 일부를 지키지 않았다. supervisor는 verdict 문자열을 받아 SUCCEEDED였지만 이를 완전한 schema 준수로 간주하지 않았고, 2차 입력에는 수치 confidence/허용 severity를 명시했다. 실질 지적은 코드와 대조해 아래처럼 처리했다.

| 지적 | 판단 | 반영/기각 근거 |
|---|---|---|
| wait를 누가 중단하는지 미정 | 수용 | loop 소유 AbortController/fetch로 입력 wait를 이동. 게시 atomic unit 밖, relay close cleanup, typed interrupt 우선 처리, delivered 응답 유실 대조 |
| paused 동안 run의 소재 미정 | 수용 | 내부 park로 결정. run completion과 pause ACK 분리, resume은 기존 실행을 깨움 |
| abort 뒤 gameOver가 정상 finalization으로 진입 | 수용 | aborted/result=abort/endedAt 및 intent 우선 분기, run/resume/bootstrap/rollback 소비자 계약 추가 |
| staging/rename/selector crash 상태 미정 | 수용 | 예약 transaction 복구 표. init-complete 증거가 없으면 보존+RECOVERY_REQUIRED, selector commit만 안전하게 완주 가능한 경우 구분 |
| AI watchdog fallback과 pause 규칙 충돌 | 수용 | admitted decision의 timeout fallback까지 한 outcome으로 drain, 다음 decision만 차단 |
| restart의 loop lock 해제 공백 | 부분 수용 | 외부 CLI 선점은 ACTIVE_GAME으로 중단하고 old ended 유지. retainLock/락 이양 제안은 불필요한 소유권 확장이므로 기각 |
| retry의 selectionVersion을 재발급하자 | 기각 | stale 요청이 새 current를 덮을 수 있다. 예약 CAS를 유지하고 CURRENT_CHANGED로 명시 실패 |
| resume에 setup defaults 유입 가능 | 수용 | setup은 start/replace-current 전용. resume은 저장된 config만 사용 |
| cancel-start를 추가하자 | 부분 수용 | 기존 probe/bootstrap deadline·실패/정리 상태를 명시. 별도 cancel-start 프로토콜은 첫 버전 범위에 추가하지 않음 |
| control 락 실패 시 우회 가능 | 수용 | 프로세스 간 파일 락, CONTROL_BUSY/CONTROL_UNAVAILABLE fail-closed를 명시 |
| Host validation·UI pause 실패 복원·global handlers | 수용 | Host allowlist, snapshot+command 재동기화, process signal/umask 1회 초기화 |
| CLI/lobby default 중복 | 수용 | shared setup의 두 profile과 CLI 위임/parity 테스트 |
| 구현 계획이 설계서에 없다 | 설계 결함으로 기각 | 사용자가 설계→계획 순서를 요청했고 계획은 별도 문서로 작성 중이었다. T1~T8, M1~M16을 별도 링크로 제공 |
| 문서 경로를 docs/design 또는 docs/handoff로 옮기자 | 기각 | 현재 repo에 docs/implementation/issue-147·150 설계/계획이 존재. reviewer의 기억이 현재 소스 증거를 대체하지 않음 |

추가 자체 확인: AI1~8은 engine/cli.js의 parseAi 계약으로 확인했다. 공개 gameEpoch는 기존 gameEpochOf(sessionToken)와 같은 non-secret identity로 고정했다. relay 종료 후에도 검증된 published snapshot reader로 current의 리뷰/요약을 읽게 했다. Windows CI는 현재 전체 suite가 아닌 플랫폼 gate만 수행하므로 이번 기능의 Windows 경계 테스트를 별도 연결하도록 계획에 반영했다.

## 설계 2차와 UX 선별

설계 2차 두 본문 verdict는 PASS_WITH_CHANGES, confidence는 각각 0.72였다. 남은 지적은 다음처럼 닫고 수정된 설계를 계획 리뷰의 고정 의존 문서로 함께 넘겼다.

| 지적 | 판단과 종료 증거 |
|---|---|
| pause 취소 시 delivered payload 회수 불가(high) | **신규 기능 부재라는 진단은 기각**, 문서 명료화는 수용. `server/action-receipts.js:274`는 이미 delivered row를 동일 requestId/digest/payload로 재전달한다. public proxy 금지는 loop private wait 호출을 금지하지 않는다. 설계 §6에 이 복구 경로와 OUTCOME_UNRESOLVED를 명시하고 계획 T3에 실제 회귀 gate를 지정 |
| unpark 뒤 stale out 사용 가능 | 수용. resumePlay가 gate를 열기 전에 step 동기화/view-only 게시를 수행해 최신 문맥을 run에 전달 |
| managed 파일 부재와 legacy 구분 | 수용. 명시 relay launch protocol/epoch/path를 lock/health identity에 결박, 파일 존재로 모드를 선택하지 않음 |
| aborted phase의 resolveForPhase/CLI/학습실 처리 | 수용. ABORTED_PHASES 별도 집합, FINAL_PHASES 이전 검사, GAME_ENDED 정상 종료, LLM 생성 없음, cleanup/학습실 소비자 표 |
| journal-only accepted end crash | 수용. startPaused/identity 검증 뒤 이미 확인받은 같은 operationId를 자동 완주. current 변경 시 재실행 금지 |
| journal/loop/catalog 락 순서 | 수용. accepted 쓰기 종료→loop 락→current 검증→예약→prepare→transaction commit. version 재발급 제안은 기각하고 stale 예약 audit 보존 |
| delivered drain이 paused 완료 조건인지 불명 | 명료화 수용. 엔진 대조와 ack 게시 완료를 paused predicate에 직접 연결 |

Grok UX 1차는 PASS_WITH_CHANGES(0.74). `메뉴로 돌아가기`/`메뉴 닫기`/`이어서 하기` 라벨과 목적지, paused 테이블의 고정 메뉴 진입점, 학습실 별도 영역/새 탭/paused 보존, 종료 뒤 `같은 설정으로 새 게임` 라벨 통일을 수용했다. 접근성 계약 부재라는 지적은 전달된 부분 문서에서 §9가 빠진 영향이므로 신규 설계 결함으로 보지 않았다. 원래 §9와 수정 UX를 함께 제공해 후속 UX 검토를 진행했다.

UX 2차도 PASS_WITH_CHANGES(0.84)였다. 로비의 새 게임 확인은 §1/§5의 replace-current와 T6의 확인 계약이 **어느 진입점에서든 적용**되므로 별도 기능 누락으로 보지 않는다. 로비에 current가 있다면 반드시 같은 종료 확인을 사용하고 취소는 current 유지라는 해석을 확정하며 브라우저 취소 사례로 검증한다. `모드 선택`을 `모드·설정`으로 바꾸자는 제안, 상태를 포함한 메뉴 버튼을 다시 바꾸자는 제안, 기존 접근성 계약에 숫자 크기를 추가하자는 제안은 필수 blocker로 채택하지 않았다. 요구와 직접 대응하는 현재 라벨, 실제 button/label, focus/좁은 화면 테스트로 구현 가능하다. 모달 우선순위 세부 DOM 구현과 탭 왕복은 T6/T8의 동작 gate로 넘긴다. 이 판단은 Grok의 PASS로 바꿔 기록하는 것이 아니라 작성자의 선별 수용 판정이다.

이 단계의 소스 미제공/플랫폼 timing uncertainties는 계획 T2/T3/T4/T5/T8의 실제 구현 검증으로 배정했다. 불명확한 결과를 성공으로 바꾸는 구현 선택은 허용하지 않는다. 두 라운드에 걸쳐 본질적 결정(입력 wait 소유권·park·abort·transaction recovery)을 고정했으므로 추가 산문 확대 대신 계획의 기계 검증으로 전환한다.

## 구현 계획 1차 선별

Opus는 PASS_WITH_CHANGES(0.74), Fable은 PASS_WITH_CHANGES(0.78)였다. 두 결과의 다음 지적을 수용했다.

- T2의 `signal handler는 CLI main만`이라는 표현을 launcher/loop에는 설치하지 않는다는 뜻으로 바로잡고, T5 app entry의 1회 설치/반복 loop listener count 테스트를 명시했다.
- 기본 진입 전환이 T8보다 먼저 보이는 순서를 T7a opt-in→T8 검증→T7b 기본 스킬 전환으로 바로잡았다. opt-in은 명시 `npm run app` entry다.
- `test/coach-control.test.js`에 aborted phase의 UNKNOWN_PHASE/잘못된 정리 성공 회귀 gate를 지정했다.
- `test:lobby:windows`의 정확한 파일 목록과 Windows matrix의 `Lobby lifecycle gates` step을 지정했다. full Windows suite는 현재 skip임을 유지해 표시했다.
- 브라우저 fixture의 기존 owned helper 재사용, `test:lobby:browser` CLI, requiredJourneyChecks 목록, release test의 누락 검증을 명시했다.
- T1 applyModeDefaults 수정 파일/engine child CLI parity 방법, replace-current API 목록, operationId 고정 방식, 실제 LLM smoke의 성공 기준을 보완했다.
- 자연 종료와 pause 경쟁, 외부 current 변경, managed control 삭제/경합, study 왕복/빈 로비의 세션 생성 없음, relay identity 검증을 구체적인 T8 gate로 넣었다.

파일 락 어댑터/scheduler API와 partial audit 내부 shape는 원칙/실패 계약/검증 대상이 이미 정해져 있어 구현자가 기존 모듈에 맞춰 정할 수 있는 세부 사항이다. 이 부분을 이유로 추가 제품 설계를 요구하지 않는다.

## 단계별 결과

| 단계 | 검토 | 상태 |
|---|---|---|
| 설계 1차 | Opus 5 + Fable 5.1 | PASS_WITH_CHANGES, 선별 수정 후 2차 검토 |
| 설계 2차 | Opus 5 + Fable 5.1 | PASS_WITH_CHANGES, 근거별 수정/기각 후 계획 의존 문서로 고정 |
| 제품 UX | Grok-4.6 | 2회 PASS_WITH_CHANGES, 유효 요구 반영 및 잔여 제안 작성자 판단으로 종료 |
| 구현 계획 1차 | Opus 5 + Fable 5.1 | PASS_WITH_CHANGES, 구체 실행/검증 순서 수정 |
| 구현 계획 2차 | Opus 5 + Fable 5.1 | **PASS(0.79) / PASS(0.82)**. 미해결 구현 착수 blocker 없음 |

최종 계획 리뷰의 비차단 의견은 상태×명령 table-driven 테스트 지정, profile 차이 테스트 소유 파일, Windows 목록에 session-pause 테스트 추가, 신규 app.lock 문구 및 설계 전이표 보완으로 닫았다. 이 마지막 변경은 작성자가 검증한 문서/테스트 계획 보완이며 독립 reviewer가 마지막 bytes까지 다시 읽었다고 주장하지 않는다. 최종 리뷰의 고정 target hash와 최종 산출물 hash를 [증거 파일](lobby-session-review-evidence.json)에 구분해 보존한다.

현재 소스로 확인할 수 없는 미래 런타임 동작에 관한 uncertainties는 T3/M4·M6의 relay restart/재전달 시험, T8의 실제 LLM smoke 및 platform gates에 명시 배정돼 있다. 모델의 PASS와 실제 구현 성공은 서로 다른 증거다. 이번 문서 작업에는 추가 사용자 결정이 필요한 미해결 제품/아키텍처 선택을 남기지 않았다.

## 구현 이후에 필요한 증거

문서 리뷰는 pause 안전성·프로세스 정리·게임 중복 생성 방지의 실측 증거가 아니다. 구현 계획 T1~T8/M1~M16의 테스트와 실제 브라우저 여정, 새 기능 Windows gates, 기존 지원 회귀 CI, 최종 독립 diff 리뷰가 남는다. 정확한 성능/LLM pause 지연/사용자 학습 효과도 이번 문서 작업에서 검증하지 않았다.

이번 작업의 완료 조건인 설계·구현 계획 작성, 단계별 리뷰 및 선별 수정, 구현 준비 판정을 충족했다. 설계 2라운드, 계획 2라운드, 별도 UX 2라운드에서 종료했다. 제품 코드·실사용 게임 상태·학습 기록은 변경하지 않았고 테스트/브라우저 실행은 계획만 작성했다.
