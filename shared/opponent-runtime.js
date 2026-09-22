// Browser-safe persisted contract. Never infer a new runtime from a damaged descriptor.
export const OPPONENT_RUNTIMES = Object.freeze(['policy', 'llm', 'jev']);
export const JEV_CONFIG = Object.freeze({ schemaVersion: 1, model: 'jev-1.13.0',
  questionVersion: 'poker-choice-v1', candidateVersion: 'legal-menu-v1', projectionVersion: 1 });
function fail(code) { throw Object.assign(new Error(code), { code }); }
export function validateOpponentRuntime(value) {
  if (!OPPONENT_RUNTIMES.includes(value)) fail('INVALID_OPPONENT_RUNTIME');
  return value;
}
export function validateJevConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== Object.keys(JEV_CONFIG).length
    || Object.entries(JEV_CONFIG).some(([k, v]) => value[k] !== v)) fail('JEV_CONFIG_UNSUPPORTED');
  return { ...JEV_CONFIG };
}
export function resolveOpponentRuntime(engine, { loop, setup, explicit } = {}) {
  const config = engine?.config ?? {};
  const evidence = [loop?.opponentRuntime, setup?.opponentRuntime, loop?.pendingDecision?.runtime, explicit].filter(v => v !== undefined);
  evidence.forEach(validateOpponentRuntime);
  let runtime;
  if (Object.hasOwn(config, 'opponentRuntime')) runtime = validateOpponentRuntime(config.opponentRuntime);
  else {
    if (Object.hasOwn(config, 'jev') || evidence.includes('jev') || loop?.jev) fail('JEV_CONFIG_UNSUPPORTED');
    runtime = loop?.opponentRuntime ?? (engine?.policySeed != null ? 'policy' : 'llm');
    if (engine?.policySeed != null && runtime !== 'policy') fail('OPPONENT_RUNTIME_MISMATCH');
  }
  if (evidence.some(v => v !== runtime)) fail('OPPONENT_RUNTIME_MISMATCH');
  if (runtime === 'jev') {
    validateJevConfig(config.jev);
    if (loop?.jev !== undefined) validateJevConfig(loop.jev);
  } else if (Object.hasOwn(config, 'jev') || loop?.jev !== undefined) fail('JEV_CONFIG_UNSUPPORTED');
  return runtime;
}
