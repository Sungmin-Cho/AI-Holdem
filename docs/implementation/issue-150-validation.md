# Issue 150 검증과 인계

## 결과 범위

새 cash-training 세션은 6/8/9인 100BB v2 기준표를 사용한다. 99개 상황 × 169개 핸드이며 EV는 전부 null이다. 스택 80~120BB, 오픈 2~3BB, 선택한 3bet 6.5~10.5BB는 명시적 투영 참고만 제공하고 점수·calibration·mistake·retest에서 제외한다. 기존 세션·정책·연습 기록은 v1 출처를 유지한다. #147의 사전 힌트 UI는 포함하지 않는다.

## 실측

설계 전 실제 격리된 기본 20핸드 게임에서 사용자 결정 38건, 프리플롭 24건이었다. v1 지원은 8건, 누락 HJ/CO vs-open은 4건, limp/caller 7건, 복수 raise 5건, postflop 14건이었다. 스택/사이즈 제외는 0건이었다. cash-training top-up은 이미 존재했으므로 엔진 변경은 필요하지 않았다. 동일 공개 결정 fixture의 v2 재평가에서 직접 비교는 12/24건이다. 이는 전략 품질이나 일반적인 지원률의 추정치가 아니다.

v1 SHA256: `7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf`.
v2 SHA256: `1147b530a398c0b424379689d966d9be1fb60b665600b2600993689212fe02f7`.
두 버전 모두 generator `--check`로 번들 바이트와 digest 일치를 확인했다. 정책 벤치마크의 assert gate도 통과했다.

## 브라우저 검증

Playwright Chromium에서 격리된 실제 engine/relay/study-service fixture를 사용했다. 상세 검증 전 숫자 비노출, native 카드 상세의 추천·등급, 카드의 연습 링크, 답안 제출 및 새로고침 후 정확히 한 번 기록을 확인했다. 390×844 화면에서 9인 HJ vs LJ 오픈 표시와 8.5BB 답안 제출을 확인했다. 112BB 카드에는 100BB 투영·점수 제외가 표시되고 등급과 직접 연습 링크가 없었다. 브라우저 세션과 fixture 서비스는 종료했다. 관찰된 콘솔 오류는 favicon 404였다.

## 독립 리뷰와 수용 판단

model-router CRITICAL 규칙으로 Claude Opus 5와 Fable 5.1을 MAX 노력의 별도 읽기 전용 CLI 세션에 배정했다. 동일 스냅샷을 제공하고 서로의 결과를 전달하지 않았다. 실제 modelUsage와 종료·출력·verdict·receipt guard를 확인했다.

첫 리뷰의 실제 결함은 수정했다: accept의 출처 생성 부작용 제거, 배치당 한 번 출처 검증, unsupported raise의 provenance 보존, schema 4 rebuild/digest migration 수용, v1 학습 큐의 출처 선택, release mutation 대상 갱신, 투영 원인 표시, v1 export의 외래 coverage 무시. 현재 source별 활성화 기준과 종합 리뷰의 비채점 분모를 문서화했다. 저널 없는 derived schema 4는 원본을 추정할 수 없어 fail-closed를 유지하고 회귀 테스트를 추가했다.

테스트 파일명 추가 요청은 계약별 기존/신규 파일에 통합했다. 바이트 golden, 실제 엔진의 6/8/9인 snapshot, 미지원 raise, 투영 100건 점수 불변, 출처 유실 시 무쓰기, schema 4 복구, authority 변조, 측정 중복 거절 및 설명 숫자/등급 거절을 검증한다. 모드·인원 불지원이나 malformed 입력을 native reference로 강등하지 않는다.

## 재현 명령

```sh
npm run test:ci
npm run benchmark:policies
node tools/build-preflop-baseline.js --check
node tools/build-preflop-baseline.js --version 1 --check
node --test test/preflop-baseline-v2.test.js test/preflop-reference.test.js test/reference-source.test.js test/reference-coverage-authority.test.js test/reference-coverage-release.test.js
```

전체 테스트와 최종 리뷰의 종료 결과 및 병합 revision은 PR의 검증 기록에 남긴다. CI의 Windows 축은 저장소의 기존 #149 정책에 따라 플랫폼 게이트만 실행하며 전체 Windows suite 통과를 뜻하지 않는다. ESLint/Stryker는 설치되어 있지 않아 실행했다고 주장하지 않는다.
