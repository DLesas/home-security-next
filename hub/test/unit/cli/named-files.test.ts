/**
 * The files a person names to `hsn` (m2-design.md section 9, "Files a person names to `hsn`"):
 * read and written without following a link in the last part; written to a 0600 temporary file
 * created exclusively and renamed only when the hash matches; as root without `sudo`, only in
 * root's own folders outside the hub's trees.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readNoFollow, rootMayUse, writeExclusively } from "../../../cli/named-files.ts";

const root = mkdtempSync("/tmp/hsn-named-");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TREES = { data: "/var/lib/hsn-hub", program: "/var/lib/hsn-hub-program" };

describe.skipIf(process.platform === "win32")("a named file, as the running account", () => {
  test("read whole; a link in the last part is refused, not followed", () => {
    const file = join(root, "release.hsnr");
    writeFileSync(file, "the release");
    expect(new TextDecoder().decode(readNoFollow(file)._unsafeUnwrap())).toBe("the release");
    const link = join(root, "link.hsnr");
    symlinkSync(file, link);
    expect(readNoFollow(link)._unsafeUnwrapErr()).toContain("cannot read");
  });

  test("written through an exclusive 0600 temporary file, renamed when the hash matches", () => {
    const folder = join(root, "out");
    mkdirSync(folder);
    const target = join(folder, "backup.hsnb");
    const bytes = new TextEncoder().encode("a backup");
    expect(writeExclusively(target, bytes, sha(bytes)).isOk()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("a backup");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(folder)).toEqual(["backup.hsnb"]);
  });

  test("a wrong hash saves nothing; a link at the target is replaced, never written through", () => {
    const folder = join(root, "out2");
    mkdirSync(folder);
    const target = join(folder, "backup.hsnb");
    const bytes = new TextEncoder().encode("a backup");
    expect(writeExclusively(target, bytes, "00".repeat(32))._unsafeUnwrapErr()).toContain(
      "nothing was saved",
    );
    expect(readdirSync(folder)).toEqual([]);
    const elsewhere = join(root, "someone-elses.txt");
    writeFileSync(elsewhere, "keep me");
    symlinkSync(elsewhere, target);
    expect(writeExclusively(target, bytes, sha(bytes)).isOk()).toBe(true);
    expect(readFileSync(elsewhere, "utf8")).toBe("keep me");
    expect(readFileSync(target, "utf8")).toBe("a backup");
  });
});

describe("as root without sudo: root's own folders only (section 9)", () => {
  const stat =
    (uid: number, mode: number, dir = true) =>
    () =>
      ({ uid, mode, isDirectory: () => dir }) as unknown as Stats;
  test("a folder root owns and no other account can write is allowed", () => {
    expect(rootMayUse("/root/backup.hsnb", TREES, stat(0, 0o40755))).toBeUndefined();
  });
  test("refused: another's folder, one others can write, a link or file, a hub tree", () => {
    expect(rootMayUse("/home/anna/f", TREES, stat(1000, 0o40755))).toContain("not root's");
    expect(rootMayUse("/tmp/f", TREES, stat(0, 0o41777))).toContain("can be written");
    expect(rootMayUse("/x/f", TREES, stat(0, 0o120777, false))).toContain("not a folder");
    expect(rootMayUse("/var/lib/hsn-hub/hub.db", TREES, stat(0, 0o40700))).toContain(
      "hub's own folders",
    );
    expect(rootMayUse("/var/lib/hsn-hub-program/staged/x/f", TREES, stat(0, 0o40700))).toContain(
      "hub's own folders",
    );
  });
});
