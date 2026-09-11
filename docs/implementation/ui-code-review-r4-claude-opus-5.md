UI 구현을 지정된 범위(표시·상호작용)로 읽었습니다. 아래는 소스 근거 기반 검토 결과입니다. (셸/브라우저 실행 없이 정적 판독만 했습니다.)

## 확인한 계약과 근거

**금액/BB** — `server/public/chip-format.js:4-20`은 BigInt 정수 연산으로 반올림·근사(`≈`)·`<0.01 BB`·부호를 처리하고, `Number.isSafeInteger` 실패나 `bb<=0`을 `—`/`BB 기준 없음`으로 분기합니다(0으로 바꾸지 않음). 칩 값은 표시에만 쓰이고 제출 경로(`app.js:1055-1062`)는 `amountEditor.state.value` 정수를 그대로 보냅니다. 단위 토글(`app.js:1155-1158`)은 `writeAmountField`의 focus 가드(`app.js:456-460`)와 `markAmountValid` 미호출 덕분에 입력 문자열·오류 상태·`pendingCorrection`을 보존합니다.

**현재 vs 과거 분모** — `engine/views.js:57-59`가 완료 핸드에서 `lastHand.blinds`를 쓰고(다음 레벨 분모 금지), 로그는 `table-presentation.js:13-20`의 hand_start 기반 컨텍스트, 복기는 `formatReplay().header.blinds`만 사용합니다(`app.js:867-868`). 충돌 시 `null`→칩만 표시로 안전하게 떨어집니다.

**입력 방어** — `amount-editor.js:3-9`의 정규식은 정수와 정확한 세 자리 쉼표만 허용하고 `2.5`/`-5`/`1e3`/`1,2`/전각을 구문 오류로 만듭니다. `submit()`(`amount-editor.js:33-40`)은 잠김·오류·`pendingCorrection`에서 `null`을 반환해 첫 클릭은 보정 확인, 둘째 클릭에서만 제출합니다. 클릭 핸들러가 DOM 값을 재파싱(`app.js:1057`)하므로 blur 이벤트 순서에 의존하지 않습니다.

**탈락/캐시 의미** — `engine/hand.js:613-626`에서 out은 정산 후 토너먼트에서만 설정되고 캐시는 매 핸드 `out=false`로 복원됩니다. `views.js:41,54`가 이를 그대로 공개하고, `seat-format.js:2-13`은 stack=0을 탈락으로 추론하지 않으며 `handInProgress` 부재를 `unknown`으로 다룹니다. `test/ui-public-contract.test.js:12-34`가 실제 정산 fixture로 0칩 올인 생존·동시 탈락·캐시 reset을 고정합니다.

**정적 자산** — study는 `tools/drill-server.js:17`에 route 1개만 추가, app는 `tools/app-server.js:80-88`에 shared 2개만 추가, relay는 기존 `serveStatic` 경계 검사로 제공(`server/server.js:894-928`). `test/drill-server.test.js:225-227`이 `app.js`/`table-design.css`/`lobby.js` 비노출을 확인합니다. 엔진 규칙·저장 포맷 변경 없음, 비공개 홀카드 경로 없음(`app.js:342-363`은 공개 showdown 로그와 `view.myCards`만 입력).

## 필수 수정

없습니다. 수용 기준에 대응하는 계약이 모두 코드와 테스트로 확인됩니다.

=== REVIEW ===
verdict: PASS
confidence: 0.72

