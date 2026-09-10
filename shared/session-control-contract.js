export const COMMANDS = Object.freeze([
  "start",
  "pause",
  "resume",
  "retry-decision",
  "end",
  "restart",
  "replace-current",
]);
export const ALLOWED_COMMANDS = Object.freeze({
  lobby: ["start"],
  starting: [],
  playing: ["pause"],
  pausing: [],
  paused: ["resume", "retry-decision", "end", "restart", "replace-current"],
  stopping: [],
  finalizing: [],
  completed: ["start", "restart"],
  ended: ["start", "restart"],
  error: ["resume"],
  external: [],
});
export function controlError(code) {
  return Object.assign(new Error(code), { code });
}
export function validateCommand(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw controlError("BAD_COMMAND");
  const keys = [
    "requestId",
    "expectedInstanceId",
    "expectedAppRevision",
    "expectedGameId",
    "expectedSelectionVersion",
    "kind",
    "setup",
    "decisionId",
  ];
  if (
    Object.keys(body).some((k) => !keys.includes(k)) ||
    !COMMANDS.includes(body.kind) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId ?? "") ||
    typeof body.expectedInstanceId !== "string" ||
    !Number.isSafeInteger(body.expectedAppRevision) ||
    body.expectedAppRevision < 0 ||
    !(
      body.expectedGameId === null || typeof body.expectedGameId === "string"
    ) ||
    !Number.isSafeInteger(body.expectedSelectionVersion) ||
    body.expectedSelectionVersion < 0
  )
    throw controlError("BAD_COMMAND");
  if ("setup" in body && !["start", "replace-current"].includes(body.kind))
    throw controlError("BAD_COMMAND");
  if (body.kind === 'retry-decision' && (typeof body.decisionId !== 'string' || !/^d-\d+-(preflop|flop|turn|river)-\d+$/.test(body.decisionId))) throw controlError('BAD_COMMAND');
  if ('decisionId' in body && body.kind !== 'retry-decision') throw controlError('BAD_COMMAND');
  return body;
}
