# #270 독립 검증 및 대응 기록

model-router 1.23.1, HIGH(security_sensitive, auth_sensitive, concurrency_sensitive; 최종 public_api_change 포함), high effort.
구현: Sonnet 5.5 → 실패한 테스트 하네스 근거로 Fable 5.1에 상향 → 오케스트레이터가 실행·계약 수정.
각 REVIEW 요청에 작성자 Sonnet/Fable 및 후속 작성자 GPT-6.1 Sol을 명시해 자기 모델 리뷰를 배제했다.

| 라운드 | Opus 5.5 / high | GPT-6 Astra / high | 핵심 대응 |
|---|---|---|---|
| R1 | PASS_WITH_CHANGES | PASS_WITH_CHANGES | listener 관찰부터 연결까지의 TOCTOU, 실제 foreign listener, 별도 자식 OS 비용, 역압·이탈 시험 |
| R2 | PASS_WITH_CHANGES | PASS_WITH_CHANGES | 같은 게임 객체 교체의 terminal 409를 retryable 503으로 수정, live listener 예산을 생산값에 맞춤 |
| R3 | PASS_WITH_CHANGES | PASS_WITH_CHANGES | 구현 차단 결함 없음. Windows 실측과 최종 CI·이슈 기록을 병합 조건으로 유지 |

세 번 모두 서로의 결과를 제공하지 않은 새 CLI 프로세스 두 개로 검사했다. 라운드 실행 중 source/spec/test 파일을 고정했고 종료 뒤 SHA-256을 다시 확인했다.
리뷰어는 정적 검토만 했으며, 테스트 실행 증거는 오케스트레이터가 따로 제공한다. max round 때문에 중단한 것이 아니라 필수 구현 지적이 해소돼 실행 검증으로 진행했다.

## 주요 대응과 판단 근거

- **수락:** 토큰 전송 전 loop binding·lock·engine·현재 identity·listener를 요청마다 확인하고, POST 대기 전 capture 및 OS 대기 뒤 재확인한다. 성공 캐시는 없다.
- **수락:** 살아 있는 relay가 listener만 닫을 수 있으므로 잔여 위험을 단순 PID 재사용으로 한정하지 않는다. 시간 상한·완전한 peer 인증을 주장하지 않는다.
- **수락:** 실제 두 번째 lock.port listener도 접촉 0을 단언한다. 수정 전 최종 32회 중 실제 접촉 26회를 검출했다. import 실패나 단순 상태 차이를 누출로 집계하지 않았다.
- **수락:** `STALE_GAME`은 클라이언트 terminal 코드다(`server/public/app-transport.js`). `reconcileFailure`는 같은 선택 게임의 current 객체를 바꿀 수 있다(`tools/session-manager.js`). 그런 요청은 전송을 거절하되 재시도 가능한 503을 쓴다. 현재 epoch의 요청에 binding만 뒤처진 경우도 503이다.
- **기각:** authenticate가 동일 mutable row를 돌려줘 비교가 무효라는 지적. `requireRoom()`이 `structuredClone(room)`을 반환하므로 이미 분리돼 있다. 추가 복사는 제거했고, OS 게이트 뒤 실제 cached room을 바꾸는 시험에서 전송 0을 확인했다.
- **수락:** 실제 OS 음성 검사의 조건부 생략을 제거하고 테스트 소유 별도 자식을 쓴다. listener 예산은 생산 기본과 같은 3초, reader 상한은 5초 설정으로 실제 전달 예산이 1초로 잘리지 않게 했다. 음성 검사는 connection/request 둘 다 증가하지 않아야 한다.
- **수락:** 100ms 정착 sleep 대신 capability 사용의 정산을 기다린다. SSE 역압 중 host/참가자/관전자 이탈은 실제 소켓과 제어한 write(false) 분기로 검증한다.
- **수락:** 일반 upstream 요청에는 5분 socket 유휴 예산을 둔다. SSE는 장기 연결이다.
- **선택 사항으로 보류:** SSE 응답 헤더 대기 deadline, 기존 공개 SSE abrupt-close 정리, 비-SSE 본문 도중 binding 교체 시 잘린 JSON 종료, 철회·좌석 변경의 세부 안내 코드. 권한을 더 넓히는 예외는 추가하지 않았다.
- **조건부 수용:** Windows는 요청마다 PowerShell identity 판독 비용과 동기 JSON 파싱을 낸다. 실제 CI의 별도 PID identityMs를 기록하고 수용 결정을 이슈에 남긴 뒤 병합한다. 로컬 macOS 수치로 대체하지 않는다.
- **수용한 운영 한계:** Linux lstart 이동 및 legacy raw lock은 새 relay가 필요할 수 있다. 단순 resume의 복구를 보장하지 않으며 lock 회수·신호 정책을 이번 범위에서 변경하지 않는다.

## 검증 대상과 영수증 범위

R3 대상(문서 후속 실행 근거 갱신 전) SHA-256:
`dc0d4f9b6d8d459205921ad09a6723117f1e0145ad35899ee113bab427fabcaf`.
라우트 fingerprint:
`cbfc24769ad1126cd801dab65de7f362bf7e2aac48b25815a1d2990489fe01ea`.
정책 SHA-256:
`25f6b4d2e4bcbeef5d23a5f0799287bc54d6b9fd1b7202023e537397ea26824b`.

각 좌석은 SUCCEEDED·유효 판정·종료 확인·route/model 연결을 검증했다. Claude 좌석은 Darwin receipt guard도 검증했다.
Codex는 자체 read-only sandbox와 Darwin receipt guard의 중첩을 지원하지 않아 해당 receipt-store guard는 적용하지 않았다. Codex 영수증에 그 보호를 주장하지 않는다.
선언 모델/CLI header와 provider의 cryptographic served-model attestation을 같은 증거로 취급하지 않는다.
R3 뒤 제품 동작은 변경하지 않았으며 문서의 snapshot 호출 수와 완료된 집중 실행 근거를 갱신하고 이 대응 기록을 추가했다.

로컬 전체 실행의 timeout 1건은 원인 미확정이다. 기준·현재 분리 실행은 통과했지만 전체 green으로 계산하지 않는다.
최종 커밋의 Linux/Windows CI 및 Windows 검사 비용을 확인하기 전에는 병합 완료로 보고하지 않는다.