findings:
- optional | `server/public/app.js:477-486` — `commitAmount()`가 DOM 값이 아니라 `amountEditor.state.text`를 재파싱한다. receipt 잠금(`pendingAction=true`) 중에는 `input` 리스너가 조기 반환(`app.js:1094-1100`)해 editor 텍스트가 낡으므로, 잠금 해제 직후 blur/Enter를 하면 사용자가 입력해 둔 숫자가 조용히 이전 값으로 되돌아간다. 재현: 상대 차례에 `#raise-amount`에 700 입력 → 내 차례로 전환 → Tab. 잘못된 금액을 보내지는 않으므로(클릭 경로는 `app.js:1057`에서 DOM 값을 재파싱) 안전 방향의 결함이며 심각도 낮음. 개선안은 `commit(legal, domText)`로 실제 필드 값을 받는 것.
- optional | `server/public/amount-editor.js:22` — 구문 오류와 "범위 밖 유효 정수"가 같은 `invalid` 플래그로 합쳐져 `app.js:465`의 오류 문구도 동일하다. 설계 §3.1은 전자를 제출 차단, 후자를 경고 후 clamp로 구분한다. 동작 결과(clamp→확인→제출)는 설계와 일치하므로 문구/상태 분리는 표현 개선 수준.
- optional | `server/public/app.js:288-307` — `paintPots`는 시그니처 비교 없이 매 paint마다 DOM을 재생성하고 포커스를 제거→복원한다. 로그·코치·참가자(`app.js:203,700,669`)가 채택한 "동일 데이터 갱신 생략"(설계 §6.2)과 어긋나며, 초당 SSE가 오는 동안 pot summary에 포커스를 둔 스크린리더 사용자에게 반복 포커스 이벤트가 간다. 열림/포커스 자체는 보존되므로 기능 결함은 아님.
- optional | `server/public/table-design.css:3-7` — `--bg:var(--ui-bg)`처럼 폴백 없이 토큰을 재매핑한다. `server/drill-public/drill.css:1`은 `var(--ui-bg,#0b1118)` 형태라 `/design-tokens.css`가 404여도 색이 유지되지만, 테이블 페이지는 같은 상황에서 배경·본문색·경계가 모두 초기값으로 떨어진다. 세 서버가 모두 디스크에서 서빙하므로 현재 실행 경로에서는 발생하지 않으나, 설계 §M12의 offline fallback 기준에 맞추려면 drill.css와 동일한 폴백 표기가 싸다.
- optional | `.github/workflows/test.yml:29-41` — `ui-browser` job이 `--out-dir` 없이 실행되어 `output/playwright/ui-journey/result.json`과 스크린샷이 아티팩트로 업로드되지 않는다. 계획 P6은 실패 시 체크 목록·스크린샷 증거 보존을 요구한다. `actions/upload-artifact` 한 단계로 충족된다.
- note | `server/public/table-presentation.js:7` — `aggregatePot`의 `legal.potTotal` 불일치 분기는 실전에서 사실상 도달 불가다. `engine/hand.js:318`의 `potTotal`과 `views.js:29-33`의 `buildPots`가 같은 `contribs`에서 나오므로 합이 항상 같다. 방어 코드로 두는 것은 타당하나, "팟 정보 확인 중" 복구 경로는 합성 fixture(`test/browser/ui-presentation-journey.mjs:154`)에서만 검증된다는 점을 인지할 것.
- note | `server/public/seat-format.js:22-25` — `mobileSeatSlot`은 `SLOTS`에 없는 인원수에서 전 좌석을 hero 좌표로 겹친다. `engine/cli.js:100-104`와 `shared/game-setup.js:95`가 AI를 8명으로 제한해 현재 도달 불가이므로 결함으로 보지 않지만, 좌석 상한이 바뀌면 즉시 겹침이 된다.

missing_tests:
- `app.js:1104-1118`의 ArrowUp/Down 기준값 선택(`parseChipInput(value) ?? raiseTo`)과 오류 상태에서의 화살표 복구는 어떤 단위/브라우저 테스트에도 없다. 모델 계층(`choose`)만 `test/table-presentation.test.js:32`에서 간접 확인된다.
- 복기 → 학습 카드 이동(`app.js:885-898`: `closeReplay`→`selectTab('training')`→details 열기→summary 포커스)의 회귀 테스트가 없다. 수용 기준의 "replay-to-training navigation"을 직접 증명하는 케이스가 필요하다.
- 설계 §6.3의 "복기/좌석 상세를 읽는 중 도착한 종합 리뷰는 보류 후 닫으면 열림"(`app.js:54-57,925-928`) 경로가 browser journey에 없다. journey는 seat-overlay의 Tab/Escape만 검증한다.
- `logBlindContexts`의 정상 fallback(hand_start에 blinds가 없고 handReplay에만 있는 경우)은 미검증이다. `test/table-presentation.test.js:15`는 충돌(null) 케이스만 덮는다.
- `participantSummary`의 `상태 확인 불가`(구버전 view) 및 `seatPresentation`의 legacy 분기가 실제 DOM(참가자 탭/좌석 상세)에서 어떻게 보이는지에 대한 렌더 테스트가 없다.
- 잠금(`pendingAction=true`) 중 입력→해제 후 blur 시퀀스(위 첫 번째 finding)에 대한 테스트가 없어, 텍스트 소실이 회귀로 고정되지 않는다.

uncertainties:
- 명령 실행이 금지되어 테스트·브라우저 여정(`test:ui:browser`)을 실제로 돌리지 못했다. 반응형 수치(겹침 0, 폰트 ≥12px, 컨트롤 ≥44px)는 `test/browser/ui-presentation-journey.mjs:51-58,86-87`의 assertion 존재만 확인했고 실측값은 검증하지 못했다.
- `server/public/style.css`(1100여 줄)와 `lobby.css`는 전부 읽지 않았다. `table-design.css`가 나중에 로드되어 동일 특이도 규칙을 이긴다는 전제(예: `style.css:1072,1082,1103`의 작은 min-height/font-size를 덮음)로 판단했다.
- `action-controller.js`와 `test/browser/learning-journey.mjs`는 범위 밖으로 두어 receipt 상태 기계 자체는 재검증하지 않았다. `pendingAction` 계약이 기존대로라는 전제에 의존한다.
- 이전 리뷰·증거 파일은 지시대로 읽지 않았다. grep 결과에 일부 리뷰 문서 라인이 섞여 표시됐으나 판단 근거로 쓰지 않았고, 모든 findings는 소스 직접 판독에서 도출했다.
- 병합된 런타임 기동 수정(`50448a9`)은 사이드카/플레이어 런타임 영역이고 이번 UI 변경 파일(`engine/views.js`, `server/public/*`, `tools/app-server.js`, `tools/drill-server.js`)과 겹치지 않는다는 점만 확인했다. git diff로 대조하지는 못했다.
