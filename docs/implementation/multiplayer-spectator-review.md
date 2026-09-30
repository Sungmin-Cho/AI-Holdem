# 관전 기능 설계·구현 계획 검토

날짜: 2026-09-20

판정: **구현 착수 가능**. 기능 구현은 시작하지 않았다. 사용자 확정 정책에 남은 질문이 없고, 구현을 막는 설계·계획 결함이 독립 검토에서 발견되지 않았다. 이 판정은 제품 테스트 통과나 배포 준비 완료를 뜻하지 않는다.

## 검토 대상

기준 커밋: `0b6af8af9ae53c49b8fe42c6f30996e29ae05215`

| 파일 | 검토한 SHA-256 |
| --- | --- |
| [설계](multiplayer-spectator-design.md) | `ee8ce91fbdd81b02df521b7d1b60b698b8e5f899a88c1b5a825c9aa22f43672a` |
| [구현 계획](multiplayer-spectator-plan.md) | `ff26614aea206584976a56163af8dde4c2ccb802d56f6e41c9d1ead5af832fee` |

`deep-spec`·`deep-plan`의 절차에 따라 요구사항, 실제 코드 조사, 실패/복구 상황, 구현 순서와 검증 대응을 연결한 뒤 같은 문서 묶음을 한 번 독립 검토했다. 사용자 요청이 설계·계획까지이므로 제품 구현 단계로 넘어가지 않았다.

## 독립 검토 결과

- 리뷰어: `gpt-6-astra`, high effort, semantic/deep 역할. 별도 Codex CLI 세션. 저자와 같은 모델 계열이므로 교차 모델 검토를 주장하지 않는다.
- 리뷰 세션: `01a0bcfb-2fd6-71d0-8a56-41cd236a11bb`.
- 실제 관측 모델/effort가 요청값과 일치하며 host session trace로 identity가 검증됐다.
- 종료: exit 0, timeout/overflow 없음, `terminal_success: true`, `qualifying_independent: true`.
- 판정: `PASS`; `spec-adequacy: satisfied`, `plan-conformance: satisfied`.
- `unresolved_blockers: []`, `findings: []`.
- 문서 바이트 검증 후 runtime이 독립 검토 승인 근거를 발행하고 Spec 및 Plan이 각각 같은 승인 근거를 소비했다.

로컬 실행 근거:

- packet: `.claude/deep-work.s-0c9f700c.outcome.op-7abec64200481ea7071c52e90dd42a717c95a4521ca69875e7b38f37f7be46ed.json`
- review: `.claude/deep-work.s-0c9f700c.review-execution.op-cb1bfc89941c290d47568fe113b8d1c64f92dde67c391e39558b5a9bace7b02e.json`
- approval: `.claude/deep-work.s-0c9f700c.outcome.op-3763b42c90355e15c8fbf17e1c6a3bd90941f78b770a25b35624f1c41f79121d.json`
- source artifacts: `.deep-work/s-0c9f700c/{brainstorm,research,spec,plan}.md`.

위 로컬 runtime source plan은 이번 문서 작업의 계약이다. 미래 제품 코드를 실행할 권한/검증 receipt가 아니며, 미래 구현에서는 공개된 P1–P5 계획을 기능 위험도에 맞는 실행 계약으로 구체화한다.

## 직접 확인한 현행 동작

다음 기존 테스트를 제한 실행했고 4개가 통과했다(Node v26.0.0, 약 2초).

```sh
node --test --test-name-pattern='토너먼트 종료: 호스트 탈락 후 진행|viewFor|view' test/multi-human-engine.test.js test/views.test.js
```

- 호스트 중간 탈락 후 계속 진행, 인간 전원/마지막 1인 종료, solo 동작 보존.
- CLI step envelope의 views/legal/stateVersion 계약.
- public view의 확정 탈락 및 hand lifecycle 정보.
- viewFor의 자기 카드만 노출하는 계약.

이는 설계 전제 확인이다. 신규 관전 기능 테스트, 전체 CI, 새 브라우저 관전 흐름 및 실제 서비스 복구 검증은 구현 후 P1–P5에서 수행할 항목이다. ESLint/Stryker 미설치 상태를 성공으로 해석하지 않는다.

## 구현 인계 시 주의점

가장 큰 경계는 관전 전용 참가자가 seated roster에 섞이는 문제, durable commit 이전 frame 노출, 올인/탈락 혼동, 다음 게임 권한 축소 시 이전 전체 카드가 남는 문제다. 설계의 F1–F8 및 계획의 실패 상황 검증을 유지한다.

관전 정원 20명, 직접 참가 신청의 선착순 확정, 관전 전용 명단/퇴장/코드 회전, 채팅·승률·관전자 복기 제외는 이번 범위에서 정한 구현 기본값이다. 실제 동시 접속 성능은 구현 후 확인한다.

작업 결과는 이 설계·계획·검토 문서 3개다. 제품/테스트 코드, 실사용 game store, 토큰, 게임 프로세스, Git commit/PR/merge는 변경하지 않았다.
