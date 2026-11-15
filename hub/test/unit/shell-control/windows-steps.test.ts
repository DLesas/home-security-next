/**
 * The control socket's Windows steps (`shell/control/windows.ts`), on every system: the real
 * server over a real AF_UNIX socket, with the Win32 answers (the account, the attributes, the
 * volume, the access lists, setting a list) given as data by `windows-data.ts`. What it shows:
 * the folder is checked before anything listens; an open folder is closed by the hub with the
 * installer's list, read back and warned of, and refused when it cannot be closed; a link in the
 * path is refused and never set; the socket file is read back after listening and a failure there
 * closes the listener; an old socket is replaced and a running hub's kept; macOS and Linux keep
 * their own steps, which never warn.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import { UnixControlServer } from "../../../src/shell/control/server.ts";
import { hubAnswers } from "../../../src/shell/control/socket-file.ts";
import { socketStepsFor, UNIX_SOCKET_STEPS } from "../../../src/shell/control/socket-steps.ts";
import {
  ADMINISTRATORS_SID,
  allowedSids,
  parseAcl,
  protectedAcl,
  SE_DACL_PRESENT,
  SE_SELF_RELATIVE,
} from "../../../src/shell/control/windows-acl.ts";
import {
  type ControlWarning,
  DRIVE_NO_ROOT_DIR,
  DRIVE_REMOTE,
  DRIVE_UNKNOWN,
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_REPARSE_POINT,
  IO_REPARSE_TAG_AF_UNIX,
  MAX_ENTRIES_CHECKED,
  windowsSocketSteps,
} from "../../../src/shell/control/windows.ts";
import type { WindowsCalls } from "../../../src/shell/safe/control-socket-windows.ts";
import { RawClient, type TestFolder, testFolder } from "./support.ts";
import {
  CREATOR_OWNER_SID,
  descriptorBytes,
  EVERYONE_SID,
  type FakeWindows,
  fakeWindows,
  HUB_SID,
  INHERITED,
  lockedAces,
  OI_CI,
  pathKey,
  setFor,
  socketAces,
  USER_SID,
  USERS_SID,
} from "./windows-data.ts";

const folders: TestFolder[] = [];
const servers: UnixControlServer[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) expect((await s.close()).isOk()).toBe(true);
  for (const f of folders.splice(0)) f.remove();
});

const STATUS = `${JSON.stringify({ id: 7, actor: "dimitri", command: { kind: "status" } })}\n`;
const ONLY_THREE = protectedAcl({ hub: HUB_SID })._unsafeUnwrap();

interface Place {
  readonly where: TestFolder;
  readonly fake: FakeWindows;
  readonly calls: WindowsCalls;
  readonly warnings: ControlWarning[];
  readonly steps: () => ReturnType<typeof windowsSocketSteps>;
}

/** A data folder that exists, and the fake calls answering for it as a locked Windows folder. */
function place(): Place {
  const where = testFolder();
  folders.push(where);
  mkdirSync(where.folder, { recursive: true, mode: 0o700 });
  const warnings: ControlWarning[] = [];
  const { fake, calls } = fakeWindows();
  return {
    where,
    fake,
    calls,
    warnings,
    steps: () => windowsSocketSteps(calls, (warning) => warnings.push(warning)),
  };
}

async function open(
  socketPath: string,
  steps: ReturnType<typeof windowsSocketSteps>,
): Promise<{ readonly server?: UnixControlServer; readonly error?: HubError }> {
  const opened = await UnixControlServer.open({
    socketPath,
    steps,
    logQuery: () => ok([]),
    deviceIdOf: () => undefined,
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
  });
  if (opened.isErr()) return { error: opened.error };
  servers.push(opened.value);
  return { server: opened.value };
}

/** Opens and expects a refusal: its message, and no socket left. */
async function refusal(at: Place): Promise<string> {
  const { error } = await open(at.where.socket, at.steps());
  expect(existsSync(at.where.socket)).toBe(false);
  return error?.message ?? "opened";
}

async function answers(server: UnixControlServer | undefined, socket: string): Promise<boolean> {
  const events: unknown[] = [];
  server?.listen((event) => events.push(event));
  const client = new RawClient(socket);
  client.write(STATUS);
  return client.until(() => events.length === 1);
}

