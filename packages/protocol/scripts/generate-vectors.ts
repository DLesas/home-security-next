/** Writes packages/protocol/vectors/*.json. Run with `bun run vectors` after changing a case. */
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vectorFiles } from "./vectors/files.ts";

export const VECTOR_DIRECTORY = join(import.meta.dir, "..", "vectors");

if (import.meta.main) {
  const files = vectorFiles();
  for (const name of readdirSync(VECTOR_DIRECTORY)) {
    if (name.endsWith(".json") && !files.has(name)) rmSync(join(VECTOR_DIRECTORY, name));
  }
  for (const [name, text] of files) writeFileSync(join(VECTOR_DIRECTORY, name), text);
  console.log(`wrote ${files.size} vector files to ${VECTOR_DIRECTORY}`);
}
