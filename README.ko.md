# AI Hold'em

**한 판을 플레이하고, 판단을 복기하고, 다음 판을 준비하세요.**

AI 상대, 멀티플레이, 핸드 복기, 개인 학습실을 갖춘 셀프 호스팅 노리밋 텍사스 홀덤입니다. 브라우저에서 플레이하고 게임 기록은 로컬에 보관합니다.

[![Tests](https://github.com/Sungmin-Cho/AI-Holdem/actions/workflows/test.yml/badge.svg)](https://github.com/Sungmin-Cho/AI-Holdem/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](#빠른-시작)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

[English](README.md) · **한국어**

[빠른 시작](#빠른-시작) · [AI 상대](#ai-상대-선택) · [멀티플레이](#친구와-함께-플레이) · [문서](#문서) · [기여하기](#기여하기)

![AI Hold’em browser table](docs/images/table.png)

브라우저 테스트 세션의 6인 토너먼트 테이블입니다.

## 어떤 프로젝트인가요?

- **세 가지 AI 상대.** 로컬 페르소나 정책, Claude Code·Codex·Grok의 LLM 플레이어, 테이블 전체 JEV 모드 중에서 선택합니다.
- **원하는 테이블과 속도.** 캐시 트레이닝과 토너먼트, 솔로 게임의 AI 1~8명, 진행 속도, 일시정지·재개·재시작을 웹에서 설정합니다.
- **결과보다 판단을 복기.** 행동에 의도 메모를 남기고 완료된 핸드를 다시 봅니다. 호환 LLM이 있으면 코치와 종합 리뷰도 제공합니다.
- **게임이 끝나도 이어지는 학습.** 지원 프리플랍 스팟을 점검하고 드릴을 연습합니다. 학습 서비스는 게임 종료 후에도 유지됩니다.
- **친구와 플레이하거나 관전.** 인간과 AI가 함께하는 온라인 룸, 참가 링크, 별도 관전자 역할을 지원합니다.
- **규칙은 로컬 엔진이 관리.** 카드, 합법 액션, 칩, 사이드팟은 포커 엔진이 처리하고 AI는 행동을 선택합니다.

현재 게임 UI는 주로 한국어입니다. 플레이 칩을 사용하며, 학습 피드백은 휴리스틱 기준표 비교입니다. solver 기반 GTO 정답을 보장하지 않습니다.

## 빠른 시작

**Node.js 20 이상**, npm, Git이 필요합니다. 로컬 정책으로 플레이하더라도 프로젝트 의존성을 설치하세요.

```bash
git clone https://github.com/Sungmin-Cho/AI-Holdem.git
cd AI-Holdem
npm ci
```

게임을 저장할 디렉터리의 **절대 경로**로 앱을 시작합니다.

```bash
# macOS / Linux
npm run app -- "$PWD/game"
```

```powershell
# Windows PowerShell
npm run app -- "$($PWD.Path)\game"
```

터미널에 출력된 URL을 열고 로비에서 설정을 선택한 뒤 시작하세요. 로비를 여는 것만으로 게임이나 LLM 호출이 시작되지는 않습니다.

기본값은 **캐시 트레이닝 · AI 5명 · 100BB · 20핸드 · 로컬 policy v2 · 보통 속도**입니다. 로컬 상대의 결정에는 AI 서비스 인증이 필요하지 않습니다. LLM 코치는 선택 사항이며 사용할 수 없으면 실제 기록을 바탕으로 한 사실 기반 피드백을 제공합니다.

앱은 백그라운드에서 실행됩니다. 종료할 때는 같은 store 경로를 사용합니다.

```bash
npm run app:stop -- /absolute/path/to/game
```

이 저장소에서 Claude Code·Codex·Grok을 사용하고 있다면 **`start game`**을 요청해도 됩니다. [start-game 스킬](.agents/skills/start-game/SKILL.md)이 웹 로비를 엽니다.

## AI 상대 선택

로비의 상세 설정에서 상대 모드를 선택합니다.

| 모드 | 결정 방식 | 준비할 것 |
| --- | --- | --- |
| **로컬 정책** (기본) | 버전이 고정된 페르소나 정책을 로컬 실행 | 플레이어 API 키·LLM CLI 불필요 |
| **LLM** | 무도구 CLI 플레이어가 게임 동안 대화를 유지 | 설치·인증된 호환 Claude Code, Codex 또는 Grok CLI |
| **JEV** | 모든 AI 좌석이 TypeSafe AI의 `jev-1.13.0` 사용 | 앱 서버 환경의 `TYPESAFE_API_KEY` |

### LLM 플레이어와 코치

```bash
npm run app -- /absolute/path/to/game --player-runtime codex
# 다른 선택: --player-runtime claude 또는 --player-runtime grok
```

`--player-runtime`은 CLI 연동을 선택합니다. 상대도 LLM으로 바꾸려면 로비에서 **LLM**을 선택하세요. 로컬 정책·JEV 게임에서도 같은 연동으로 코치를 사용할 수 있습니다. 실행 전 런타임 호환성과 격리를 검사하며, Grok 플레이어는 현재 Windows를 지원하지 않습니다. 각 서비스의 인증, 모델 접근 권한, 사용량 제한이 적용됩니다.

### JEV 플레이어

앱 시작 전에 셸 환경에 `TYPESAFE_API_KEY`를 설정하고, 상세 설정에서 **JEV 플레이어 (테이블 전체)**를 선택합니다. 앱이 이미 실행 중이면 종료한 뒤 해당 환경에서 다시 시작하세요. JavaScript SDK는 `npm ci`로 설치되며 Python은 필요하지 않습니다.

요청에는 행동하는 AI의 자기 패와 공개 테이블 정보만 좌석 별칭으로 보냅니다. 다른 좌석의 비공개 패, 참가자 이름·ID, 채팅, 의도 메모는 제외합니다. JEV는 합법 액션·금액 후보에서 선택하며, 앱이 후보 확률로 행동을 추첨합니다. 요청 실패 시 로컬 정책으로 자동 전환하지 않고 명시적인 복구를 기다립니다. 코치는 기존 LLM 연동 또는 사실 기반 피드백을 사용합니다.

## 친구와 함께 플레이

로비에서 온라인 세션을 열고 **참가 링크**를 공유하세요. 공개 리스너의 기본 포트는 **8899**입니다. 접근 가능한 같은 LAN에서 참가할 수 있으며, 인터넷 접속에는 별도의 네트워크·HTTPS 설정이 필요합니다. private 호스트 URL 대신 참가 링크를 공유하세요.

관전자는 엔진 좌석을 차지하지 않으며 **모든 홀카드를 실시간으로 볼 수 있습니다**. 이 공개 범위가 적절한 그룹에서 관전 기능을 사용하세요. 멀티플레이 게임은 앱에서 시작·재개합니다.

기본 연결은 HTTP입니다. 공개 호스트·포트·TLS 설정은 [운영 가이드](docs/operations.ko.md#시작하기)에 있습니다.

## 플레이 → 복기 → 연습

1. **플레이:** 캐시 트레이닝 또는 토너먼트를 고르고 속도를 설정합니다. 행동할 때 의도 메모로 판단을 기록합니다.
2. **복기:** 로그에서 완료된 핸드를 열고 복기 뷰와 피드백을 확인합니다. 카드 공개 범위는 저장된 showdown·replay 설정을 따르며 export에는 쇼다운 카드만 담깁니다.
3. **연습:** 학습실에서 지원 스팟을 다시 살펴보고 드릴을 풉니다. 프로필과 게임 기록은 시작할 때 지정한 store에 보관됩니다.

기존 store의 독립 학습 서비스를 열거나 종료할 수 있습니다.

```bash
npm run study -- /absolute/store
npm run study:stop -- /absolute/store
```

프리플랍 기준표는 6·8·9인 100BB의 일부 상황을 지원합니다. 미지원 스팟을 정답이 있는 것처럼 평가하지 않습니다. 점수·빈도 비교는 수익성이나 실제 포커 실력의 증명이 아닙니다. 범위와 출처는 [학습 데이터 문서](training/data/README.md)를 참고하세요.

## 동작 구조

```text
브라우저 로비·테이블
        │
   앱 서비스 ─── 게임 루프 ─── 포커 엔진
                      │
                      ├── 로컬 정책 / LLM CLI / JEV
                      └── 세션 기록 ─── 학습 서비스
```

앱은 한 번에 하나의 게임 루프를 호스팅합니다. 루프가 결정, 저장, 코치, 종료를 담당하고 별도 학습 서비스가 종료 후 학습을 맡습니다. 호스트 에이전트는 핸드 안 액션마다 개입하지 않습니다.

세션은 로컬에 저장됩니다. LLM·JEV 모드는 허용된 판단 문맥을 선택한 서비스에 전송합니다. private store 파일과 호스트 토큰은 공유하지 마세요. 진행 중 게임을 업그레이드하거나 롤백하기 전에는 [복구 가이드](docs/operations.ko.md)를 따르고, 원본 기록을 보존한 채 호환 버전으로 roll-forward하세요.

## 문서

| 문서 | 내용 |
| --- | --- |
| [아키텍처](ARCHITECTURE.md) | 엔진·앱·relay·runtime·영속성 경계 |
| [운영 및 복구](docs/operations.ko.md) | legacy CLI, 진단, 종료, 재개, 복구 |
| [start-game 스킬](.agents/skills/start-game/SKILL.md) | 에이전트를 통한 기동 절차 |
| [학습 데이터](training/data/README.md) | 휴리스틱 기준표 범위와 출처 |
| [JEV 설계](docs/implementation/jev-player-design.md) | 서비스 연동 계약과 실패 처리 |
| [JEV 검증](docs/implementation/jev-player-validation.md) | 자동화·실제 provider 검증 근거 |

## 기여하기

버그 제보와 목적이 명확한 PR을 환영합니다. 재현 절차, OS·Node.js 버전, 상대 모드를 함께 알려 주세요. 공유하는 자료에서 API 키, 호스트 URL, 토큰, 비공개 게임 기록을 제거해 주세요.

```bash
npm ci
npm run test:ci
npm run benchmark:policies
```

단건 테스트는 `node --test test/<file>.test.js`로 실행합니다. 브라우저 검증은 `npm run test:lobby:browser`, `npm run test:multiplayer:browser`, `npm run test:ui:browser`이며 브라우저 도구가 필요합니다. 멀티플레이 검증에는 접근 가능한 LAN IPv4가 필요합니다. 자동화 환경의 설치 절차는 [CI workflow](.github/workflows/test.yml)를 참고하세요.

일반 CI는 JEV API를 호출하지 않습니다. 별도 [실제 JEV 검증](test/browser/jev-live-play.mjs)은 임시 store와 서비스 인증을 사용합니다.

## 라이선스

[Apache License 2.0](LICENSE).
