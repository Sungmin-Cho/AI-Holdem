// POSIX ignores windowsHide. On Windows a console-less parent (DETACHED_PROCESS)
// otherwise allocates a console for every node.exe child.
export function childSpawnOptions(options = {}) {
  return { ...options, windowsHide: true };
}