const setCalls = (fake: FakeWindows) => fake.calls.filter((c) => c.startsWith("setProtectedList"));

describe("Windows: a folder locked to the hub, Administrators and SYSTEM", () => {
  test("the socket opens, after the folder was read, and answers; nothing is set or warned", async () => {
    const at = place();
    const { server, error } = await open(at.where.socket, at.steps());
    expect(error?.message ?? "opened").toBe("opened");
    expect(await answers(server, at.where.socket)).toBe(true);
    const folderRead = at.fake.calls.findIndex(
      (c) => c.startsWith("securityDescriptor") && !c.endsWith(".sock"),
    );
    const pathLooked = at.fake.calls.findIndex((c) => c.startsWith("findEntry"));
    const socketRead = at.fake.calls.findIndex(
      (c) => c.startsWith("securityDescriptor") && c.endsWith(".sock"),
    );
    expect(folderRead).toBeGreaterThan(-1);
    expect(pathLooked).toBeGreaterThan(folderRead);
    expect(socketRead).toBeGreaterThan(pathLooked);
    expect(setCalls(at.fake)).toEqual([]);
    expect(at.warnings).toEqual([]);
  });

  test("a deny entry does not make it open", async () => {
    const at = place();
    setFor(
      at.fake.descriptors,
      at.where.folder,
      descriptorBytes({
        owner: ADMINISTRATORS_SID,
        dacl: [{ kind: "deny", sid: EVERYONE_SID, flags: OI_CI }, ...lockedAces()],
      }),
    );
    expect((await open(at.where.socket, at.steps())).error?.message ?? "opened").toBe("opened");
    expect(setCalls(at.fake)).toEqual([]);
  });
});

describe("Windows: an open folder is closed by the hub, read back, and warned of", () => {
  const OPEN_LISTS: readonly [string, Parameters<typeof descriptorBytes>[0], string][] = [
    [
      "Users let in",
      {
        owner: ADMINISTRATORS_SID,
        dacl: [...lockedAces(), { kind: "allow", sid: USERS_SID, flags: OI_CI, mask: 0x1200a9 }],
      },
      "it lets in Users (S-1-5-32-545) (access 0x001200a9)",
    ],
    [
      "an ordinary account let in",
      {
        owner: ADMINISTRATORS_SID,
        dacl: [...lockedAces(), { kind: "allow", sid: USER_SID, flags: OI_CI }],
      },
      `it lets in ${USER_SID}`,
    ],
    [
      "inheritance on",
      { owner: ADMINISTRATORS_SID, control: SE_SELF_RELATIVE | SE_DACL_PRESENT },
      "inheritance is on",
    ],
    [
      "an inherited entry",
      {
        owner: ADMINISTRATORS_SID,
        dacl: [...lockedAces(), { kind: "allow", sid: USERS_SID, flags: INHERITED }],
      },
      "an entry inherited from above",
    ],
    ["no list at all", { owner: ADMINISTRATORS_SID, dacl: null }, "no access list at all"],
    [
      "an entry of a kind the hub does not read",
      { owner: ADMINISTRATORS_SID, dacl: [...lockedAces(), { kind: 0x09, sid: USERS_SID }] },
      "a kind the hub does not read (type 0x09)",
    ],
    [
      "an inherit-only entry for CREATOR OWNER",
      {
        owner: HUB_SID,
        dacl: [...lockedAces(), { kind: "allow", sid: CREATOR_OWNER_SID, flags: OI_CI | 0x08 }],
      },
      "CREATOR OWNER",
    ],
  ];

  for (const [what, spec, found] of OPEN_LISTS) {
    test(`${what}: the installer's list is set, read back, and the socket opens, with the warning`, async () => {
      const at = place();
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes(spec));
      const { server, error } = await open(at.where.socket, at.steps());
      expect(error?.message ?? "opened").toBe("opened");
      expect(await answers(server, at.where.socket)).toBe(true);
      expect(at.fake.listsSet.map(({ acl }) => [...acl])).toEqual([[...ONLY_THREE]]);
      expect(at.warnings).toHaveLength(1);
      expect(at.warnings[0]?.code).toBe("data_folder_was_open");
      expect(at.warnings[0]?.detail.closed).toBe(true);
      expect(at.warnings[0]?.message).toContain(found);
      expect(at.warnings[0]?.message).toContain("another account may have read the device keys");
      // Set, then read back, then the socket's path looked at.
      const set = at.fake.calls.findIndex((c) => c.startsWith("setProtectedList"));
      const readBack = at.fake.calls.findIndex(
        (c, i) => i > set && c.startsWith("securityDescriptor") && !c.endsWith(".sock"),
      );
      const looked = at.fake.calls.findIndex((c) => c.startsWith("findEntry"));
      expect(set).toBeGreaterThan(-1);
      expect(readBack).toBeGreaterThan(set);
      expect(looked).toBeGreaterThan(readBack);
    });
  }

  test("the list set never lets anyone in: it names the three accounts alone, whatever was there", async () => {
    for (const [, spec] of OPEN_LISTS) {
      const at = place();
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes(spec));
      expect((await at.steps().prepare(at.where.socket)).isOk()).toBe(true);
      expect(at.fake.listsSet).toHaveLength(1);
      for (const { acl } of at.fake.listsSet) {
        const entries = parseAcl(acl, 0)._unsafeUnwrap();
        expect(entries.every((e) => e.kind === "allow")).toBe(true);
        expect(entries.map((e) => e.sid)).toEqual([...allowedSids({ hub: HUB_SID })]);
      }
    }
  });

  test("set only on the data folder itself, by the path checked", async () => {
    const at = place();
    setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ owner: HUB_SID, dacl: null }));
    await open(at.where.socket, at.steps());
    expect(at.fake.listsSet.map(({ path }) => path.toLowerCase())).toEqual([
      pathKey(at.where.folder),
    ]);
  });

  test("an old socket file inside is not a link: the folder is still closed", async () => {
    const at = place();
    setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ owner: HUB_SID, dacl: null }));
    at.fake.contents.set(pathKey(at.where.folder), ["old.sock"]);
    setFor(at.fake.attributes, join(at.where.folder, "old.sock"), FILE_ATTRIBUTE_REPARSE_POINT);
    setFor(at.fake.entries, join(at.where.folder, "old.sock"), {
      attributes: FILE_ATTRIBUTE_REPARSE_POINT,
      reparseTag: IO_REPARSE_TAG_AF_UNIX,
    });
    expect((await open(at.where.socket, at.steps())).error?.message ?? "opened").toBe("opened");
    expect(setCalls(at.fake)).toHaveLength(1);
  });
});

