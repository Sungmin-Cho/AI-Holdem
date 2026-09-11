필요한 정보는 모두 모였습니다. 이제 최종 리뷰를 작성합니다.

verdict: PASS_WITH_CHANGES

confidence: 0.75. 근거는 대상 소스 전부와 인접 엔진·컨트롤러·테스트를 직접 읽은 정적 검토다. 테스트나 브라우저를 직접 실행하지 않았고, 사용자가 보고한 게이트 통과 결과는 그대로 신뢰하지 않고 코드로만 판단했다.

## 검토 결과 요약

차단 결함은 없다. 설계의 핵심 계약은 코드가 지킨다.

- **금액 표시와 액션 분리**: `formatAmount`는 BigInt로 반올림 전 0.01 미만 여부를 판정하고 근사에 `≈`를 붙인다. 제출 경로는 `amount-editor.js`의 정수 파싱을 거쳐 `action-controller.js:161`에서 safe integer만 허용한다. 단위 토글은 `displayUnit`만 바꾸고 편집기 상태를 건드리지 않는다.
- **팟 정합성**: 진행 중 `state.hand.pots`는 존재하지 않으므로 `views.js:29`의 buildPots 결과가 쓰이고, 그 합은 `hand.js:316`의 contribs 합과 항상 같다. 사용자 차례마다 "팟 정보 확인 중"이 뜨는 거짓 불일치는 발생하지 않는다.
- **탈락·완료 상태**: `seatPresentation`은 엔진 `out`만 믿고, `handInProgress=false`에서 folded/allIn/뒷면/D를 지운다. 캐시 리셋은 `hand.js:613`에서 finishHand 안에서 즉시 적용되므로 `app.js:269`의 안내 시점과 맞는다.
- **자산·보안**: app 서버 CSP는 self만 허용하고 Google Fonts 링크는 세 HTML 모두에서 제거됐다. shared allowlist는 두 파일만 추가됐고 study 서버는 토큰 CSS 한 경로만 노출한다. design-tokens.css는 ASCII만 포함한다.
- **읽기 지속성**: 로그는 키 기반 append/재사용과 anchor 복원, 참가자·코치·복기는 signature 생략, 좌석 plate 버튼은 노드 재사용으로 포커스를 유지한다.

## findings

모두 비차단이다. 심각도 순.

**F1 (Medium, 비차단) 데스크톱 oval과 모바일 slot의 좌석 회전 방향이 거울상이다.**
`server/public/app.js:304-311`의 `ovalPoint`는 index 1을 hero 오른쪽 아래에 놓고 왼쪽으로 돌아 내려온다. `server/public/seat-format.js:20-25`의 slot은 설계 §5.2대로 index 1을 왼쪽 아래(L3)에 놓고 오른쪽으로 돈다. 순환 순서는 같지만 화면상 방향이 반대다. 재현: 6인 게임을 1440px에서 보면 첫 상대가 hero 오른쪽 아래, 390px로 줄이면 왼쪽 아래로 이동한다. 601~800px 컨테이너에서는 7인 이상만 slot을 쓰므로(`table-design.css:97-103`) 같은 폭에서 인원에 따라 방향이 갈린다. 설계의 "화면 너비에 따라 임의 순서 변경하지 않는다"와 어긋난다. 수정 범위: `ovalPoint`의 x를 `50 - rx * bulge(Math.sin(angle))`로 바꿔 oval도 시계방향으로 맞추는 한 줄이면 된다. bet 마커도 같은 함수를 쓰므로 함께 따라온다.

**F2 (Low) 정산 팟 상세 `<details>`가 매 paint마다 재생성되어 열림과 포커스를 잃는다.**
`server/public/app.js:288-300`은 `box.replaceChildren`로 팟 영역을 통째로 다시 만든다. 완료 핸드에서 "정산 팟 상세"를 연 뒤 코치 노트나 학습 항목 SSE가 도착하면 details가 닫히고 summary에 있던 포커스가 사라진다. 설계 §6.2의 "SSE 갱신이 열림/포커스를 초기화하지 않는다"에 위배된다. 수정: `paintParticipants`처럼 `[view.pots, view.handInProgress, view.legal?.potTotal, displayUnit, view.blinds]` signature가 같으면 생략하거나, 재생성 전 `open`과 summary 포커스를 저장해 복원한다.

**F3 (Low) 탈락 announce 요소가 dialog 열림 중 inert 서브트리 안에 있다.**
`index.html:32`의 `#seat-announcement`는 `<main>` 안에 있고, `dialog-controller.js:12`는 dialog가 열리면 `main`을 inert로 만든다. 좌석 상세나 복기를 보는 도중 bust가 도착하면 `app.js:992-994`가 텍스트를 한 번만 쓰므로 그 안내는 보조기술에 전달되지 않고 재방송도 없다. 수정: 해당 `<p>`를 body 직계로 옮기고 dialog 컨트롤러의 제외 목록에 넣는다.

**F4 (Low) 복기의 "학습 카드" 버튼이 포커스를 숨겨진 패널에 남긴다.**
`app.js:879-890`은 `closeReplay()`로 포커스를 로그 탭의 복기 버튼에 복원한 뒤 `selectTab('training')`으로 그 패널을 숨긴다. 결과적으로 포커스가 body로 떨어진다. 수정: 카드를 연 뒤 `card.querySelector('summary')?.focus()`를 호출한다.

