/**
 * The Win32 calls of the control socket (`shell/safe/control-socket-windows.ts`) and `hsn.exe`'s
 * peer check (`shell/safe/control-socket-peer.ts`). Off Windows, each call comes back as an
 * error, never thrown, and the peer check never says yes. On Windows (the hosted runner of
 * `.github/workflows/windows-control-socket.yml`), each is checked against the system's own
 * tools: the account against `whoami`, the service's SID against `sc showsid`, a folder's list
 * against what `icacls` set, a socket file's reparse tag and peer, the system drive's flags; and
 * that setting a top folder's shape touches nothing inside it and refuses a junction; and
 * `hsn.exe`'s calls: elevation, named files read and exported by the person's rules.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  ADMINISTRATORS_SID,
  EMPTY_ACL,
  HUB_SERVICE_SID,
  INHERITED_ACE,
  parseDescriptor,
  parseSid,
  SE_DACL_PROTECTED,
  sidToBytes,
  topShape,
} from "../../../src/shell/control/windows-acl.ts";
import {
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_REPARSE_POINT,
  FILE_PERSISTENT_ACLS,
  IO_REPARSE_TAG_AF_UNIX,
} from "../../../src/shell/control/windows.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import {
  beginExport,
  openNamedFileForReading,
  processElevation,
  sidKind,
} from "../../../src/shell/safe/control-socket-hsn.ts";
import {
  checkHubPeer,
  refusalOf,
  socketPeer,
} from "../../../src/shell/safe/control-socket-peer.ts";
import {
  icacls,
  isWindows,
  junction,
  listVerdict,
  lockFolderTo,
  ordinaryFolder,
  removeTree,
  runProgram,
  made,
  shapeFolder,
  system32,
} from "../shell-control/windows-folders.ts";

const BASE = join(process.env.SystemDrive ?? "C:", "\\", `hsn-a11-safe-${process.pid}`);

afterAll(() => {
  // A leftover on a throwaway runner is not a failure of the calls under test.
  if (isWindows) removeTree(BASE);
});

describe("what a failed ask of who serves the socket means (run 43869303145's codes)", () => {
  const failure = (code: string) => ({
    kind: "control" as const,
    origin: "shell/safe/control-socket-peer",
    message: `connect failed with Windows error ${code}`,
    detail: { code },
  });

  test("refused or no such path: not running; access denied: not allowed; anything else: cannot tell", () => {
    expect(refusalOf(failure("WIN32_CONNECT_10061")).kind).toBe("notRunning");
    expect(refusalOf(failure("WIN32_CONNECT_10050")).kind).toBe("notRunning");
    expect(refusalOf(failure("WIN32_CONNECT_10013")).kind).toBe("notAllowed");
    for (const code of ["WIN32_10061", "WIN32_CONNECT_10022", "WIN32_5", "ENOENT"])
      expect(refusalOf(failure(code)).kind).toBe("cannotTell");
    expect(refusalOf({ kind: "control", origin: "x", message: "no code" }).kind).toBe("cannotTell");
  });
});

describe.skipIf(isWindows)("off Windows", () => {
  test("every call is an error naming what it tried, and none throws", () => {
    const results = [
      WINDOWS_CALLS.processSid(),
      WINDOWS_CALLS.securityDescriptor("C:\\x"),
      WINDOWS_CALLS.attributes("C:\\x"),
      WINDOWS_CALLS.findEntry("C:\\x"),
      WINDOWS_CALLS.volume("C:\\x"),
      WINDOWS_CALLS.isAdministrator(),
      WINDOWS_CALLS.setTopShape("C:\\x", new Uint8Array(20)),
      WINDOWS_CALLS.inheritFromParent("C:\\x", EMPTY_ACL, new Uint8Array(16)),
      WINDOWS_CALLS.defaultOwnerAdministrators(new Uint8Array(16)),
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

  test("the peer check cannot tell, and says so: it never answers yes", () => {
    const checked = checkHubPeer("C:\\x\\control.sock", HUB_SERVICE_SID);
    expect(checked.isErr() ? checked.error.kind : "accepted").toBe("cannotTell");
    expect(socketPeer("C:\\x\\control.sock").isErr()).toBe(true);
  });
});

describe.skipIf(!isWindows)("on Windows, against the system's own tools", () => {
  const own = (): string =>
    parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
  const descriptorOf = (path: string) =>
    parseDescriptor(WINDOWS_CALLS.securityDescriptor(path)._unsafeUnwrap())._unsafeUnwrap();
  const entries = (path: string) =>
    (descriptorOf(path).dacl ?? []).map((ace) => [ace.kind, ace.sid, ace.flags, ace.mask]);

  test("the account is the one whoami names, and the runner's token is an elevated administrator's", () => {
    const whoami = runProgram(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
    expect(whoami.out).toContain(`"${own()}"`);
    expect(WINDOWS_CALLS.isAdministrator()._unsafeUnwrap()).toBe(true);
  });

  test("NT SERVICE\\HSNHub's SID is the one sc.exe derives", () => {
    const shown = runProgram(system32("sc.exe"), ["showsid", "HSNHub"]);
    expect(shown.out).toContain(HUB_SERVICE_SID);
  });

  test("a folder icacls made in the installer's shape reads as exactly that shape", () => {
    const folder = join(BASE, "shaped");
    expect(made(shapeFolder(folder))).toBe("made");
    const descriptor = descriptorOf(folder);
    expect(descriptor.owner).toBe(ADMINISTRATORS_SID);
    expect(descriptor.control & SE_DACL_PROTECTED).toBe(SE_DACL_PROTECTED);
    const shape = parseDescriptor(topShape(HUB_SERVICE_SID)._unsafeUnwrap())._unsafeUnwrap();
    expect(entries(folder).sort()).toEqual(
      (shape.dacl ?? []).map((ace) => [ace.kind, ace.sid, ace.flags, ace.mask]).sort(),
    );
  });

  test("setTopShape sets the folder alone: the shape on it, what is inside unchanged, a junction refused", () => {
    const folder = join(BASE, "set");
    ordinaryFolder(folder);
    writeFileSync(join(folder, "inside.txt"), "x");
    const insideBefore = WINDOWS_CALLS.securityDescriptor(
      join(folder, "inside.txt"),
    )._unsafeUnwrap();
    const set = WINDOWS_CALLS.setTopShape(folder, topShape(HUB_SERVICE_SID)._unsafeUnwrap());
    expect(set.isOk() ? "set" : set.error.message).toBe("set");
    expect(listVerdict(folder, { top: true, mode: "service" })).toBe("closed");
    expect([
      ...WINDOWS_CALLS.securityDescriptor(join(folder, "inside.txt"))._unsafeUnwrap(),
    ]).toEqual([...insideBefore]);
    const target = join(BASE, "target");
    ordinaryFolder(target);
    const targetBefore = WINDOWS_CALLS.securityDescriptor(target)._unsafeUnwrap();
    expect(junction(join(BASE, "link"), target).code).toBe(0);
    const linked = WINDOWS_CALLS.setTopShape(
      join(BASE, "link"),
      topShape(HUB_SERVICE_SID)._unsafeUnwrap(),
    );
    expect(linked.isErr() ? linked.error.message : "set").toContain("is a link");
    expect([...WINDOWS_CALLS.securityDescriptor(target)._unsafeUnwrap()]).toEqual([
      ...targetBefore,
    ]);
    runProgram(system32("cmd.exe"), ["/d", "/c", "rmdir", join(BASE, "link")]);
  });

  test("inheritFromParent drops an object's own entries and leaves what it inherits", () => {
    const folder = join(BASE, "inherit");
    // Shaped for the runner's own account as the service: icacls, used next to plant an entry,
    // works only with accounts it can name, and NT SERVICE\HSNHub has no name on the runner.
    expect(made(shapeFolder(folder, own()))).toBe("made");
    const file = join(folder, "planted.txt");
    writeFileSync(file, "x");
    expect(made(icacls(file, "/grant", "*S-1-1-0:(R)"))).toBe("made");
    expect(entries(file).some(([, sid]) => sid === "S-1-1-0")).toBe(true);
    const inherited = WINDOWS_CALLS.inheritFromParent(
      file,
      EMPTY_ACL,
      sidToBytes(own())._unsafeUnwrap(),
    );
    expect(inherited.isOk() ? "made" : inherited.error.message).toBe("made");
    expect(entries(file).some(([, sid]) => sid === "S-1-1-0")).toBe(false);
    expect(descriptorOf(file).owner).toBe(own());
    expect(entries(file).every(([, , flags]) => ((flags as number) & INHERITED_ACE) !== 0)).toBe(
      true,
    );
  });

  test("defaultOwnerAdministrators: what this process creates next is owned by Administrators", () => {
    expect(
      WINDOWS_CALLS.defaultOwnerAdministrators(
        sidToBytes(ADMINISTRATORS_SID)._unsafeUnwrap(),
      ).isOk(),
    ).toBe(true);
    const file = join(BASE, "owned.txt");
    mkdirSync(BASE, { recursive: true });
    writeFileSync(file, "x");
    expect(descriptorOf(file).owner).toBe(ADMINISTRATORS_SID);
  });

  test("list names a folder's entries by FindFirstFileW, and a missing folder's none", () => {
    const folder = join(BASE, "listed");
    mkdirSync(join(folder, "sub"), { recursive: true });
    writeFileSync(join(folder, "a.txt"), "x");
    expect([...WINDOWS_CALLS.list(folder)._unsafeUnwrap()].sort()).toEqual(["a.txt", "sub"]);
    expect(WINDOWS_CALLS.list(join(BASE, "nothing"))._unsafeUnwrap()).toEqual([]);
  });

  test("the peer check says not running, or not allowed, rather than cannot tell", () => {
    const empty = join(BASE, "no-hub");
    mkdirSync(empty, { recursive: true });
    const none = checkHubPeer(join(empty, "control.sock"), HUB_SERVICE_SID);
    expect(none.isErr() ? none.error.kind : "accepted").toBe("notRunning");
    const missing = checkHubPeer(join(BASE, "missing", "control.sock"), HUB_SERVICE_SID);
    expect(missing.isErr() ? missing.error.kind : "accepted").toBe("notRunning");
  });

  test("attributes: a folder is a folder, a missing path is undefined", () => {
    mkdirSync(BASE, { recursive: true });
    const attributes = WINDOWS_CALLS.attributes(BASE)._unsafeUnwrap() ?? 0;
    expect(attributes & FILE_ATTRIBUTE_DIRECTORY).toBe(FILE_ATTRIBUTE_DIRECTORY);
    expect(WINDOWS_CALLS.attributes(join(BASE, "nothing"))._unsafeUnwrap()).toBeUndefined();
    expect(WINDOWS_CALLS.findEntry(join(BASE, "nothing"))._unsafeUnwrap()).toBeUndefined();
  });

  test("an AF_UNIX socket file: the AF_UNIX tag, its list read, and its peer this process", async () => {
    const folder = join(BASE, "socket");
    expect(made(shapeFolder(folder))).toBe("made");
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
    const peer = socketPeer(path);
    expect(peer.isOk() ? peer.value : peer.error.message).toEqual({ pid: process.pid, sid: own() });
    expect(checkHubPeer(path, own()).isOk()).toBe(true);
    const notTheHub = checkHubPeer(path, HUB_SERVICE_SID);
    expect(notTheHub.isErr() ? notTheHub.error.kind : "accepted").toBe("notTheHub");
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    const gone = checkHubPeer(path, own());
    expect(gone.isErr() ? gone.error.kind : "accepted").toBe("notRunning");
  });

  test("the system drive keeps access lists and is a fixed drive", () => {
    const volume = WINDOWS_CALLS.volume(BASE)._unsafeUnwrap();
    expect(volume.root.toUpperCase()).toBe(`${(process.env.SystemDrive ?? "C:").toUpperCase()}\\`);
    expect(volume.flags & FILE_PERSISTENT_ACLS).toBe(FILE_PERSISTENT_ACLS);
    expect(volume.driveType).toBe(3);
  });
});

describe.skipIf(!isWindows)("on Windows, hsn.exe's calls (control-socket-hsn.ts)", () => {
  const own = (): string =>
    parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
  const named = join(BASE, "named");

  test("the runner's token is elevated; Windows names the runner a user and the service a group", () => {
    expect(processElevation()).toEqual({ kind: "elevated" });
    expect(sidKind(own())).toBe("user");
    expect(sidKind(ADMINISTRATORS_SID)).toBe("other");
    expect(sidKind(HUB_SERVICE_SID)).toBe("other");
  });

  test("a plain file is read whole from its handle, resolved by Windows", () => {
    mkdirSync(named, { recursive: true });
    const file = join(named, "update.bin");
    const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
    writeFileSync(file, bytes);
    const opened = openNamedFileForReading(file, []);
    expect(opened.isOk() ? "opened" : opened.error.message).toBe("opened");
    if (opened.isErr()) return;
    const reader = opened.value;
    expect(reader.size).toBe(bytes.length);
    const got: number[] = [];
    const chunk = new Uint8Array(16_384);
    for (let n = reader.read(chunk)._unsafeUnwrap(); n > 0; n = reader.read(chunk)._unsafeUnwrap())
      got.push(...chunk.subarray(0, n));
    reader.close();
    expect(got).toEqual([...bytes]);
    expect(reader.finalPath.toLowerCase()).toContain(file.toLowerCase().slice(2));
  });

  test("refused: a link as the last part, a folder, a file in a hub tree, or reached through a junction into one", () => {
    mkdirSync(named, { recursive: true });
    writeFileSync(join(named, "target.txt"), "x");
    const link = runProgram(system32("cmd.exe"), [
      "/d",
      "/c",
      "mklink",
      join(named, "link.txt"),
      join(named, "target.txt"),
    ]);
    expect(link.code).toBe(0);
    const viaLink = openNamedFileForReading(join(named, "link.txt"), []);
    expect(viaLink.isErr() ? viaLink.error.kind : "opened").toBe("reparsePoint");
    const aFolder = openNamedFileForReading(named, []);
    expect(aFolder.isErr() ? aFolder.error.kind : "opened").toBe("notAFile");
    const tree = join(BASE, "tree");
    expect(made(shapeFolder(tree))).toBe("made");
    writeFileSync(join(tree, "hub.db"), "x");
    const inside = openNamedFileForReading(join(tree, "hub.db"), [tree]);
    expect(inside.isErr() ? inside.error.kind : "opened").toBe("insideHubTree");
    expect(junction(join(named, "into-tree"), tree).code).toBe(0);
    const through = openNamedFileForReading(join(named, "into-tree", "hub.db"), [tree]);
    expect(through.isErr() ? through.error.kind : "opened").toBe("insideHubTree");
    runProgram(system32("cmd.exe"), ["/d", "/c", "rmdir", join(named, "into-tree")]);
    const missing = openNamedFileForReading(join(named, "nothing"), []);
    expect(missing.isErr() ? missing.error.kind : "opened").toBe("failed");
  });

  test("an export into a folder of the person's own is written and renamed over the target, nothing left beside it", () => {
    const mine = join(BASE, "mine");
    expect(lockFolderTo(mine, [own(), ADMINISTRATORS_SID, "S-1-5-18"]).code).toBe(0);
    const target = join(mine, "backup.hsnb");
    writeFileSync(target, "an older one");
    const begun = beginExport(target, []);
    expect(begun.isOk() ? "begun" : begun.error.message).toBe("begun");
    if (begun.isErr()) return;
    expect(begun.value.warning).toBeUndefined();
    expect(begun.value.write(new Uint8Array([1, 2, 3])).isOk()).toBe(true);
    expect(begun.value.finish().isOk()).toBe(true);
    expect([...readFileSync(target)]).toEqual([1, 2, 3]);
    expect(readdirSync(mine)).toEqual(["backup.hsnb"]);
    const again = beginExport(join(mine, "other.hsnb"), []);
    if (again.isOk()) again.value.abandon();
    expect(readdirSync(mine)).toEqual(["backup.hsnb"]);
  });

  test("an export into the runner user's own Documents succeeds, written whole and renamed into place", () => {
    // Asserted, not recorded: a rule too strict here would make `hsn backup export` useless on a
    // real PC. The folder must exist on the runner; if it does not, this fails and says so.
    const documents = join(homedir(), "Documents");
    expect(existsSync(documents) ? "Documents exists" : `no folder at ${documents}`).toBe(
      "Documents exists",
    );
    const target = join(documents, `hsn-a11-${process.pid}.hsnb`);
    const begun = beginExport(target, []);
    expect(begun.isOk() ? "begun" : begun.error.message).toBe("begun");
    if (begun.isErr()) return;
    const bytes = new Uint8Array([7, 8, 9]);
    expect(begun.value.write(bytes).isOk()).toBe(true);
    const finished = begun.value.finish();
    expect(finished.isOk() ? "finished" : finished.error.message).toBe("finished");
    expect([...readFileSync(target)]).toEqual([...bytes]);
    expect(
      readdirSync(documents).filter((name) => name.startsWith(`hsn-a11-${process.pid}`)),
    ).toEqual([`hsn-a11-${process.pid}.hsnb`]);
    rmSync(target, { force: true });
  });

  test("an export into a folder the service may write (inherited Authenticated Users) goes ahead, with the warning (D124)", () => {
    const ordinary = join(BASE, "ordinary");
    ordinaryFolder(ordinary);
    const target = join(ordinary, "b.hsnb");
    const begun = beginExport(target, []);
    expect(begun.isOk() ? "begun" : begun.error.message).toBe("begun");
    if (begun.isErr()) return;
    expect(begun.value.warning).toContain("the hub's service account could also write in");
    expect(begun.value.serviceMayWrite.join("; ")).toContain("Authenticated Users");
    expect(begun.value.write(new Uint8Array([1])).isOk()).toBe(true);
    expect(begun.value.finish().isOk()).toBe(true);
    expect([...readFileSync(target)]).toEqual([1]);
  });

  test("an export refused: a hub tree, a link as target or folder", () => {
    const tree = join(BASE, "tree2");
    expect(made(shapeFolder(tree))).toBe("made");
    const inside = beginExport(join(tree, "b.hsnb"), [tree]);
    expect(inside.isErr() ? inside.error.kind : "begun").toBe("insideHubTree");
    const mine = join(BASE, "mine2");
    expect(lockFolderTo(mine, [own(), ADMINISTRATORS_SID, "S-1-5-18"]).code).toBe(0);
    writeFileSync(join(mine, "real.hsnb"), "x");
    expect(
      runProgram(system32("cmd.exe"), [
        "/d",
        "/c",
        "mklink",
        join(mine, "link.hsnb"),
        join(mine, "real.hsnb"),
      ]).code,
    ).toBe(0);
    const viaLink = beginExport(join(mine, "link.hsnb"), []);
    expect(viaLink.isErr() ? viaLink.error.kind : "begun").toBe("reparsePoint");
    expect(junction(join(BASE, "mine-link"), mine).code).toBe(0);
    const viaJunction = beginExport(join(BASE, "mine-link", "b.hsnb"), []);
    expect(viaJunction.isErr() ? viaJunction.error.kind : "begun").toBe("reparsePoint");
    runProgram(system32("cmd.exe"), ["/d", "/c", "rmdir", join(BASE, "mine-link")]);
  });
});