describe("Windows: an open folder the hub cannot close is refused, with the warning", () => {
  function openFolder(at: Place): void {
    setFor(
      at.fake.descriptors,
      at.where.folder,
      descriptorBytes({
        owner: ADMINISTRATORS_SID,
        dacl: [...lockedAces(), { kind: "allow", sid: USERS_SID }],
      }),
    );
  }

  function expectWarnedNotClosed(at: Place): void {
    expect(at.warnings).toHaveLength(1);
    expect(at.warnings[0]?.code).toBe("data_folder_was_open");
    expect(at.warnings[0]?.detail.closed).toBe(false);
  }

  test("an owner who is not allowed: the list is not set (an owner can rewrite it)", async () => {
    const at = place();
    setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ owner: USERS_SID }));
    expect(await refusal(at)).toContain("setting the list cannot change an owner");
    expect(setCalls(at.fake)).toEqual([]);
    expectWarnedNotClosed(at);
    const none = place();
    setFor(none.fake.descriptors, none.where.folder, descriptorBytes({ owner: null }));
    expect(await refusal(none)).toContain("it has no owner");
    expect(setCalls(none.fake)).toEqual([]);
  });

  test("a file system without access lists (FAT, exFAT)", async () => {
    const at = place();
    at.fake.volume = { root: "E:\\", flags: 0x3, driveType: 2 };
    expect(await refusal(at)).toBe(
      "the data folder's file system (E:\\) keeps no access lists (FAT or exFAT?): any account could open the socket",
    );
    expect(setCalls(at.fake)).toEqual([]);
    expectWarnedNotClosed(at);
  });

  test("the hub has no right to set the list", async () => {
    const at = place();
    openFolder(at);
    at.fake.setList = "error";
    expect(await refusal(at)).toContain(
      "the hub could not set the list: SetSecurityInfo failed with Windows error 5",
    );
    expectWarnedNotClosed(at);
  });

  test("the list read back is still open", async () => {
    const at = place();
    openFolder(at);
    at.fake.setList = "ignored";
    expect(await refusal(at)).toContain("the list the hub set reads back open: it lets in Users");
    expectWarnedNotClosed(at);
  });

  test("a folder swapped for a link while its list is set is refused on the check after", async () => {
    const at = place();
    openFolder(at);
    const swapping: WindowsCalls = {
      ...at.calls,
      setProtectedList: (path, acl) => {
        setFor(
          at.fake.attributes,
          at.where.folder,
          FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
        );
        return at.calls.setProtectedList(path, acl);
      },
    };
    const warnings: ControlWarning[] = [];
    const { error } = await open(
      at.where.socket,
      windowsSocketSteps(swapping, (w) => warnings.push(w)),
    );
    expect(error?.message).toContain("the data folder is a link");
    expect(warnings[0]?.detail.closed).toBe(false);
  });

  test("a link inside the folder, at any depth: refused, nothing set", async () => {
    for (const depth of [1, 2]) {
      const at = place();
      openFolder(at);
      const sub = join(at.where.folder, "backups");
      if (depth === 1) at.fake.contents.set(pathKey(at.where.folder), ["hub.db", "keys"]);
      else {
        at.fake.contents.set(pathKey(at.where.folder), ["hub.db", "backups"]);
        at.fake.contents.set(pathKey(sub), ["keys"]);
      }
      const link = join(depth === 1 ? at.where.folder : sub, "keys");
      setFor(at.fake.attributes, join(at.where.folder, "hub.db"), 0x20);
      setFor(at.fake.attributes, link, FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT);
      setFor(at.fake.entries, link, {
        attributes: FILE_ATTRIBUTE_REPARSE_POINT,
        reparseTag: 0xa0000003,
      });
      expect(await refusal(at)).toContain("inside the data folder, is a link");
      expect(setCalls(at.fake)).toEqual([]);
      expectWarnedNotClosed(at);
    }
  });

  test(`more than ${MAX_ENTRIES_CHECKED} entries inside: refused, nothing set`, async () => {
    const at = place();
    openFolder(at);
    at.fake.contents.set(
      pathKey(at.where.folder),
      Array.from({ length: MAX_ENTRIES_CHECKED + 1 }, (_, i) => `f${i}`),
    );
    expect(await refusal(at)).toContain(`more than ${MAX_ENTRIES_CHECKED} entries`);
    expect(setCalls(at.fake)).toEqual([]);
  });

  test("a folder inside that cannot be listed: refused, nothing set", async () => {
    const at = place();
    openFolder(at);
    const broken: WindowsCalls = {
      ...at.calls,
      list: () => err({ kind: "control", origin: "test", message: "FindFirstFileW failed" }),
    };
    const warnings: ControlWarning[] = [];
    const { error } = await open(
      at.where.socket,
      windowsSocketSteps(broken, (w) => warnings.push(w)),
    );
    expect(error?.message).toContain("the hub cannot list");
    expect(setCalls(at.fake)).toEqual([]);
    expect(warnings[0]?.detail.closed).toBe(false);
  });
});

