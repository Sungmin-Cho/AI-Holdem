import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { writePrivateJson } from "./app-files.js";
const digest = (data) => createHash("sha256").update(data).digest("hex");
const files = ["state.json", "players.json"];
export function sealPreparation(prepared, initialized) {
  const hashes = Object.fromEntries(
    files.map((name) => [
      name,
      digest(fs.readFileSync(path.join(prepared.stagingDir, name))),
    ]),
  );
  writePrivateJson(path.join(prepared.stagingDir, ".init-complete.json"), {
    schemaVersion: 1,
    gameId: prepared.gameId,
    selectionVersion: prepared.selectionVersion,
    hashes,
    initialized,
  });
}
export function readPreparation(prepared) {
  const dir = fs.existsSync(prepared.stagingDir)
    ? prepared.stagingDir
    : prepared.sessionDir;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error();
    const marker = JSON.parse(
      fs.readFileSync(path.join(dir, ".init-complete.json")),
    );
    if (
      marker.schemaVersion !== 1 ||
      marker.gameId !== prepared.gameId ||
      marker.selectionVersion !== prepared.selectionVersion
    )
      throw new Error();
    for (const name of files) {
      const file = path.join(dir, name),
        st = fs.lstatSync(file);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.nlink !== 1 ||
        digest(fs.readFileSync(file)) !== marker.hashes[name]
      )
        throw new Error();
    }
    return marker.initialized;
  } catch {
    throw Object.assign(
      new Error("불완전한 생성 기록을 보존했습니다. 복구가 필요합니다."),
      { code: "RECOVERY_REQUIRED" },
    );
  }
}
