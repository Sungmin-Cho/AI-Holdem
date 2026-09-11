verdict: FAIL
confidence: 0.9 (크래시 결함은 코드 경로로 확정, 나머지는 정적 검토)

**findings**

1. **Critical · server/public/app.js:599-614, 670-672, 1237-1242, 1247-1256** — showdown 이벤트가 있으면 로그 렌더가 예외를 던져 테이블이 끊긴다.
   `logNode`는 `showdown`에서 `DocumentFragment`를 반환하는데, 새 `paintLog`는 반환값에 `row.dataset.logIndex=String(i)`를 대입한다. `DocumentFragment`에는 `dataset`이 없어 `TypeError: Cannot set properties of undefined`가 발생한다. 엔진은 콘테스트된 모든 핸드에서 `public showdown` 이벤트를 내보내고(engine/hand.js:539) 릴레이는 그대로 로그에 쌓는다(server/server.js:1135).
   영향: SSE 경로에서는 `es.onmessage`의 catch가 `setConn(false)`·`disconnect()`를 호출해 재접속 루프에 빠지고, 재접속·새로고침·terminal=1 기록 보기에서는 `renderSnapshot` → `paint` → `paintLog`가 던져 "현재 상태를 불러오지 못했습니다"로 끝난다. 즉 쇼다운이 한 번이라도 있었던 게임은 이후 UI를 열 수 없다.
   재현: 릴레이에 `{type:'showdown',reveals:[],mucks:[]}` 하나만 publish한 뒤 페이지를 열거나, 브라우저 여정에서 `narration` 대신 엔진 `applyAction`으로 쇼다운까지 진행한 실제 이벤트를 publish하면 된다. 기존 여정은 `narration`만 보내서 통과했다.
   수정 방향: `showdown` 분기가 단일 엘리먼트(예: `div.log-group`)를 반환하도록 바꾸고, `logNode`가 항상 `Element`를 반환한다는 계약을 테스트로 고정.

2. **Low · server/public/app.js:685, 997-998, 669** — 미읽음 카운트가 렌더되지 않는 `talk` 메시지까지 센다. 위로 스크롤한 상태에서 `messages`만 담긴 publish가 오면 "새 이벤트 1개" 버튼이 뜨지만 보이는 행은 늘지 않는다. 카운트는 렌더된 행 기준으로 계산해야 한다.

3. **Low · server/public/app.js:1078-1083, amount-editor.js:6** — focus 시 쉼표 포함 텍스트("1,250")를 그대로 두고 전체 선택만 한다. 캐럿을 끝에 두고 숫자 하나를 덧붙이면 "1,2500"이 되어 문법 오류로 처리된다. 설계의 엄격 쉼표 문법 자체는 맞지만, 설계 §3.1 "focus는 유효 raiseTo와 동등할 때만 정규화"의 정규화 대상이 쉼표 없는 정수여야 편집 회귀가 없다. 1078행 주석("편집 중에는 쉼표를 걷어내고")도 현재 동작과 어긋난다.

4. **Low · server/public/app.js:391-405** — `.plate`가 `<button>`이 되면서 내부에 `<div>` 자식(avatar-wrap, plate-info, plate-tag)이 들어간다. `button`의 콘텐츠 모델(phrasing content) 위반이다. aria-label로 보완되어 AT 결과는 정상이지만 마크업 검증에 걸린다. `span`으로 바꾸면 된다.

5. **Low · server/public/dialog-controller.js:12** — `node.tagName!=='SVG'` 비교는 HTML 문서의 인라인 `<svg>`(tagName이 소문자 `svg`)와 절대 일치하지 않아 스프라이트에도 `inert`가 걸린다. 렌더에 영향은 확인되지 않았고 의도한 예외가 동작하지 않는 죽은 조건이다.

