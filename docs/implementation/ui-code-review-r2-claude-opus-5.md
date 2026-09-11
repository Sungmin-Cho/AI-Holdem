verdict: FAIL

confidence: high (정적 독해 기반. 코드 실행·브라우저 측정은 하지 않았고, F1은 코드 경로만으로 결정적으로 확인됨)

## findings

### F1 — [Blocker] 쇼다운 이벤트가 로그에 들어오는 순간 테이블 렌더가 TypeError로 죽는다
- **file/lines:** `server/public/app.js:671-672` (신규 키 기반 로그 렌더), 충돌 대상 `server/public/app.js:599-614` (`case 'showdown'`), 이벤트 출처 `engine/hand.js:536-543`
- **내용:** `logNode()`는 `showdown`에서만 `document.createDocumentFragment()`를 돌려준다(`app.js:600,613`). 새 코드는 반환값에 무조건 `row.dataset.logIndex = String(i)`를 쓴다. `DocumentFragment`에는 `dataset`이 없으므로 `undefined.logIndex` 대입 → `TypeError`. 기존 코드는 `list.append(logNode(...))`뿐이라 프래그먼트가 정상 동작했고, 이 회귀는 이번 diff에서 새로 생겼다.
- **파급:** `paintLog()` → `paint()` → `render()`/`renderSnapshot()` 전체가 throw. SSE 경로는 `app.js:1237-1243`의 `catch`가 삼켜 `setConn(false)` + `actionController.disconnect()`를 부르고, 재연결 시 `getSnapshot→renderSnapshot→paint`가 같은 지점에서 다시 throw해 `es.onopen`의 catch(`app.js:1253-1256`)로 떨어진다. 즉 **첫 쇼다운 이후 테이블이 "재접속 중…" 상태로 영구히 멈추고 액션 바가 갱신되지 않는다.** contested 핸드는 거의 매 세션 발생하므로 실사용 첫 핸드에서 재현된다.
- **repro:** (a) 아무 게임이나 쇼다운까지 진행, 또는 (b) `POST /api/publish`로 `events:[{type:'showdown',reveals:[{playerId:'p1',cards:['Ah','Kd']}],mucks:[]}]`를 보낸다 → 콘솔에 `TypeError: Cannot set properties of undefined (setting 'logIndex')`, 연결 표시가 off로 전환.
- **왜 테스트가 못 잡았나:** `test/browser/ui-presentation-journey.mjs:26,82-86`은 `narration`과 `dealt.events`(hand_start/blinds_posted)만 publish한다. `showdown`/`pot_award`/`street`를 publish하는 케이스가 없고, `paintLog`에 대한 DOM 단위 테스트도 없다.
- **수정 방향(최소):** `logNode`의 showdown 분기가 프래그먼트 대신 래퍼 엘리먼트(예: `el('div','log-group')`)를 반환하게 하거나, `row.dataset`가 없으면 래핑하도록 호출부에서 방어. 어느 쪽이든 `appendOnly` 재사용 경로와 `previous` 맵 키 정합성을 함께 유지해야 한다.

### F2 — [Medium] clamp 확인 클릭이 "아무 일도 안 일어나고 설명도 사라지는" 무응답이 된다
- **file/lines:** `server/public/app.js:1046-1053`, `server/public/app.js:455-459`, `server/public/amount-editor.js:33-39`
- **내용:** 설계 §3.1/플랜 M3의 "blur-clamp → 첫 click 미제출 → 둘째 click 제출" 자체는 정확히 구현됐다. 그러나 첫 click에서 `submit()`이 `pendingCorrection`을 **소비한 뒤** 곧바로 `markAmountValid(!state.invalid)`가 실행되고(`app.js:1050`), `markAmountValid`는 유효 + `pendingCorrection===false`이면 `#amount-error`를 빈 문자열로 지운다(`app.js:458`). 결과적으로 사용자는 "레이즈를 눌렀는데 아무 일도 없고, 이유 설명까지 사라진" 상태를 본다. `#amount-error`는 `role="status"`라 스크린리더에도 아무 것도 남지 않는다. 설계가 요구한 "보정값을 명시"가 정확히 필요한 순간에 취소된다.
- **repro:** 레이즈 입력에 `9999999` → Tab(blur) → `#amount-error`에 "합법 범위로 보정했습니다…" 표시 → `#btn-raise` 1회 클릭 → POST 0건이면서 `#amount-error.textContent === ''`.
- **수정 방향:** 플래그를 소비하는 click 경로에서는 "보정된 금액 N으로 다시 눌러 제출하세요" 같은 확인 문구를 유지/갱신한다(소비 전 플래그를 읽어 메시지를 결정).

