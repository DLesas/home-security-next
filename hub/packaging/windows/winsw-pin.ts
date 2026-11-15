#!/usr/bin/env bun
/**
 * `bun winsw-pin.ts <WinSW-x64.exe>`: the one check of the service wrapper the `.msi` ships
 * (m2-design.md section 9, W3): its SHA-256 must be the value pinned in `winsw.sha256`, or the
 * build stops. Changing the version means changing the pinned value in a reviewed commit.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Result } from "neverthrow";

export const PIN_FILE = join(import.meta.dir, "winsw.sha256");

/** The pinned hash and the file it names, from `winsw.sha256`'s first line. */
export function parsePin(
  text: string,
): { readonly sha256: string; readonly file: string } | undefined {
  const match = /^([0-9a-f]{64}) {2}(\S+)/u.exec(text);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { sha256: match[1], file: match[2] };
}

/** Whether `bytes` are the pinned file. */
export function matchesPin(bytes: Uint8Array, pinText: string): boolean {
  return parsePin(pinText)?.sha256 === createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  const path = process.argv[2];
  const read = Result.fromThrowable(
    () => ({ file: readFileSync(path ?? ""), pin: readFileSync(PIN_FILE, "utf8") }),
    (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
  )();
  if (read.isErr()) {
    process.stderr.write(`winsw-pin: ${read.error}\n`);
    process.exit(1);
  }
  if (!matchesPin(read.value.file, read.value.pin)) {
    process.stderr.write(`winsw-pin: ${path ?? ""} is not the pinned WinSW: refused\n`);
    process.exit(1);
  }
  process.stdout.write("winsw-pin: the pinned WinSW\n");
}
