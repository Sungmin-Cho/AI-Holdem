// Browser-safe settings. CLI and lobby profiles deliberately differ for tournament.
import { playerBudget } from './player-budget.js';
import { PACE_PRESETS } from './pace.js';
export const SETUP_KEYS = Object.freeze([
  "mode",
  "pace",
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
  "totalSeats",
  "actionTimeoutSec",
  "hostName",
  "participants",
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
  if (input.pace !== undefined && !Object.hasOwn(PACE_PRESETS, input.pace)) throw setupError('pace');
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
      (!Number.isSafeInteger(value[key]) || value[key] < (key === "aiCount" && Array.isArray(value.participants) && value.participants.length >= 1 ? 0 : 1))
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
  if (value.participants !== undefined) {
    if (!Array.isArray(value.participants)) throw setupError("participants");
    const k = value.participants.length;
    if (value.totalSeats === undefined) throw setupError("totalSeats");
    if (!Number.isInteger(value.totalSeats) || value.totalSeats < 2 || value.totalSeats > 9) {
      throw setupError("totalSeats");
    }
    const aiCount = value.totalSeats - 1 - k;
    if (Object.hasOwn(input, "aiCount") && value.aiCount !== aiCount) throw setupError("aiCount");
    if (aiCount < 0 || aiCount > 8) throw setupError("aiCount");
    value.aiCount = aiCount;
    if (k >= 1) {
      if (value.hints !== "off" || value.dealBias !== "off") throw setupError("hints");
      if (aiCount === 0 && (value.mirrorSelf || value.exploitSelf)) throw setupError("mirrorSelf");
      if (value.actionTimeoutSec === 0) throw setupError("actionTimeoutSec");
      value.actionTimeoutSec ??= 60;
      if (!Number.isInteger(value.actionTimeoutSec) || value.actionTimeoutSec < 10 || value.actionTimeoutSec > 600) {
        throw setupError("actionTimeoutSec");
      }
    } else {
      if (value.actionTimeoutSec !== undefined && value.actionTimeoutSec !== 0) {
        throw setupError("actionTimeoutSec");
      }
      value.actionTimeoutSec = 0;
      delete value.participants;
    }
  } else if (value.actionTimeoutSec !== undefined && value.actionTimeoutSec !== 0
    && (value.participants === undefined || value.participants.length === 0)) {
    throw setupError("actionTimeoutSec");
  }
  if (value.totalSeats !== undefined && value.participants === undefined) {
    if (!Number.isInteger(value.totalSeats) || value.totalSeats < 2 || value.totalSeats > 9) {
      throw setupError("totalSeats");
    }
    value.aiCount = value.totalSeats - 1;
  }
  return value;
}
export function setupToArgs(setup, storeDir) {
  const normalized = normalizeSetup(setup);
  const { aiCount, participants, ...rest } = normalized;
  const args = { ...rest, ai: aiCount, storeDir };
  if (Array.isArray(participants) && participants.length >= 1) {
    args.participants = participants;
  }
  return args;
}