### F3 — [Low-Medium] 로비 클라이언트 사전 검증 실패가 잘못된 원인(연결 문제)으로 안내된다
- **file/lines:** `server/public/lobby.js:277-284`(신규 `normalizeSetup` 가드), `server/public/lobby.js:148-152`, `shared/game-setup.js:21-26`
- **내용:** 제출 전 `normalizeSetup`이 던지는 오류는 `{code:'INVALID_SETUP', field}`이고 `message`는 `"게임 설정을 확인하세요: mirrorSelf"`다. `showError()`는 `errorMessages[e.message]`로만 조회하므로 매칭에 실패하고 **"요청을 완료하지 못했습니다. 연결과 현재 게임 상태를 확인해 주세요."**를 보여준다. 서버가 거절했을 때는 `INVALID_SETUP`(=`e.message`)이 정확한 문구로 매핑되던 경로였으므로, 이번 변경이 **안내 품질을 회귀시켰다**. `e.field`가 있는데도 쓰이지 않는다.
- **repro:** 상세 설정에서 `상대 행동 방식 = LLM 플레이어` + `내 성향을 따라 하는 상대` 체크 → 게임 시작 → 연결 문제라는 잘못된 문구.
- **수정 방향:** `showError`에서 `errorMessages[e.code] ?? errorMessages[e.message] ?? …`로 조회하고, `e.field`를 문구에 덧붙인다.
- 참고: 클라이언트/서버가 같은 `shared/game-setup.js`를 쓰므로 **거짓 거절(서버는 받는데 클라가 막는)** 위험은 없다. `boundaries.test.js:144-145`의 예외도 `normalizeSetup` 단일 바인딩으로 정확히 좁혀져 있다.

### F4 — [Low] 뷰가 사라질 때 좌석 노드가 DOM에 남는다
- **file/lines:** `server/public/app.js:358-365`
- **내용:** `seatRoot.replaceChildren()`이 제거되고 diff 방식으로 바뀌면서, `seats.length === 0`(뷰 null/좌석 없음)일 때 `betRoot`만 비우고 `return`한다. 이전 좌석 플레이트·카드가 그대로 남아 종료/초기화 화면에 유령 좌석이 보일 수 있다. 같은 이유로 `paintParticipants`도 호출되지 않아 참가자 탭이 정지된다.
- **repro:** `ui.view`가 값→`null`로 전이되는 렌더(예: 뷰 없는 snapshot 재수신) 후 `#seats`에 자식이 남아 있음.

### F5 — [Low] 로그의 "콜 금액 표시"는 실제로 렌더되지 않는다(사문 코드)
- **file/lines:** `server/public/app.js:588-590` vs `engine/hand.js:836-839`
- **내용:** 공개 `action` 이벤트는 `if (action === 'raise') payload.amount = amount;` 로만 금액을 싣는다. 따라서 `item.action === 'call'` 분기는 `item.amount != null`을 절대 만족하지 못한다. 의도한 개선이 출시되지 않으며, "콜 금액도 BB로 보인다"는 검증되지 않은 가정이 코드에 남는다. (엔진 이벤트 페이로드 변경은 이번 범위 밖이므로, 분기를 제거하거나 별도 이슈로 분리할 것.)

### F6 — [Low] 복기 버튼 행 키가 `replay.unavailable` 변화를 반영하지 않는다
- **file/lines:** `server/public/app.js:661`, `server/public/app.js:550-555`
- **내용:** 행 키는 `Boolean(ui.handReplays?.[item.handNo])`(존재 여부)만 본다. `upsertHandReplays`가 같은 handNo의 행을 `unavailable:true` → 정상 행으로 교체해도 키가 동일하므로 행이 재생성되지 않아 `btn.title`(사유 문구)이 stale로 남는다. 오버레이 내용 자체는 클릭 시점에 다시 계산되므로 영향은 툴팁에 국한된다.

### F7 — [Low, a11y] 액션 요약이 카드 코드를 원문 그대로 읽는다
- **file/lines:** `server/public/app.js:512`
- **내용:** `내 카드 ${(view.myCards??[]).join(' ')}` → "Ah Kd". 좌석/보드 카드는 `cardNode`가 `aria-label`(예: "A 하트")을 붙이는데(`app.js:132-133`), 모바일 일반 흐름 요약만 코드 문자열이다. 설계 §5.2가 요구한 "액션 위치에서 내 카드 확인"은 시각적으로는 충족하지만 낭독 품질이 다른 표면과 불일치한다. `formatCard`/`cardLabel` 재사용으로 해결 가능.

