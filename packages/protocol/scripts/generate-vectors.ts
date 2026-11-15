/**
 * Writes the device protocol's vector files, `DEVICE_VECTOR_FILES`, into packages/protocol/vectors/.
 * Run with `bun run vectors` after changing a case. It writes and deletes only those files: the
 * app's `app-*.json` beside them are another generator's.
 */
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_VECTOR_FILES, vectorFiles } from "./vectors/files.ts";

export const VECTOR_DIRECTORY = join(import.meta.dir, "..", "vectors");

if (import.meta.main) {
  const files = vectorFiles();
  // A listed file the generator no longer makes is removed; nothing else is touched.
  for (const name of DEVICE_VECTOR_FILES) {
    const path = join(VECTOR_DIRECTORY, name);
    if (!files.has(name) && existsSync(path)) rmSync(path);
  }
  for (const [name, text] of files) writeFileSync(join(VECTOR_DIRECTORY, name), text);
  console.log(`wrote ${files.size} vector files to ${VECTOR_DIRECTORY}`);
}
