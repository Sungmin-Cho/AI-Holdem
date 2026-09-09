import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
export function writePrivateJson(file, value) {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temp);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}

export function readPrivateJson(file, maxBytes = 2 * 1024 * 1024) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW ?? 0) |
      (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      current.isSymbolicLink() ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino
    )
      throw Object.assign(new Error("Unsafe JSON file"), {
        code: "APP_FILE_INVALID",
      });
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