describe("Windows: refused as it is found, nothing set and nothing warned", () => {
  async function unchanged(at: Place, expected: string): Promise<void> {
    expect(await refusal(at)).toContain(expected);
    expect(setCalls(at.fake)).toEqual([]);
    expect(at.warnings).toEqual([]);
  }

  test("a list that cannot be read, or bytes that are not a descriptor", async () => {
    const unreadable = place();
    setFor(unreadable.fake.descriptors, unreadable.where.folder, "error");
    await unchanged(
      unreadable,
      "the data folder's access list cannot be read: GetSecurityInfo failed with Windows error 5",
    );
    const garbled = place();
    setFor(garbled.fake.descriptors, garbled.where.folder, new Uint8Array(8));
    await unchanged(garbled, "cannot be read (the descriptor is too short)");
  });

  test("the hub's own account cannot be read, or is not a SID", async () => {
    const first = place();
    first.fake.sid = "error";
    await unchanged(first, "the hub cannot tell which account it runs as");
    const second = place();
    second.fake.sid = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 5]);
    await unchanged(second, "a SID of revision 2");
  });

  test("a missing data folder is refused, not made", async () => {
    const at = place();
    setFor(at.fake.attributes, at.where.folder, undefined);
    await unchanged(
      at,
      "the data folder does not exist: the installer makes it, with its access list",
    );
  });

  test("a data folder that is not a folder", async () => {
    const at = place();
    setFor(at.fake.attributes, at.where.folder, 0x20);
    await unchanged(at, "the data folder is not a folder");
  });

  test("a link as the data folder, or anywhere above it, even when the folder is open", async () => {
    const first = place();
    setFor(
      first.fake.attributes,
      first.where.folder,
      FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
    );
    setFor(first.fake.descriptors, first.where.folder, descriptorBytes({ dacl: null }));
    await unchanged(first, "the data folder is a link");
    const second = place();
    const above = dirname(dirname(second.where.folder));
    setFor(second.fake.attributes, above, FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT);
    setFor(second.fake.descriptors, second.where.folder, descriptorBytes({ dacl: null }));
    await unchanged(second, "above the data folder, is a link");
    expect(second.fake.calls.some((c) => c.startsWith("securityDescriptor"))).toBe(false);
  });

  test("a folder whose attributes cannot be read", async () => {
    const at = place();
    setFor(at.fake.attributes, dirname(at.where.folder), "error");
    await unchanged(at, "the hub cannot look at");
  });

  test("a network drive, or a drive of a kind the hub cannot tell", async () => {
    for (const driveType of [DRIVE_REMOTE, DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR]) {
      const at = place();
      at.fake.volume = { root: "Z:\\", flags: 0x8, driveType };
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ dacl: null }));
      await unchanged(
        at,
        driveType === DRIVE_REMOTE ? "on a network drive (Z:\\)" : "of a kind the hub cannot tell",
      );
    }
  });

  test("a volume that cannot be read", async () => {
    const at = place();
    at.fake.volume = "error";
    await unchanged(at, "the hub cannot read the data folder's volume");
  });

  test("a path longer than the socket allows", async () => {
    const at = place();
    const prepared = await at.steps().prepare(`C:\\${"x".repeat(120)}\\control.sock`);
    expect(prepared.isErr() ? prepared.error.message : "").toContain("longer than 103 bytes");
  });
});

