// Persona parameters of policy v3 (design D11). Traits keep the v2 meaning
// (postflop temperament); `preflop` changes the v3 reference charts: opening
// width, continuing width against a raise, 3-bet scale, extra 3-bets with the
// weaker raising hands, limp share of opens, and push/fold width.
export const PERSONAS_V3 = Object.freeze({
  baseline: Object.freeze({
    traits: Object.freeze({ tightness: 0.52, aggression: 0.52, calling: 0.42, bluff: 0.14 }),
    preflop: Object.freeze({ rfiWidth: 1, callWidth: 1, threeBetScale: 1, bluffThreeBet: 1, limp: 0, pushWidth: 1 }),
  }),
  TAG: Object.freeze({
    traits: Object.freeze({ tightness: 0.62, aggression: 0.62, calling: 0.38, bluff: 0.12 }),
    preflop: Object.freeze({ rfiWidth: 1, callWidth: 0.85, threeBetScale: 1, bluffThreeBet: 1, limp: 0, pushWidth: 1 }),
  }),
  LAG: Object.freeze({
    traits: Object.freeze({ tightness: 0.38, aggression: 0.70, calling: 0.47, bluff: 0.20 }),
    preflop: Object.freeze({ rfiWidth: 1.35, callWidth: 1.25, threeBetScale: 1.3, bluffThreeBet: 1.2, limp: 0, pushWidth: 1.2 }),
  }),
  Nit: Object.freeze({
    traits: Object.freeze({ tightness: 0.78, aggression: 0.35, calling: 0.25, bluff: 0.05 }),
    preflop: Object.freeze({ rfiWidth: 0.5, callWidth: 0.45, threeBetScale: 0.6, bluffThreeBet: 1, limp: 0, pushWidth: 0.75 }),
  }),
  CallingStation: Object.freeze({
    traits: Object.freeze({ tightness: 0.45, aggression: 0.18, calling: 0.80, bluff: 0.04 }),
    preflop: Object.freeze({ rfiWidth: 1.05, callWidth: 3, threeBetScale: 0.3, bluffThreeBet: 1, limp: 0.5, pushWidth: 1 }),
  }),
  Maniac: Object.freeze({
    traits: Object.freeze({ tightness: 0.15, aggression: 0.90, calling: 0.55, bluff: 0.50 }),
    preflop: Object.freeze({ rfiWidth: 2.4, callWidth: 2.1, threeBetScale: 2, bluffThreeBet: 1.5, limp: 0, pushWidth: 1.4 }),
  }),
  Trickster: Object.freeze({
    traits: Object.freeze({ tightness: 0.48, aggression: 0.80, calling: 0.48, bluff: 0.32 }),
    preflop: Object.freeze({ rfiWidth: 1.1, callWidth: 1, threeBetScale: 1, bluffThreeBet: 2, limp: 0, pushWidth: 1 }),
  }),
});

export const PERSONA_ARCHETYPES_V3 = Object.freeze(['TAG', 'LAG', 'Nit', 'CallingStation', 'Maniac', 'Trickster']);

export function personaConfigV3(name) {
  const persona = PERSONAS_V3[name];
  if (!persona) return null;
  return { base: 'strategy-v3', persona: name, traits: { ...persona.traits }, preflop: { ...persona.preflop } };
}