### 확인했고 결함 아님(오탐 방지용 기록)
- `aggregatePot`의 `legal.potTotal` 대조: `potTotal(hand)`는 `contribs` 총합(`engine/hand.js:316-318`), `buildPots`는 폴드 기여분도 층에 포함(`engine/sidepots.js:13-25`)하므로 합이 항상 일치한다 → 상시 `팟 정보 확인 중`으로 빠지는 문제 없음.
- `@container stage (...)` 규칙: 이름 있는 컨테이너가 `style.css:153-154`에 존재하므로, `table-design.css:28`이 `.table-wrap`을 이름 없는 컨테이너로 만들어도 `stage` 질의는 조상으로 정상 해석된다.
- `out`/`handInProgress`는 additive 공개 필드이며 `turnSummary`(`engine/views.js:151-166`)는 명시 필드만 문자열화한다 — 프롬프트/프라이버시 회귀 없음(`test/ui-public-contract.test.js:39`가 고정).
- 캐시 모드는 정산 시점에 `seat.stack` 복원 + `out=false`가 이미 엔진에서 일어난다(`engine/hand.js:613-616`) → `#cash-reset-note` 조건(`app.js:269`)은 실제 상태와 일치.
- `revealedCards()`의 handNo 그룹 매칭(`app.js:155-171`), `showBacks/showButton/showBet`의 out·handInProgress 게이팅(`seat-format.js:10-12`)은 설계 §4.2와 일치.
- 단위 토글이 제출 payload를 건드리지 않음: 토글은 `displayUnit`만 바꾸고 `raiseTo`/`amountEditor.state`를 수정하지 않는다(`app.js:1145-1149`).
- app/relay/study 3개 서버의 신규 asset 서빙 및 shared allowlist 2개 추가는 경로·테스트 모두 확인됨(`tools/app-server.js:78-92`, `tools/drill-server.js:17`, `test/ui-public-contract.test.js:47-50`, `test/drill-server.test.js:225`).
- 모바일 슬롯표(`seat-format.js:20-25`)는 설계 §5.2 표와 2–9인 전부 정확히 일치.

## missing_tests
1. **`paintLog`/`logNode`의 DOM 단위 또는 브라우저 테스트.** 현재 `test/browser/ui-presentation-journey.mjs`는 `narration`과 `hand_start/blinds_posted`만 publish한다(`:41,:82-86`). `showdown`(프래그먼트 반환), `pot_award`, `street`, `level_up`, `game_over`, `bust`를 포함한 로그를 렌더하는 케이스가 있었다면 F1은 즉시 잡혔다. **이 한 건이 이번 구현의 가장 큰 검증 구멍이다.**
2. `server/public/dialog-controller.js` 단위 테스트 부재. 포커스 트랩(Tab/Shift+Tab 순환), Escape, `previousInert` 저장/복원, 모달 교체(`open` 중 `open`), trigger 복원 조건(`trigger.closest('[inert]')`)이 어느 테스트에서도 직접 검증되지 않는다.
3. `#amount-error` 문면 전이 테스트 부재. 여정은 POST 건수만 본다(`:65,:70,:94`). F2처럼 "제출 안 됨 + 설명 없음"은 통과한다. clamp→첫 click→둘째 click 각 단계의 `#amount-error` 텍스트를 assert해야 한다.
4. 로비 무효 설정 제출 시 표시 문구 테스트 부재(F3).
5. `revealedCards()`의 handNo 그룹 매칭 회귀(직전 핸드 reveal이 다음 핸드로 새지 않음) 단위 테스트 부재 — `paintSeats` 경로에 묶여 있어 순수 함수로 뽑히지 않았다.
6. 좌석 노드 재사용이 `.plate` 포커스를 유지한다는 assertion 부재(플랜 P4 명시 요구). 여정은 Escape 후 trigger 복원만 본다(`:79`).
7. `paintSeats(null)` 같은 뷰 소멸 경로(F4) 테스트 부재.

## uncertainties
- 테스트 실행·브라우저 측정을 하지 않았다. F1은 코드 경로만으로 결정적이지만, 나머지 심각도는 실행 확인 없이 독해로 매겼다.
- 대비비(일반 4.5:1, 큰 텍스트/컨트롤 3:1)는 측정하지 않았다. 설계 §7 수용 기준이므로 별도 측정표가 필요하다.
- `--ci` 여정은 390/1440 × 6/9인만 돈다(`:39,:45`). 601–800px 컨테이너 질의 분기와 200% 확대용 `@container stage (max-width:300px)` 폴백은 로컬 전체 모드 결과에 의존하며, 이번 리뷰에서 재현하지 않았다.
- "모바일 액션을 sticky 대신 일반 흐름 + hero/pot/cards 요약으로 처리"한 판단은 설계 §7("액션 위치까지 스크롤하면 내 카드·내 스택·현재 팟 요약과 합법 액션을 함께 확인")에 부합한다고 본다. `#action-summary`가 그 계약을 실제로 충족하며(`app.js:510-512`), 여정의 `short-viewport` 검사도 문면이 아니라 겹침·요약·44px을 본다(`:72-73`). 이 항목은 결함으로 보지 않았다.
- F5는 엔진 이벤트 페이로드를 바꾸지 않는다는 범위 제약 아래 "분기 제거"가 맞는 방향이라고 판단했으나, 로그에 콜 금액을 실제로 노출하려는 의도였다면 별도 설계 결정이 필요하다.

**FAIL 사유:** F1은 정상 플레이 첫 쇼다운에서 UI가 영구 정지하는 회귀이며, 병합 전 수정과 그 회귀 테스트(missing_tests 1) 추가가 반드시 필요하다.
