// Both browser execution and the no-browser control use this completion gate.
export function finishJourney({ required, recorded, failure }) {
  if (failure) throw failure;
  const pending = required.filter(name => !recorded.includes(name));
  if (pending.length) throw new Error(`MISSING_REQUIRED_CHECKS: ${pending.join(', ')}`);
}

export function selfTestJourney(required, argv = process.argv.slice(2)) {
  if (!argv.includes('--self-test')) return false;
  const index = argv.indexOf('--omit');
  const omitted = index < 0 ? null : argv[index + 1];
  if (index >= 0 && !required.includes(omitted)) throw new Error('UNKNOWN_REQUIRED_CHECK');
  finishJourney({ required, recorded: required.filter(name => name !== omitted) });
  console.log('JOURNEY_SELF_TEST_PASS');
  return true;
}

// Attempt all owned cleanup steps; never replace the failure being diagnosed.
export async function cleanupJourney({ steps, failure }) {
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  return { failure: failure ?? errors[0], errors };
}
