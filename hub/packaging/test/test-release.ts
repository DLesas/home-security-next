#!/usr/bin/env bun
/**
 * `bun hub/packaging/test/test-release.ts <folder>`: a release for this computer, version 99.0.0,
 * of one program file, signed with the tests' key (the published seed of 7s), written into
 * `<folder>`; prints its path. The installers' check gives it to the installed hub, which trusts
 * only its compiled-in keys: staging's first piece, in the staging worker, refuses it
 * `badSignature`, which shows the worker is embedded and found in the installed program (a worker
 * that could not start would end the staging `io`).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseOfFiles } from "../shared/make-release.ts";
import { programName } from "../../src/shell/update/program-name.ts";
import { platformOf } from "../../src/shell/update/release.ts";

const folder = process.argv[2];
const platform = platformOf(process.platform, process.arch);
if (folder === undefined || platform === undefined) {
  process.stderr.write("usage: test-release.ts <folder> (on a computer the hub is built for)\n");
  process.exit(2);
}
const file = releaseOfFiles(
  [
    {
      path: `bin/${programName(platform)}`,
      data: new TextEncoder().encode("a test release\n"),
      executable: true,
    },
  ],
  "99.0.0",
  platform,
  new Uint8Array(32).fill(7),
  0,
);
if (file.isErr()) {
  process.stderr.write(`test-release: ${file.error}\n`);
  process.exit(1);
}
const path = join(folder, "hsn-hub-99.0.0-test.hsnr");
writeFileSync(path, file.value);
process.stdout.write(`${path}\n`);