describe("Windows: the socket file, read back after listening", () => {
  test("another account in the socket file's own list: refused, and the listener closed", async () => {
    const at = place();
    setFor(
      at.fake.descriptors,
      at.where.socket,
      descriptorBytes({
        owner: ADMINISTRATORS_SID,
        control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
        dacl: [...socketAces(), { kind: "allow", sid: EVERYONE_SID }],
      }),
    );
    const { error } = await open(at.where.socket, at.steps());
    expect(error?.message ?? "opened").toContain(
      "the socket file's access list admits more than the hub's account",
    );
    expect(error?.message).toContain("it lets in Everyone");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("no socket file after listening (a path taken as a named pipe): refused, and closed", async () => {
    const at = place();
    let listened = false;
    const steps = windowsSocketSteps(
      {
        ...at.calls,
        findEntry: (path) => {
          if (!listened) {
            listened = true;
            return at.calls.findEntry(path);
          }
          return ok(undefined);
        },
      },
      () => undefined,
    );
    const { error } = await open(at.where.socket, steps);
    expect(error?.message).toContain("listening left no socket file at the path");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("something other than an AF_UNIX socket file at the path after listening: refused, and closed", async () => {
    const at = place();
    let looked = 0;
    const steps = windowsSocketSteps(
      {
        ...at.calls,
        findEntry: (path) =>
          looked++ === 0 ? at.calls.findEntry(path) : ok({ attributes: 0x20, reparseTag: 0 }),
      },
      () => undefined,
    );
    const { error } = await open(at.where.socket, steps);
    expect(error?.message).toBe("what is at the socket's path is not an AF_UNIX socket file");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("a socket file whose list cannot be read: refused, and closed", async () => {
    const at = place();
    setFor(at.fake.descriptors, at.where.socket, "error");
    const { error } = await open(at.where.socket, at.steps());
    expect(error?.message).toContain("the socket file's access list cannot be read");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });
});

describe("Windows: an old socket, a running hub's, and closing", () => {
  test("an old socket file with no hub behind it is removed and replaced", async () => {
    const at = place();
    const script = `require("net").createServer().listen(${JSON.stringify(at.where.socket)}, () => process.kill(process.pid, "SIGKILL"))`;
    spawnSync("bun", ["-e", script]);
    expect(existsSync(at.where.socket)).toBe(true);
    const { server, error } = await open(at.where.socket, at.steps());
    expect(error?.message ?? "opened").toBe("opened");
    expect(await answers(server, at.where.socket)).toBe(true);
  });

  test("a socket a running hub answers on is not taken over", async () => {
    const at = place();
    expect((await open(at.where.socket, at.steps())).server).toBeDefined();
    const second = await at.steps().prepare(at.where.socket);
    expect(second.isErr() ? second.error.message : "taken").toBe(
      "another hub is running on this socket",
    );
    expect(existsSync(at.where.socket)).toBe(true);
  });

  test("something that is not an AF_UNIX socket at the path is left alone and refused", async () => {
    const at = place();
    writeFileSync(at.where.socket, "not a socket");
    const prepared = await at.steps().prepare(at.where.socket);
    expect(prepared.isErr() ? prepared.error.message : "").toBe(
      "something that is not a socket is at the socket's path",
    );
    expect(existsSync(at.where.socket)).toBe(true);
    setFor(at.fake.entries, at.where.socket, {
      attributes: FILE_ATTRIBUTE_REPARSE_POINT,
      reparseTag: 0xa000000c,
    });
    expect((await at.steps().prepare(at.where.socket)).isErr()).toBe(true);
  });

  test("closing removes the socket file; closing never removes anything else", async () => {
    const at = place();
    const { server } = await open(at.where.socket, at.steps());
    if (server !== undefined) servers.splice(servers.indexOf(server), 1);
    expect((await server?.close())?.isOk()).toBe(true);
    expect(existsSync(at.where.socket)).toBe(false);
    writeFileSync(at.where.socket, "a file");
    expect(at.steps().remove(at.where.socket).isOk()).toBe(true);
    expect(existsSync(at.where.socket)).toBe(true);
    setFor(at.fake.entries, at.where.socket, "error");
    expect(at.steps().remove(at.where.socket).isErr()).toBe(true);
  });
});

describe("each system gets its own steps; macOS and Linux are unchanged", () => {
  test("Windows gets the access-list steps; macOS and Linux keep M1a's", () => {
    expect(socketStepsFor("darwin")).toBe(UNIX_SOCKET_STEPS);
    expect(socketStepsFor("linux")).toBe(UNIX_SOCKET_STEPS);
    expect(socketStepsFor("darwin", () => undefined)).toBe(UNIX_SOCKET_STEPS);
    expect(socketStepsFor("win32")).not.toBe(UNIX_SOCKET_STEPS);
  });

  test.skipIf(process.platform === "win32")(
    "here, an open folder is tightened to 0700 as in M1a, and nothing is warned",
    async () => {
      const where = testFolder();
      folders.push(where);
      mkdirSync(where.folder, { recursive: true, mode: 0o755 });
      chmodSync(where.folder, 0o755);
      const warnings: ControlWarning[] = [];
      const opened = await UnixControlServer.open({
        socketPath: where.socket,
        onWarning: (w) => warnings.push(w),
        logQuery: () => ok([]),
        deviceIdOf: () => undefined,
        writerStatus: () => ({
          lastCommitMs: null,
          stagedItems: 0,
          databaseBytes: null,
          historyShortened: false,
        }),
      });
      expect(opened.isOk()).toBe(true);
      if (opened.isOk()) servers.push(opened.value);
      expect(statSync(where.folder).mode & 0o777).toBe(0o700);
      expect(warnings).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "outside Windows the Windows steps refuse: the Win32 calls cannot load",
    async () => {
      const where = testFolder();
      folders.push(where);
      mkdirSync(where.folder, { recursive: true });
      const prepared = await socketStepsFor("win32", () => undefined).prepare(
        join(where.folder, "control.sock"),
      );
      expect(prepared.isErr() ? prepared.error.message : "").toContain(
        "the hub cannot tell which account it runs as",
      );
    },
  );
});
