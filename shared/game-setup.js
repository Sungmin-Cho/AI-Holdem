// Browser-safe settings. CLI and lobby profiles deliberately differ for tournament.
import { playerBudget } from './player-budget.js';
export const SETUP_KEYS = Object.freeze([
  "mode",
  "aiCount",
  "opponentRuntime",
  "stack",
  "stackBb",
  "hands",
  "levelEvery",
  "blinds",
  "mirrorSelf",
  "exploitSelf",
  "hints",
  "dealBias",
  "showdownPolicy",
  "replayReveal",
  "playerSoftMs",
  "playerHardMs",
]);
export function setupError(field) {
  return Object.assign(new Error(`게임 설정을 확인하세요: ${field}`), {
    code: "INVALID_SETUP",
    field,
  });
}
export function cliModeDefaults(args) {
  const next = { ...args };
  const fresh = next.storeDir !== undefined && !next.resume;
  if (
    fresh &&
    next.mode === undefined &&
    next.stack === undefined &&
    next.levelEvery === undefined
  )
    next.mode = "cash-training";
  if (!next.resume && next.mode === "cash-training" && next.ai === undefined)
    next.ai = 5;
  if (fresh && next.mode === "cash-training") {
    if (next.stack === undefined && next.stackBb === undefined)
      next.stackBb = 100;
    next.hands ??= 20;
    next.opponentRuntime ??= "policy";
  }
  if (fresh) {
    next.showdownPolicy ??= "open";
    next.replayReveal ??= "all";
    next.hints ??= "off";
    next.dealBias ??= "off";
  }
  return next;
}
export function normalizeSetup(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw setupError("setup");
  for (const key of Object.keys(input))
    if (!SETUP_KEYS.includes(key)) throw setupError(key);
  const value = {
    mode: "cash-training",
    aiCount: 5,
    opponentRuntime: "policy",
    hints: "off",
    dealBias: "off",
    showdownPolicy: "open",
    replayReveal: "all",
    mirrorSelf: false,
    exploitSelf: false,
    ...input,
  };
  let budget;
  try { budget = playerBudget({
    ...(value.playerSoftMs !== undefined ? { softMs: value.playerSoftMs } : {}),
    ...(value.playerHardMs !== undefined ? { hardMs: value.playerHardMs } : {}),
  }); } catch { throw setupError('playerSoftMs/playerHardMs'); }
  value.playerSoftMs = budget.softMs;
  value.playerHardMs = budget.hardMs;
  for (const [key, allowed] of Object.entries({
    mode: ["cash-training", "tournament"],
    opponentRuntime: ["policy", "llm"],
    hints: ["on", "off"],
    dealBias: ["off", "light", "strong"],
    showdownPolicy: ["open", "standard"],
    replayReveal: ["all", "showdown"],
  })) {
    if (!allowed.includes(value[key])) throw setupError(key);
  }
  for (const key of ["mirrorSelf", "exploitSelf"])
    if (typeof value[key] !== "boolean") throw setupError(key);
  for (const key of ["aiCount", "stack", "stackBb", "hands", "levelEvery"])
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || value[key] < 1)
    )
      throw setupError(key);
  if (value.aiCount > 8) throw setupError("aiCount");
  if (value.stack !== undefined && value.stackBb !== undefined)
    throw setupError("stackBb");
  if (value.mode === "cash-training") {
    if (value.levelEvery !== undefined) throw setupError("levelEvery");
    if (value.stack === undefined) value.stackBb ??= 100;
    value.hands ??= 20;
  } else {
    if (value.stackBb !== undefined || value.hands !== undefined)
      throw setupError("hands");
    value.stack ??= 5000;
    value.levelEvery ??= 8;
  }
  value.blinds ??= "25/50";
  if (typeof value.blinds !== "string" || !/^\d+\/\d+$/.test(value.blinds))
    throw setupError("blinds");
  const [sb, bb] = value.blinds.split("/").map(Number);
  if (![sb, bb].every((n) => Number.isSafeInteger(n) && n > 0) || sb > bb)
    throw setupError("blinds");
  if (
    !Number.isSafeInteger(
      (value.stack ?? value.stackBb * bb) * (value.aiCount + 1),
    )
  )
    throw setupError("stack");
  const selfCount = Number(value.mirrorSelf) + Number(value.exploitSelf);
  if (
    selfCount &&
    (value.opponentRuntime !== "policy" || selfCount > value.aiCount)
  )
    throw setupError("mirrorSelf");
  return value;
}
export function setupToArgs(setup, storeDir) {
  const { aiCount, ...rest } = normalizeSetup(setup);
  return { ...rest, ai: aiCount, storeDir };
}
