import { expect, test } from "bun:test";
import { shortTempBase } from "./temp-folder.ts";

const linuxTmpdir = "/dev/shm/hsn-tmp-XXXXXX";
const windowsTmpdir = "C:\\Users\\runner\\AppData\\Local\\Temp";
const macTmpdir = "/var/folders/ab/abcdefghijklmnopqrstuvwxyz/T";

test("Windows uses the system temp directory", () => {
  expect(shortTempBase("win32", linuxTmpdir, windowsTmpdir)).toBe(windowsTmpdir);
});

test("Linux uses an absolute TMPDIR up to 40 characters", () => {
  const limit = `/${"x".repeat(39)}`;
  expect(shortTempBase("linux", linuxTmpdir, "/var/tmp")).toBe(linuxTmpdir);
  expect(shortTempBase("linux", limit, "/var/tmp")).toBe(limit);
});

test("Linux uses /tmp when TMPDIR is unset", () => {
  expect(shortTempBase("linux", undefined, "/var/tmp")).toBe("/tmp");
});

test("Linux uses /tmp when TMPDIR is relative", () => {
  expect(shortTempBase("linux", "dev/shm", "/var/tmp")).toBe("/tmp");
});

test("Linux uses /tmp when TMPDIR exceeds 40 characters", () => {
  const tooLong = `/${"x".repeat(40)}`;
  expect(shortTempBase("linux", tooLong, "/var/tmp")).toBe("/tmp");
});

test("macOS uses /tmp even when TMPDIR is set", () => {
  expect(shortTempBase("darwin", linuxTmpdir, macTmpdir)).toBe("/tmp");
});
