/** Short paths keep test control sockets within the Unix-domain socket address limit. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Makes a fresh socket-capable folder under the system temp directory on Windows. */
export function shortTempFolder(prefix: string): string {
  return mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", prefix));
}
