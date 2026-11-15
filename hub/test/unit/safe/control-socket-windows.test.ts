/**
 * The Win32 calls of the control socket (`shell/safe/control-socket-windows.ts`). Off Windows,
 * each call comes back as an error, never thrown. On Windows (the hosted runner of
 * `.github/workflows/windows-control-socket.yml`), each is checked against the system's own
 * tools: the account against `whoami /user`, a folder's list against what `icacls` set, a socket
 * file's reparse tag, the system drive's flags.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  ADMINISTRATORS_SID,
  CONTAINER_INHERIT_ACE,
  OBJECT_INHERIT_ACE,
  parseDescriptor,
  parseSid,
  SE_DACL_PROTECTED,
  SYSTEM_SID,
} from "../../../src/shell/control/windows-acl.ts";
import {
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_REPARSE_POINT,
  FILE_PERSISTENT_ACLS,
  IO_REPARSE_TAG_AF_UNIX,
} from "../../../src/shell/control/windows.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import { isWindows, lockFolder, runProgram, system32 } from "../shell-control/windows-folders.ts";

const BASE = join(process.env.SystemDrive ?? "C:", "\\", `hsn-a11-safe-${process.pid}`);

afterAll(() => {
  if (isWindows) rmSync(BASE, { recursive: true, force: true });
});

describe.skipIf(isWindows)("off Windows", () => {
  test("every call is an error naming what it tried, and none throws", () => {
    const results = [
      WINDOWS_CALLS.processSid(),
      WINDOWS_CALLS.securityDescriptor("C:\\x"),
      WINDOWS_CALLS.attributes("C:\\x"),
      WINDOWS_CALLS.findEntry("C:\\x"),
      WINDOWS_CALLS.volume("C:\\x"),
    ];
    for (const result of results) {
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe("control");
        expect(result.error.origin).toBe("shell/safe/control-socket-windows");
      }
    }
    expect(results[0]?.isErr() ? results[0].error.message : "").toContain(
      "read the hub's own account",
    );
  });
});

describe.skipIf(!isWindows)("on Windows, against the system's own tools", () => {
  test("the account is the one whoami names", () => {
    const sid = parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
    const whoami = runProgram(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    expect(whoami.out).toContain(`"${sid}"`);
  });

  test("a folder's list reads as icacls set it: protected, the three accounts, passed on", () => {
    const folder = join(BASE, "locked");
    expect(lockFolder(folder).code).toBe(0);
    const own = parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
    const read = parseDescriptor(WINDOWS_CALLS.securityDescriptor(folder)._unsafeUnwrap());
    const descriptor = read._unsafeUnwrap();
    expect(descriptor.control & SE_DACL_PROTECTED).toBe(SE_DACL_PROTECTED);
    expect(
      (descriptor.dacl ?? []).map((ace) => [ace.kind, ace.sid, ace.flags, ace.mask]).sort(),
    ).toEqual(
      [own, ADMINISTRATORS_SID, SYSTEM_SID]
        .map((sid) => ["allow", sid, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE, 0x001f01ff])
        .sort(),
    );
    expect([own, ADMINISTRATORS_SID, SYSTEM_SID]).toContain(descriptor.owner ?? "");
  });

  test("attributes: a folder is a folder, a missing path is undefined", () => {
    mkdirSync(BASE, { recursive: true });
    const attributes = WINDOWS_CALLS.attributes(BASE)._unsafeUnwrap() ?? 0;
    expect(attributes & FILE_ATTRIBUTE_DIRECTORY).toBe(FILE_ATTRIBUTE_DIRECTORY);
    expect(WINDOWS_CALLS.attributes(join(BASE, "nothing"))._unsafeUnwrap()).toBeUndefined();
    expect(WINDOWS_CALLS.findEntry(join(BASE, "nothing"))._unsafeUnwrap()).toBeUndefined();
  });

  test("an AF_UNIX socket file is a reparse point with the AF_UNIX tag, and its list reads", async () => {
    const folder = join(BASE, "socket");
    expect(lockFolder(folder).code).toBe(0);
    const path = join(folder, "probe.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const entry = WINDOWS_CALLS.findEntry(path)._unsafeUnwrap();
    expect((entry?.attributes ?? 0) & FILE_ATTRIBUTE_REPARSE_POINT).toBe(
      FILE_ATTRIBUTE_REPARSE_POINT,
    );
    expect(entry?.reparseTag).toBe(IO_REPARSE_TAG_AF_UNIX);
    const read = WINDOWS_CALLS.securityDescriptor(path);
    expect(read.isOk() ? "read" : read.error.message).toBe("read");
    expect(parseDescriptor(read._unsafeUnwrap()).isOk()).toBe(true);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  test("the system drive keeps access lists and is a fixed drive", () => {
    const volume = WINDOWS_CALLS.volume(BASE)._unsafeUnwrap();
    expect(volume.root.toUpperCase()).toBe(`${(process.env.SystemDrive ?? "C:").toUpperCase()}\\`);
    expect(volume.flags & FILE_PERSISTENT_ACLS).toBe(FILE_PERSISTENT_ACLS);
    expect(volume.driveType).toBe(3);
  });
});
