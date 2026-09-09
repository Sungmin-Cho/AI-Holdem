import { prepareGameSession } from "./game-loop.js";
import { resolveCurrentSession } from "../engine/session-catalog.js";
import { resolveRuntimes } from "./player-runtime.js";
export async function launchSession(
  args,
  { resolver, loopOptions = {}, onReserve, onLoop } = {},
) {
  const runtimeResolver =
    resolver ??
    (({ need, canaryAbsPath, registerAdapter }) =>
      resolveRuntimes({
        need,
        canaryAbsPath,
        preferred: args.playerRuntime ?? null,
        onAdapterCreated: registerAdapter,
      }));
  const { loop, preparedInitialization } = await prepareGameSession(args, {
    resolver: runtimeResolver,
    loopOptions,
    onReserve,
  });
  try {
    await onLoop?.(loop);
    if (args.resume) await loop.resume({ skipLock: true });
    else
      await loop.bootstrap({
        ...args,
        preinitialized: preparedInitialization,
        skipLock: true,
      });
    const current = resolveCurrentSession(args.storeDir);
    return { loop, ...current };
  } catch (error) {
    try {
      await loop.requestStop();
    } catch (cleanup) {
      throw cleanup;
    }
    throw error;
  }
}
