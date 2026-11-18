/**
 * The hub tightens its own tree's contents at every start (m2-design.md section 9, "The privilege
 * boundary"): every plain file and folder inside loses the group's and others' permissions; a link
 * is neither followed nor changed, so a link the hub's account planted to a file elsewhere cannot
 * make the walk touch that file.
 */
import { shortTempFolder } from "../../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tightenContents } from "../../../src/shell/safe/fs.ts";

const root = shortTempFolder("hsn-tighten-");
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
const CALLER = { kind: "storage", origin: "test" } as const;
const mode = (path: string) => statSync(path).mode & 0o7777;

describe.skipIf(process.platform === "win32")("tightening the data folder's contents", () => {
  test("files and folders lose group and other permissions; links are left alone, and not followed", () => {
    const data = join(root, "data");
    const outside = join(root, "outside.txt");
    mkdirSync(join(data, "uploads", "deep"), { recursive: true });
    writeFileSync(join(data, "hub.db"), "x");
    writeFileSync(join(data, "uploads", "deep", "a.bin"), "x");
    writeFileSync(outside, "someone else's");
    chmodSync(join(data, "hub.db"), 0o644);
    chmodSync(join(data, "uploads"), 0o755);
    chmodSync(join(data, "uploads", "deep", "a.bin"), 0o666);
    chmodSync(outside, 0o644);
    symlinkSync(outside, join(data, "link-to-outside"));
    symlinkSync(join(root), join(data, "uploads", "link-to-root"));
    chmodSync(join(data, "uploads", "deep"), 0o750);
    expect(tightenContents(CALLER, data)._unsafeUnwrap()).toBe(4);
    expect(mode(join(data, "hub.db"))).toBe(0o600);
    expect(mode(join(data, "uploads"))).toBe(0o700);
    expect(mode(join(data, "uploads", "deep"))).toBe(0o700);
    expect(mode(join(data, "uploads", "deep", "a.bin"))).toBe(0o600);
    // The link's target is untouched, and the link to a folder above was not walked into.
    expect(mode(outside)).toBe(0o644);
    expect(lstatSync(join(data, "link-to-outside")).isSymbolicLink()).toBe(true);
    // A second start finds nothing to change.
    expect(tightenContents(CALLER, data)._unsafeUnwrap()).toBe(0);
  });
});