**정상 확인한 계약**
- 금액: `formatAmount`는 BigInt 정수 연산으로 반올림·`≈`·`<0.01`·부호를 처리하고 unsafe/문자열/NaN을 `—`로 유지한다. 제출 payload는 `amountEditor.submit`이 반환한 정수 칩만 쓰며 단위 토글은 입력 텍스트·decisionId를 바꾸지 않는다(여정 `chip-payload`·`bb-toggle` 확인). pendingCorrection 첫 클릭 미제출·둘째 클릭 제출 순서도 코드와 테스트가 일치한다.
- 팟: `aggregatePot`의 raw 합은 `legalFor.potTotal`(contribs 합)과 항상 같아 진행 중 mismatch 오탐이 없고, 완료 핸드는 `lastHand.pots`(정산 potRecords)로 상세를 만든다.
- 탈락/상태: `out`·`handInProgress`는 engine/hand.js:615, 622, 643과 `legalSnapshot`의 idle 조건(hand.js:680)에 정확히 맞는다. 캐시 reset 안내 조건(`handInProgress===false && !gameOver && handNo>0`)은 finishHand의 reset 분기와 일치한다.
- 프라이버시: `revealedCards`가 현재 handNo 그룹의 공개 showdown만 사용하도록 좁아졌고, 좌석 상세·참가자·aria-label·action-summary는 공개 필드와 본인 카드만 노출한다. turnSummary에 새 필드가 섞이지 않는 것도 테스트로 고정됨.
- 라이프사이클: 다이얼로그 컨트롤러는 pause/resume를 호출하지 않고, 로비의 iframe inert는 dialog open 여부와 최신 state로 재계산된다. 리뷰 오버레이는 다른 다이얼로그가 열려 있으면 보류되고 닫힐 때 microtask로 열린다.

**missing_tests**
- 실제 핸드 이벤트 혼합(hand_start/action/street/showdown/pot_award/bust/game_over)을 publish하는 브라우저 또는 DOM 렌더 테스트. 현재 여정은 `narration`만 보내 결함 1을 놓쳤다. `logNode`가 항상 `Element`를 반환한다는 단위 테스트도 없다.
- M2 브라우저 부분: BB=50 복기를 BB=100 현재 테이블에서 열어 복기 금액이 50 기준인지. 지금은 `logBlindContexts` 단위만 있다.
- M11 알림: `#seat-announcement`가 out false→true 전이에서 1회 채워지고 reload/재접속에서 반복되지 않는다는 assertion이 없다.
- M8: 좌석/복기 다이얼로그가 열린 동안 도착한 종합 리뷰 보류와 닫은 뒤 자동 열림, Tab/Shift+Tab 순환. `dialog-controller.js` 자체 단위 테스트가 없다.
- 입력 핸들러 DOM 배선: Enter가 제출하지 않는 것, 오류 상태에서 ArrowUp이 마지막 유효값 기준으로 대체하는 것, 오류 중 fold/call이 동작하는 것. 여정은 fill+Tab+클릭 조합만 검사한다.
- 팟 mismatch → "팟 정보 확인 중" → 정상 publish 후 회복, 완료 화면 pots 빈 배열 → "팟 정보 없음"의 DOM 경로.
- `#cash-reset-note` 표시/숨김과 토너먼트 `누적 손익` 세그먼트 숨김의 DOM 확인.
- 미읽음 카운트가 `talk`를 제외하는지(결함 2 회귀).

**uncertainties**
- `#seat-announcement`는 다음 view 메시지에서 즉시 빈 문자열로 덮이므로, 탈락 직후 publish가 연달아 오면 스크린리더가 읽기 전에 사라질 수 있다. 실제 AT로 확인하지 않았다.
- 대비 4.5:1·3:1은 토큰 값으로 개략 추정만 했고 측정하지 않았다.
- 전체 회귀 재실행 결과는 사용자 보고(진행 중)에 의존하며 이 검토에서 실행하지 않았다.
- 스프라이트 `<svg>`에 걸리는 `inert`가 `<use>` 참조 렌더에 영향을 주지 않는다는 판단은 표준 해석이며 브라우저별로 실측하지 않았다.
