리뷰를 마쳤습니다. 요구사항 문서 2건, 핵심 소스 14개 파일, 테스트 6개 파일, CI 워크플로를 읽었고 셸 실행이나 파일 변경은 하지 않았습니다.

**전체 판단.** 수용 기준의 핵심 계약은 코드에서 확인됩니다. 칩은 정수 그대로 유지되고 BB는 `chip-format.js`에서 BigInt로 표시만 계산합니다. 탈락은 `engine/views.js:41`의 엔진 `seat.out`만 근거로 하고 0칩 올인은 생존으로 처리됩니다. 소수·지수·부호 입력은 `amount-editor.js:6`의 정규식에서 거부되어 POST가 나가지 않으며, clamp된 금액은 첫 클릭에서 확인만 하고 둘째 클릭에서 제출합니다. 서버 변경은 app 서버 allowlist 2개 항목과 study 서버 CSS 라우트 1개뿐입니다. 비공개 카드는 공개 로그의 showdown과 `view.myCards`만 사용합니다. 아래 지적은 모두 표시·상호작용 수준이며 엔진·저장 포맷에는 영향이 없습니다.

=== REVIEW ===
verdict: PASS_WITH_CHANGES
confidence: 0.78

findings:

필수 교정 (낮은 심각도, 스펙 불일치):

1. **분모 없는 로그 금액이 "칩만"이 아니라 "N 칩 / BB 기준 없음"으로 렌더된다.** `server/public/app.js:90-93`의 `amountText`는 `formatAmount`의 secondary를 항상 이어 붙이고, `chip-format.js:8`은 bb가 없으면 secondary로 `BB 기준 없음`을 돌려준다. `app.js:597`(action)과 `app.js:627`(pot_award)에서 `logBlindContexts`가 null을 준 행마다 이 문구가 반복된다. 재현: hand_start 없는 구버전 snapshot을 열고 로그 탭 확인. 설계 §3.1 표 "해당 그룹 분모 없으면 칩만" 위반. 좌석 상세의 `이번 스트리트 베팅`(`app.js:217`)도 동일 경로. 수정은 `amountText`에서 secondary가 `BB 기준 없음`일 때 primary만 반환하거나, 로그 전용 formatter를 두는 것.

2. **범위 밖 유효 정수 상태의 ArrowUp/Down이 마지막 유효 raiseTo가 아니라 입력 텍스트를 기준으로 움직인다.** `app.js:1115` `parseChipInput(ev.target.value) ?? raiseTo`는 "9999999"처럼 구문은 유효하나 범위 밖인 텍스트에서 9999999+step을 기준으로 잡아 항상 max로 점프한다. 설계 §3.1 "오류 상태이면 마지막 유효 raiseTo를 기준으로" 위반. 수정: `amountEditor.state.invalid ? raiseTo : parsed`.

선택 개선:

3. **복기→학습 카드 이동 직후 보류된 종합 리뷰가 자동으로 열려 이동을 덮는다.** `app.js:54-57`의 dialog onClose는 microtask로 `paintReview`를 호출하고, `app.js:889-896`의 학습 카드 버튼은 `closeReplay()` 뒤 training 탭과 카드 summary에 포커스를 준다. 게임 종료 후 복기 중 리뷰가 도착한 경우, 카드로 포커스가 간 직후 리뷰 오버레이가 열리며 main이 inert가 된다. `learning-journey.mjs:260`은 gameOver가 아닌 상태에서만 검증한다. 명시적 학습 이동은 리뷰 재개를 한 번 건너뛰거나 뱃지만 유지하는 편이 낫다.

4. **`paintReview`가 컨트롤러와 무관하게 overlay.hidden을 직접 조작한다.** `app.js:925-926`에서 `show`가 false가 되면(예: 이후 메시지의 `review`가 null/빈 문자열) 오버레이는 숨겨지지만 `dialogs.active`가 남아 페이지 inert가 풀리지 않는다. Escape로는 복구되지만 마우스 사용자는 갇힌다. `show`가 false이고 `dialogs.active===overlay`면 `dialogs.close()`를 호출해야 한다.

5. **모바일(≤600px)과 601–800px 밀집 테이블에서 현재 스트리트 베팅 마커가 완전히 숨겨진다.** `table-design.css:102,134` `.bet-marker {display:none}`. 팟 총액에는 포함되지만 누가 얼마를 걸었는지는 좌석 상세를 열어야만 보인다. 설계 §3.2가 보조 칩 표기 이동은 허용하지만 베팅 자체의 숨김은 명시하지 않았다. 플레이트 태그에 베팅 BB를 넣는 정도의 대체가 필요하다.

6. **구버전 view(handInProgress 부재)에서 딜러 버튼이 사라진다.** `seat-format.js:11` `showButton`은 `handInProgress === true`를 요구하므로 legacy snapshot에서는 진행 중에도 D가 표시되지 않는다. 설계 §4.1 "handInProgress 부재에서는 기존 표현 유지"와 어긋난다. `view.handInProgress !== false`로 완화하면 된다.

