import { prepareGameSession } from "./game-loop.js";
import { resolveCurrentSession } from "../engine/session-catalog.js";
import { createProductionResolver } from "./player-runtime.js";
export async function launchSession(
  args,
  { resolver, loopOptions = {}, onReserve, onLoop } = {},
) {
  const runtimeResolver =
    resolver ??
    createProductionResolver({ preferred: args.playerRuntime ?? null });
  const { loop, preparedInitialization, current: targetCurrent } = await prepareGameSession(args, {
    resolver: runtimeResolver,
    loopOptions,
    onReserve,
  });
  try {
    await onLoop?.(loop);
    let resumed;
    if (args.resume) resumed = await loop.resume({ skipLock: true });
    else
      await loop.bootstrap({
        ...args,
        preinitialized: preparedInitialization,
        skipLock: true,
      });
    const current = targetCurrent ?? resolveCurrentSession(args.storeDir);
    return { loop, resumed, ...current };
  } catch (error) {
    try {
      await loop.requestStop();
    } catch (cleanup) {
      // #192 L2 x #197: a lost or unverifiable loop lock only means the cleanup could not be
      // recorded. The launch failure that actually happened stays the reported error; every
      // other cleanup failure still replaces it.
      if (cleanup?.code !== 'LOOP_LOCK_LOST') throw cleanup;
    }
    throw error;
  }
}