**F5 (Low) 로그 탭이 숨겨진 동안 도착한 이벤트는 미읽음 버튼을 만들지 않는다.**
`app.js:653`의 `stick`은 숨김 패널에서 모든 치수가 0이라 항상 true가 되고 `app.js:681`에서 `_unread`를 0으로 만든다. 다른 탭에서 읽던 사용자가 돌아오면 "새 이벤트 N개"가 없다. 설계는 "과거 읽는 중"만 명시하므로 위반은 아니지만 의도와 어긋난다. 수정: `list.clientHeight === 0`이면 stick 판정을 건너뛰고 이전 unread를 유지한다.

**F6 (Low, 시각 폴리시) 분모 없는 로그 행마다 "BB 기준 없음"이 반복된다.**
`app.js:90-93`의 `amountText`가 primary와 secondary를 항상 결합하므로 `chip-format.js:8`의 보조 문구가 hand_start가 없는 legacy 로그의 모든 액션 행에 붙는다. 설계 §3.1 표는 로그에서 "해당 그룹 분모 없으면 칩만"이라 한다. 수정: `amountText`에서 secondary가 `BB 기준 없음`이면 생략하고, 좌석 상세와 상단에서만 그 문구를 남긴다.

**F7 (Low, 선택) 로비 요약이 숨겨진 LLM 대기 필드 오류를 policy 모드에서도 보고한다.**
`lobby.js:266-274`는 runtime과 무관하게 `normalizeSetup`에 playerSoftMs/playerHardMs를 넘기고, `game-setup.js:71-76`이 먼저 검증한다. LLM 필드를 비운 뒤 policy로 바꾸면 보이지 않는 필드 때문에 "설정 확인 필요"가 뜬다. 서버도 같은 값을 받으므로 제출 실패는 기존 동작이며, 요약 문구만 필드명이 사용자에게 보이지 않는 점이 문제다. 수정은 선택 사항으로, policy 모드에서는 두 값을 기본값으로 대체해 요약하고 submit 경로는 그대로 둔다.

**F8 (정보) dialog 컨트롤러의 focusables 목록에 `textarea`와 양수 tabindex가 없다.**
`dialog-controller.js:5`. 현재 overlay 세 개에는 해당 요소가 없어 실제 영향은 없다. 나중에 dialog에 textarea를 추가하면 Tab 순환이 첫 요소로 튄다. 선택자에 `textarea:not(:disabled)`를 추가해 두는 것을 권한다.

## missing_tests

- `createDialogController`의 Node 단위 테스트가 없다. Tab/Shift+Tab 순환, 이전 dialog 교체 시 이전 `inert` 값 복원, 초기 inert였던 형제 보존은 브라우저 여정의 좌석 dialog 한 사례만 간접 검증한다.
- F1을 잡을 테스트가 없다. 같은 `(index, count)`에 대해 oval x 부호와 slot의 좌우가 일치하는지 단위로 고정하면 된다.
- F2를 잡을 테스트가 없다. 완료 multi-pot view에서 details를 연 뒤 동일 view 재publish 후 `open` 유지 검사.
- `logBlindContexts`의 fallback 성공 경로(hand_start에 blinds가 없고 replay에는 있는 경우)가 `table-presentation.test.js:13-16`에 없다. 충돌→null만 있다.
- `formatAmount` 반올림 경계(3/200이 0.02, 2/150이 ≈0.01)와 MAX_SAFE_INTEGER 칩의 BigInt 경로 텍스트 단언이 없다. 브라우저 여정은 큰 값의 가로 넘침만 본다.
- ArrowUp/Down이 구문 오류 상태에서 마지막 유효 raiseTo 기준으로 대체하는 `app.js:1096-1110` 경로와 slider/preset이 DOM에서 pendingCorrection을 푸는 경로는 브라우저 여정에 없다. 편집기 단위 테스트의 `choose`만 있다.
- 복기나 좌석 dialog가 열린 채 종합 리뷰가 도착했을 때 보류 후 닫은 뒤 자동 열림(`app.js:917-920`, `app.js:54-57`) 규칙의 브라우저 검증이 없다.
- legacy view(`out`·`handInProgress` 부재)가 DOM에서 "상태 확인 불가"와 뒷면 유지로 그려지는지는 단위 테스트만 있고 브라우저 여정에는 없다.
- `--ci`는 6/9인 × 390/1440만 돈다(`ui-presentation-journey.mjs:43,49`). 2/8인과 360/768/1024는 로컬 전체 모드 보고에만 의존한다.

## uncertainties

- 테스트 스위트, 브라우저 게이트, release-verifier를 직접 실행하지 않았다. 사용자가 보고한 최종 전체 스위트 결과는 이 리뷰에서 확인되지 않았다.
- 대비 4.5:1과 컨트롤 44px는 토큰 값과 CSS를 읽어 타당해 보이지만 측정하지 않았다. `.btn-raise .amount-secondary` 색 `#173a2d` on `#5bdfb0`가 특히 미측정이다.
- 601~800px 컨테이너에서 7인 이상 slot 배치와 124px plate의 실제 겹침은 계산상 여유가 있으나 768px 실측은 로컬 보고에만 있다.
- 로그 패널을 탭으로 숨겼다가 다시 보일 때 브라우저가 `scrollTop`을 보존하는지는 엔진별로 다르며 확인하지 않았다. 수용 기준 밖이라 판정에 넣지 않았다.
- 실제 store 불변성은 사용자 보고대로 확립되지 않았다. 이 리뷰의 판정은 코드 정확성에 한정한다.