7. **범위 오류와 구문 오류의 안내문이 동일하다.** `app.js:465`는 두 경우 모두 "칩 정수와 합법 범위를 확인해 주세요"와 `aria-invalid=true`를 쓴다. 설계는 범위 밖을 "경고", 구문을 "오류"로 구분한다. 동작은 맞으므로 문구 분리만 권한다.

8. **모바일 "접이식 상세 문맥"은 구현되지 않았다.** `index.html:18-25` meta 세그먼트 6개가 `table-design.css:105-109`에서 wrap될 뿐이다. 수용 기준(가로 스크롤·겹침)은 충족하므로 정보 구조 차이로만 기록한다.

9. **성능.** `app.js:669-670`은 매 SSE마다 로그 전체를 JSON.stringify 두 번 한다. 수천 이벤트에서 체감될 수 있으나 정확성 문제는 아니다.

확인된 보존 사항: `engine/views.js`는 additive 필드 2개만 추가하고 `turnSummary`에 노출하지 않는다(`ui-public-contract.test.js:39`). `tools/app-server.js:80-88` allowlist는 `game-setup.js`·`player-budget.js`만 추가했고 `shared/game-setup.js:2`는 브라우저 안전 import 하나뿐이다. `tools/drill-server.js:17`은 `/design-tokens.css` 한 항목만 추가했다. 팟 정합성은 `engine/hand.js:316`의 potTotal과 `sidepots.js:3` buildPots가 같은 contribs 합이므로 진행 중 거짓 mismatch가 나지 않는다. 캐시 리셋 안내는 `hand.js:613-616`이 정산 안에서 스택을 되돌리므로 "이미 반영된 스택" 문구가 사실과 맞는다. dialog overlay 4개는 body 직계 자식이라 `dialog-controller.js:12`의 inert 부여가 오버레이 자신을 막지 않는다. `paintPots`는 같은 handNo에서 details open과 summary 포커스를 복원하고 handNo 변경 시 초기화한다.

missing_tests:

- `test/table-ux.test.js`에 플랜 P2가 요구한 blur/Enter/focus/slider/preset/화살표 전이 테스트가 없다. `amount-editor` 검증은 `table-presentation.test.js`의 순수 함수 수준뿐이고 app.js 이벤트 핸들러 경로(특히 blur 없이 바로 레이즈 click하는 범위 밖 입력, 화살표 기준값)는 브라우저 여정에서도 Tab을 먼저 누르므로 미검증.
- `dialog-controller.js` 단위 테스트가 없다. 열린 상태에서 다른 overlay로 교체, trigger가 inert 안에 있을 때의 포커스 복원, `paintReview`의 hidden/active 불일치(발견 4)를 고정할 테스트가 필요하다.
- hand_start가 없는 로그(구버전 snapshot)의 행 텍스트가 칩만인지 확인하는 테스트가 없다(발견 1).
- gameOver + 리뷰 보류 + 복기 → 학습 카드 이동 시 포커스와 오버레이 상태(발견 3).
- handInProgress 부재 legacy view의 D 버튼·카드 뒷면 유지 회귀(발견 6). `seat-format.test.js`는 부재 케이스를 status 문자열만 검증한다.
- 로비 `updateSetupSummary`의 cash/tournament/LLM/invalid 요약 문자열 단위 테스트가 없다(플랜 P3 완료 조건).
- 601–800px 컨테이너 구간과 667px 높이의 is-crowded 배치는 CI(`--ci`)에서 390/1440만 돌므로 로컬 전체 모드 결과에 의존한다.

uncertainties:

- 테스트와 브라우저 여정을 실행하지 않았고 스크린샷·대비 측정값도 보지 않았다. CSS 판단은 소스 읽기 기반이다.
- `test/drill-server.test.js`·`test/app-server-security.test.js`가 새 라우트를 어떻게 검증하는지는 읽지 않았다. `ui-public-contract.test.js:47-49`가 app 서버 asset과 404를 덮는 것만 확인했다.
- `table-design.css:28`이 `.table-wrap`의 container-type을 size에서 inline-size로 바꿨다. `style.css:177`의 `100cqh` 참조는 `table-design.css:29`가 `--tw`를 덮어써 무력화되지만, 다른 `cqh` 사용처가 남아 있는지 style.css 전체를 훑지 않았다.
- 숨겨진 로그 패널에서 `paintLog`의 stick 판정이 0 치수로 항상 true가 되는 동작은 기존 semantics로 보이나, 탭 전환 후 스크롤 위치 보존 여부는 브라우저별로 다를 수 있다.
- 발견 4의 트리거(review가 설정 뒤 falsy로 갱신되는 publish)가 실제 game-loop에서 발생하는지 확인하지 않았다.
