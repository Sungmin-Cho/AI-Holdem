const GUIDANCE = Object.freeze({
  TAG: '강한 시작 패와 유리한 위치를 선별하고, 참여할 때는 주도권을 잡는 레이즈를 우선하라. 약한 한 쌍이나 불리한 가격에는 규율 있게 물러나라.',
  LAG: '위치와 폴드 가능성을 활용해 넓은 범위로 압박하되, 큰 저항과 나쁜 가격을 만나면 무조건 밀어붙이지 말고 포기할 줄 알아라.',
  Nit: '명확히 강한 패와 좋은 가격 중심으로 매우 좁게 참여하라. 경계선 패는 작은 팟이어도 먼저 폴드를 검토하고, 강한 패에서는 가치를 놓치지 마라.',
  CallingStation: '공개 보드와 가격상 충분한 쇼다운 가치나 드로가 있으면 콜로 계속 확인하라. 근거 없는 레이즈는 줄이고, 완전히 희망 없는 패는 폴드하라.',
  Maniac: '레이즈와 재압박으로 주도권을 자주 노리되 합법 범위와 실제 패의 최소 방어력은 지켜라. 명백히 패배한 약한 패로 무의미한 칩 투입은 하지 마라.',
  Trickster: '최근 공개 액션을 바탕으로 강한 패의 슬로플레이와 선택적 블러프를 섞어 읽히기 어렵게 하라. 같은 상황을 자동 반복하지 말고 가격과 위치에 맞춰 노선을 바꿔라.',
});

export const PERSONA_ARCHETYPES = Object.freeze(Object.keys(GUIDANCE));

export function personaGuidance(archetype) {
  if (!Object.hasOwn(GUIDANCE, archetype)) {
    const error = new Error(`지원하지 않는 아키타입입니다: ${archetype ?? '없음'}`);
    error.code = 'BAD_PERSONA';
    throw error;
  }
  return GUIDANCE[archetype];
}
