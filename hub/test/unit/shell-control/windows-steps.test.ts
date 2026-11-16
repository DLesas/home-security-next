/**
 * The control socket's Windows steps (`shell/control/windows.ts`), on every system: the real
 * server over a real AF_UNIX socket, with the Win32 answers (the account, whether it is elevated,
 * the attributes, the volume, the access lists, setting them) given as data by
 * `windows-data.ts`. What it shows (m2-design.md section 9, "The privilege boundary", "The top
 * folders"): who the hub runs as decides what it may do; as the service it makes what is inside
 * inherit, never changes a top folder, and refuses an open one with `data_folder_open`; by hand
 * an administrator sets the shape on the top folder alone, with `data_folder_was_open`, and
 * touches nothing inside; anyone else is refused; a link in the path is refused and never set;
 * the socket file is read back after listening and a failure there closes the listener; an old
 * socket is replaced and a running hub's kept; macOS and Linux keep their own steps.
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
  DELETE,
  SE_DACL_PRESENT,
  SE_SELF_RELATIVE,
  SERVICE_TOP_RIGHTS,
  SYSTEM_SID,
  topShape,
} from "../../../src/shell/control/windows-acl.ts";
import {
  type ControlWarning,
  DRIVE_NO_ROOT_DIR,
  DRIVE_REMOTE,
  DRIVE_UNKNOWN,
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_REPARSE_POINT,
  IO_REPARSE_TAG_AF_UNIX,
  createTopFolderIfMissing,
  MAX_ENTRIES_CHECKED,
  windowsSocketSteps,
} from "../../../src/shell/control/windows.ts";
import type { WindowsCalls } from "../../../src/shell/safe/control-socket-windows.ts";
import { RawClient, type TestFolder, testFolder } from "./support.ts";
import {
  adminAces,
  contentAces,
  descriptorBytes,
  EVERYONE_SID,
  type FakeWindows,
  fakeWindows,
  FULL,
  INHERITED,
  OI_CI,
  pathKey,
  SERVICE_SID,
  serviceAces,
  setFor,
  shapeAces,
  sidBytes,
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
const SHAPE = topShape(SERVICE_SID)._unsafeUnwrap();

interface Place {
  readonly where: TestFolder;
  readonly fake: FakeWindows;
  readonly calls: WindowsCalls;
  readonly warnings: ControlWarning[];
  readonly steps: (calls?: WindowsCalls) => ReturnType<typeof windowsSocketSteps>;
}

/**
 * A data folder that exists, and fake calls answering for it as a top folder of the shape, for a
 * hub run as the service, or (`asPerson`) by a person, an elevated administrator by default.
 */
function place(asPerson?: { readonly elevated: boolean }): Place {
  const where = testFolder();
  folders.push(where);
  mkdirSync(where.folder, { recursive: true, mode: 0o700 });
  const warnings: ControlWarning[] = [];
  const { fake, calls } = fakeWindows(asPerson === undefined ? SERVICE_SID : USER_SID, SERVICE_SID);
  if (asPerson !== undefined) fake.administrator = asPerson.elevated;
  return {
    where,
    fake,
    calls,
    warnings,
    steps: (with_ = calls) =>
      windowsSocketSteps(with_, {
        service: SERVICE_SID,
        warn: (warning) => warnings.push(warning),
      }),
  };
}

const asAdministrator = () => place({ elevated: true });

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
async function refusal(at: Place, steps = at.steps()): Promise<string> {
  const { error } = await open(at.where.socket, steps);
  expect(existsSync(at.where.socket)).toBe(false);
  return error?.message ?? "opened";
}

async function opens(at: Place): Promise<UnixControlServer | undefined> {
  const { server, error } = await open(at.where.socket, at.steps());
  expect(error?.message ?? "opened").toBe("opened");
  return server;
}

async function answers(server: UnixControlServer | undefined, socket: string): Promise<boolean> {
  const events: unknown[] = [];
  server?.listen((event) => events.push(event));
  const client = new RawClient(socket);
  client.write(STATUS);
  return client.until(() => events.length === 1);
}

const callsTo = (fake: FakeWindows, call: string) =>
  fake.calls.filter((c) => c.startsWith(`${call} `) || c === call);

/** The data folder holds `hub.db` and `backups\keys`. */
function withContents(at: Place): readonly string[] {
  const backups = join(at.where.folder, "backups");
  at.fake.contents.set(pathKey(at.where.folder), ["hub.db", "backups"]);
  at.fake.contents.set(pathKey(backups), ["keys"]);
  setFor(at.fake.attributes, join(at.where.folder, "hub.db"), 0x20);
  setFor(at.fake.attributes, join(backups, "keys"), 0x20);
  return [join(at.where.folder, "hub.db"), backups, join(backups, "keys")];
}

/** Ways a top folder is open: each with what the refusal or the warning names. */
const OPEN_TOPS: readonly [string, Parameters<typeof descriptorBytes>[0], string][] = [
  [
    "Users let in",
    { dacl: [...shapeAces(), { kind: "allow", sid: USERS_SID, flags: OI_CI, mask: 0x1200a9 }] },
    "it lets in Users (S-1-5-32-545) (access 0x001200a9)",
  ],
  [
    "the person's own account let in",
    { dacl: [...shapeAces(), { kind: "allow", sid: USER_SID, flags: OI_CI }] },
    `it lets in ${USER_SID}`,
  ],
  ["inheritance on", { control: SE_SELF_RELATIVE | SE_DACL_PRESENT }, "inheritance is on"],
  [
    "an inherited entry",
    { dacl: [...shapeAces(), { kind: "allow", sid: USERS_SID, flags: INHERITED }] },
    "an entry inherited from above",
  ],
  ["no list at all", { dacl: null }, "no access list at all"],
  ["owned by the service account", { owner: SERVICE_SID }, "which could rewrite the list"],
  ["owned by a person", { owner: USER_SID }, `its owner is ${USER_SID}`],
  [
    "DELETE for the service account",
    {
      dacl: [
        ...adminAces(),
        { kind: "allow", sid: SERVICE_SID, flags: 0, mask: SERVICE_TOP_RIGHTS | DELETE },
        ...serviceAces().slice(1),
      ],
    },
    "holds DELETE",
  ],
];

describe("Windows, who the hub runs as", () => {
  test("the service account is the service: it never asks whether it is elevated", async () => {
    const at = place();
    await opens(at);
    expect(callsTo(at.fake, "isAdministrator")).toEqual([]);
    expect(callsTo(at.fake, "defaultOwnerAdministrators")).toEqual([]);
  });

  test("an elevated administrator, or SYSTEM, is an administrator's run; what it creates is owned by Administrators", async () => {
    const at = asAdministrator();
    await opens(at);
    const owner = at.fake.calls.indexOf("defaultOwnerAdministrators");
    expect(owner).toBeGreaterThan(-1);
    expect(owner).toBeLessThan(at.fake.calls.findIndex((c) => c.startsWith("findEntry")));
    const system = place();
    system.fake.sid = sidBytes(SYSTEM_SID);
    await opens(system);
    expect(callsTo(system.fake, "defaultOwnerAdministrators")).toHaveLength(1);
  });

  test("anyone else is refused, before any folder is looked at", async () => {
    const at = place({ elevated: false });
    expect(await refusal(at)).toBe(
      `the hub runs as ${USER_SID}, which is neither its service account nor an elevated administrator: run it as the service, or by hand from an administrator prompt`,
    );
    expect(callsTo(at.fake, "attributes")).toEqual([]);
  });

  test("an account that cannot be read, whose elevation cannot be told, or who cannot own as Administrators: refused", async () => {
    const unread = place();
    unread.fake.sid = "error";
    expect(await refusal(unread)).toContain("the hub cannot tell which account it runs as");
    const garbled = place();
    garbled.fake.sid = new Uint8Array([2, 0, 0, 0, 0, 0, 0, 5]);
    expect(await refusal(garbled)).toContain("a SID of revision 2");
    const untold = asAdministrator();
    untold.fake.administrator = "error";
    expect(await refusal(untold)).toContain("the hub cannot tell whether it runs elevated");
    const owner = asAdministrator();
    owner.fake.ownerFails = true;
    expect(await refusal(owner)).toContain("the hub cannot make what it creates Administrators'");
  });
});

describe("Windows, as the service: what is inside inherits; the top folder is checked, never changed", () => {
  test("a top folder of the shape: what is inside made to inherit and read back, then the socket opens and answers", async () => {
    const at = place();
    const inside = withContents(at);
    const server = await opens(at);
    expect(await answers(server, at.where.socket)).toBe(true);
    expect(callsTo(at.fake, "inheritFromParent").map((c) => c.slice(18).toLowerCase())).toEqual(
      inside.map(pathKey),
    );
    // ... each made the service's own (a file an administrator put there stays theirs otherwise).
    expect(at.fake.ownersSet).toEqual(inside.map(() => SERVICE_SID));
    const lastInherit = at.fake.calls.findLastIndex((c) => c.startsWith("inheritFromParent"));
    const topRead = at.fake.calls.findIndex(
      (c, i) =>
        i > lastInherit && c.toLowerCase() === `securitydescriptor ${pathKey(at.where.folder)}`,
    );
    const socketLooked = at.fake.calls.findIndex((c) => c === `findEntry ${at.where.socket}`);
    expect(topRead).toBeGreaterThan(lastInherit);
    expect(socketLooked).toBeGreaterThan(topRead);
    expect(callsTo(at.fake, "setTopShape")).toEqual([]);
    expect(at.warnings).toEqual([]);
  });

  test("an old socket file inside is left to be replaced, not made to inherit", async () => {
    const at = place();
    at.fake.contents.set(pathKey(at.where.folder), ["old.sock"]);
    setFor(at.fake.attributes, join(at.where.folder, "old.sock"), FILE_ATTRIBUTE_REPARSE_POINT);
    setFor(at.fake.entries, join(at.where.folder, "old.sock"), {
      attributes: FILE_ATTRIBUTE_REPARSE_POINT,
      reparseTag: IO_REPARSE_TAG_AF_UNIX,
    });
    await opens(at);
    expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
  });

  for (const [what, spec, found] of OPEN_TOPS) {
    test(`${what}: refused with data_folder_open, the top folder not changed, what is inside made to inherit`, async () => {
      const at = place();
      withContents(at);
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes(spec));
      const message = await refusal(at);
      expect(message).toContain(found);
      expect(message).toContain(
        "the service cannot change it: reinstall, or run the installer's repair",
      );
      expect(callsTo(at.fake, "setTopShape")).toEqual([]);
      expect(callsTo(at.fake, "inheritFromParent")).toHaveLength(3);
      expect(at.warnings.map((w) => [w.code, w.detail.closed])).toEqual([
        ["data_folder_open", false],
      ]);
      expect(at.warnings[0]?.message).toContain(
        "reinstall, or run the installer's repair, to close it",
      );
    });
  }

  test("the shape without the service account's entries, which a run by hand accepts, is open to the service", async () => {
    const at = place();
    setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ dacl: adminAces() }));
    expect(await refusal(at)).toContain("has no entry on the folder itself");
    expect(at.warnings[0]?.code).toBe("data_folder_open");
  });

  test("a link inside, at any depth: refused with data_folder_open, nothing made to inherit", async () => {
    for (const depth of [1, 2]) {
      const at = place();
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
      expect(await refusal(at)).toContain("is a link, which the hub does not follow or change");
      expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
      expect(at.warnings[0]?.code).toBe("data_folder_open");
    }
  });

  test("an entry inside that cannot be made to inherit, or reads back open: refused with data_folder_open", async () => {
    const failing = place();
    const inside = withContents(failing);
    failing.fake.inheritFails.add(pathKey(inside[0] ?? ""));
    expect(await refusal(failing)).toContain("the hub could not make");
    expect(failing.warnings[0]?.code).toBe("data_folder_open");
    const open = place();
    const entries = withContents(open);
    const stubborn: WindowsCalls = {
      ...open.calls,
      inheritFromParent: (path, acl, owner) =>
        open.calls.inheritFromParent(path, acl, owner).map(() => {
          if (pathKey(path) === pathKey(entries[2] ?? ""))
            setFor(
              open.fake.descriptors,
              path,
              descriptorBytes({
                owner: SERVICE_SID,
                control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
                dacl: [...contentAces(), { kind: "allow", sid: EVERYONE_SID, mask: FULL }],
              }),
            );
        }),
    };
    expect(await refusal(open, open.steps(stubborn))).toContain(
      "reads back open: it lets in Everyone",
    );
  });

  test(`more than ${MAX_ENTRIES_CHECKED} entries inside, or a folder inside that cannot be listed: refused`, async () => {
    const many = place();
    many.fake.contents.set(
      pathKey(many.where.folder),
      Array.from({ length: MAX_ENTRIES_CHECKED + 1 }, (_, i) => `f${i}`),
    );
    expect(await refusal(many)).toContain(`more than ${MAX_ENTRIES_CHECKED} entries`);
    const unlisted = place();
    const broken: WindowsCalls = {
      ...unlisted.calls,
      list: () => err({ kind: "control", origin: "test", message: "FindFirstFileW failed" }),
    };
    expect(await refusal(unlisted, unlisted.steps(broken))).toContain("the hub cannot list");
  });

  test("another top folder (the program folder) is checked as the data folder is, and named", async () => {
    const at = place();
    const program = join(dirname(at.where.folder), "program");
    mkdirSync(program, { recursive: true });
    setFor(at.fake.descriptors, program, descriptorBytes({ owner: SERVICE_SID }));
    const steps = windowsSocketSteps(at.calls, {
      service: SERVICE_SID,
      warn: (warning) => at.warnings.push(warning),
      otherTopFolders: [program],
    });
    const message = await refusal(at, steps);
    expect(message.toLowerCase()).toContain(pathKey(program));
    expect(String(at.warnings[0]?.detail.folder).toLowerCase()).toBe(pathKey(program));
  });
});

describe("Windows, as an administrator by hand: the top folder's shape set on it alone", () => {
  test("a top folder of the shape, or the shape without the service's entries: opens; nothing inside touched", async () => {
    for (const dacl of [shapeAces(), adminAces()]) {
      const at = asAdministrator();
      withContents(at);
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ dacl }));
      await opens(at);
      expect(callsTo(at.fake, "list")).toEqual([]);
      expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
      expect(callsTo(at.fake, "setTopShape")).toEqual([]);
      expect(at.warnings).toEqual([]);
    }
  });

  for (const [what, spec, found] of OPEN_TOPS) {
    test(`${what}: the shape set on the folder, read back, data_folder_was_open, opens; nothing inside touched`, async () => {
      const at = asAdministrator();
      withContents(at);
      setFor(at.fake.descriptors, at.where.folder, descriptorBytes(spec));
      const server = await opens(at);
      expect(await answers(server, at.where.socket)).toBe(true);
      expect(
        at.fake.shapesSet.map(({ path, descriptor }) => [pathKey(path), [...descriptor]]),
      ).toEqual([[pathKey(at.where.folder), [...SHAPE]]]);
      expect(callsTo(at.fake, "list")).toEqual([]);
      expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
      expect(at.warnings.map((w) => [w.code, w.detail.closed])).toEqual([
        ["data_folder_was_open", true],
      ]);
      expect(at.warnings[0]?.message).toContain(found);
      const set = at.fake.calls.findIndex((c) => c.startsWith("setTopShape"));
      const readBack = at.fake.calls.findIndex(
        (c, i) => i > set && c.toLowerCase() === `securitydescriptor ${pathKey(at.where.folder)}`,
      );
      expect(readBack).toBeGreaterThan(set);
    });
  }

  test("the shape cannot be set, reads back otherwise, or the folder becomes a link meanwhile: refused, warned not closed", async () => {
    const failing = asAdministrator();
    setFor(failing.fake.descriptors, failing.where.folder, descriptorBytes({ owner: USER_SID }));
    failing.fake.setShape = "error";
    expect(await refusal(failing)).toContain("the hub could not set the shape");
    expect(failing.warnings[0]?.detail.closed).toBe(false);
    const ignored = asAdministrator();
    setFor(ignored.fake.descriptors, ignored.where.folder, descriptorBytes({ owner: USER_SID }));
    ignored.fake.setShape = "ignored";
    expect(await refusal(ignored)).toContain("the shape the hub set reads back otherwise");
    const swapped = asAdministrator();
    setFor(swapped.fake.descriptors, swapped.where.folder, descriptorBytes({ owner: USER_SID }));
    const swapping: WindowsCalls = {
      ...swapped.calls,
      setTopShape: (path, descriptor) => {
        setFor(
          swapped.fake.attributes,
          swapped.where.folder,
          FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
        );
        return swapped.calls.setTopShape(path, descriptor);
      },
    };
    expect(await refusal(swapped, swapped.steps(swapping))).toContain("is a link");
    expect(swapped.warnings[0]?.detail.closed).toBe(false);
  });
});

describe("Windows: what the warnings say", () => {
  const denyService = { kind: "deny" as const, sid: SERVICE_SID, mask: DELETE };

  test("a deny entry for the service account, Administrators or SYSTEM is accepted and warned of, as the service and by hand", async () => {
    for (const make of [() => place(), asAdministrator]) {
      const at = make();
      setFor(
        at.fake.descriptors,
        at.where.folder,
        descriptorBytes({
          dacl: [denyService, { kind: "deny", sid: SYSTEM_SID, mask: DELETE }, ...shapeAces()],
        }),
      );
      await opens(at);
      expect(at.warnings.map((w) => w.code)).toEqual(["data_folder_denies"]);
      expect(at.warnings[0]?.message).toContain(
        `the hub's service account (${SERVICE_SID}), SYSTEM (S-1-5-18)`,
      );
      expect(at.warnings[0]?.message).toContain("they may stop the hub, or the uninstaller, later");
    }
  });

  test("a deny entry for anyone else is not warned of", async () => {
    const at = place();
    setFor(
      at.fake.descriptors,
      at.where.folder,
      descriptorBytes({
        dacl: [{ kind: "deny", sid: EVERYONE_SID, flags: OI_CI }, ...shapeAces()],
      }),
    );
    await opens(at);
    expect(at.warnings).toEqual([]);
  });

  test("an open folder with such a deny entry: the service warns of both; by hand the shape set replaces it", async () => {
    const service = place();
    setFor(
      service.fake.descriptors,
      service.where.folder,
      descriptorBytes({ owner: USER_SID, dacl: [denyService, ...shapeAces()] }),
    );
    await refusal(service);
    expect(service.warnings.map((w) => w.code).sort()).toEqual([
      "data_folder_denies",
      "data_folder_open",
    ]);
    const byHand = asAdministrator();
    setFor(
      byHand.fake.descriptors,
      byHand.where.folder,
      descriptorBytes({ owner: USER_SID, dacl: [denyService, ...shapeAces()] }),
    );
    await opens(byHand);
    expect(byHand.warnings.map((w) => w.code)).toEqual(["data_folder_was_open"]);
  });

  test("by hand, the warning names the folder and says what inside is left open, and that hub.db may be readable", async () => {
    const at = asAdministrator();
    setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ owner: USER_SID }));
    await opens(at);
    const message = at.warnings[0]?.message ?? "";
    expect(message.toLowerCase()).toContain(pathKey(at.where.folder));
    expect(message).toContain("the files already in");
    expect(message).toContain("keep their old lists until the hub next starts as its service");
    expect(message).toContain("hub.db may be readable by other accounts");
    expect(at.warnings[0]?.detail.insideUntouched).toBe(true);
  });
});

describe("Windows: a top folder the hub makes itself, by hand, has the shape from its first moment", () => {
  test("missing, by hand: made with the shape, read back; then the socket opens with nothing to warn of", async () => {
    const at = asAdministrator();
    setFor(at.fake.attributes, at.where.folder, undefined);
    expect(createTopFolderIfMissing(at.where.folder, at.calls, SERVICE_SID)._unsafeUnwrap()).toBe(
      "made",
    );
    const made = at.fake.calls.filter((c) => c.startsWith("createFolder"));
    expect(made.map((c) => c.slice(13).toLowerCase())).toEqual([pathKey(at.where.folder)]);
    expect([...(at.fake.descriptors.get(pathKey(at.where.folder)) as Uint8Array)]).toEqual([
      ...SHAPE,
    ]);
    await opens(at);
    expect(callsTo(at.fake, "setTopShape")).toEqual([]);
    expect(at.warnings).toEqual([]);
  });

  test("already there: nothing made, whatever it is; as the service nothing is ever made", () => {
    const there = asAdministrator();
    expect(
      createTopFolderIfMissing(there.where.folder, there.calls, SERVICE_SID)._unsafeUnwrap(),
    ).toBe("there");
    expect(callsTo(there.fake, "createFolder")).toEqual([]);
    const service = place();
    setFor(service.fake.attributes, service.where.folder, undefined);
    expect(
      createTopFolderIfMissing(service.where.folder, service.calls, SERVICE_SID)._unsafeUnwrap(),
    ).toBe("there");
    expect(callsTo(service.fake, "createFolder")).toEqual([]);
  });

  test("refused: a parent missing or a link, a file system without lists, a person not elevated, a failed or wrong make", () => {
    const refuse = (at: Place): string => {
      const made = createTopFolderIfMissing(at.where.folder, at.calls, SERVICE_SID);
      return made.isErr() ? made.error.message : "made";
    };
    const noParent = asAdministrator();
    setFor(noParent.fake.attributes, noParent.where.folder, undefined);
    setFor(noParent.fake.attributes, dirname(noParent.where.folder), undefined);
    expect(refuse(noParent)).toContain("does not exist");
    const link = asAdministrator();
    setFor(link.fake.attributes, link.where.folder, undefined);
    setFor(
      link.fake.attributes,
      dirname(link.where.folder),
      FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
    );
    expect(refuse(link)).toContain("is a link");
    const fat = asAdministrator();
    setFor(fat.fake.attributes, fat.where.folder, undefined);
    fat.fake.volume = { root: "E:\\", flags: 0x3, driveType: 2 };
    expect(refuse(fat)).toContain("keeps no access lists");
    const person = place({ elevated: false });
    setFor(person.fake.attributes, person.where.folder, undefined);
    expect(refuse(person)).toContain("neither its service account nor an elevated administrator");
    const failing = asAdministrator();
    setFor(failing.fake.attributes, failing.where.folder, undefined);
    failing.fake.createFolder = "error";
    expect(refuse(failing)).toContain("the hub cannot make");
    const wrong = asAdministrator();
    setFor(wrong.fake.attributes, wrong.where.folder, undefined);
    wrong.fake.createFolder = "otherwise";
    expect(refuse(wrong)).toContain("was made otherwise");
    for (const at of [noParent, link, fat, person])
      expect(callsTo(at.fake, "createFolder")).toEqual([]);
  });
});

describe("Windows, either way: refused as found, nothing set, nothing warned", () => {
  for (const who of ["the service", "an administrator"] as const) {
    const make = () => (who === "the service" ? place() : asAdministrator());

    async function unchanged(at: Place, expected: string): Promise<void> {
      expect(await refusal(at)).toContain(expected);
      expect(callsTo(at.fake, "setTopShape")).toEqual([]);
      expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
      expect(at.warnings).toEqual([]);
    }

    test(`${who}: a list that cannot be read, or bytes that are not a descriptor`, async () => {
      const unreadable = make();
      setFor(unreadable.fake.descriptors, unreadable.where.folder, "error");
      expect(await refusal(unreadable)).toContain(
        "cannot be read: GetSecurityInfo failed with Windows error 5",
      );
      expect(callsTo(unreadable.fake, "setTopShape")).toEqual([]);
      const garbled = make();
      setFor(garbled.fake.descriptors, garbled.where.folder, new Uint8Array(8));
      expect(await refusal(garbled)).toContain("cannot be read (the descriptor is too short)");
      expect(callsTo(garbled.fake, "setTopShape")).toEqual([]);
    });

    test(`${who}: a missing top folder is refused, not made`, async () => {
      const at = make();
      setFor(at.fake.attributes, at.where.folder, undefined);
      await unchanged(at, "does not exist: the installer makes it, with its access list");
    });

    test(`${who}: a top folder that is not a folder`, async () => {
      const at = make();
      setFor(at.fake.attributes, at.where.folder, 0x20);
      await unchanged(at, "is not a folder");
    });

    test(`${who}: a link as the top folder, or above it, even when it is open: never set, never followed`, async () => {
      const first = make();
      setFor(
        first.fake.attributes,
        first.where.folder,
        FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
      );
      setFor(first.fake.descriptors, first.where.folder, descriptorBytes({ dacl: null }));
      await unchanged(first, "is a link (a reparse point");
      const second = make();
      const above = dirname(dirname(second.where.folder));
      setFor(
        second.fake.attributes,
        above,
        FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT,
      );
      setFor(second.fake.descriptors, second.where.folder, descriptorBytes({ dacl: null }));
      await unchanged(second, `above ${pathKey(second.where.folder).slice(0, 0)}`);
      expect(callsTo(second.fake, "securityDescriptor")).toEqual([]);
      expect(callsTo(second.fake, "list")).toEqual([]);
    });

    test(`${who}: a folder whose attributes cannot be read`, async () => {
      const at = make();
      setFor(at.fake.attributes, dirname(at.where.folder), "error");
      await unchanged(at, "the hub cannot look at");
    });

    test(`${who}: a network drive, or a drive of a kind the hub cannot tell`, async () => {
      for (const driveType of [DRIVE_REMOTE, DRIVE_UNKNOWN, DRIVE_NO_ROOT_DIR]) {
        const at = make();
        at.fake.volume = { root: "Z:\\", flags: 0x8, driveType };
        setFor(at.fake.descriptors, at.where.folder, descriptorBytes({ dacl: null }));
        await unchanged(
          at,
          driveType === DRIVE_REMOTE
            ? "on a network drive (Z:\\)"
            : "of a kind the hub cannot tell",
        );
      }
    });

    test(`${who}: a volume that cannot be read`, async () => {
      const at = make();
      at.fake.volume = "error";
      await unchanged(at, "the hub cannot read the volume of");
    });

    test(`${who}: a file system without access lists is refused, with the warning, nothing set`, async () => {
      const at = make();
      at.fake.volume = { root: "E:\\", flags: 0x3, driveType: 2 };
      expect(await refusal(at)).toContain("keeps no access lists (FAT or exFAT?)");
      expect(callsTo(at.fake, "setTopShape")).toEqual([]);
      expect(callsTo(at.fake, "inheritFromParent")).toEqual([]);
      expect(at.warnings.map((w) => [w.code, w.detail.closed])).toEqual([
        [who === "the service" ? "data_folder_open" : "data_folder_was_open", false],
      ]);
    });
  }

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
        owner: SERVICE_SID,
        control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
        dacl: [...contentAces(), { kind: "allow", sid: EVERYONE_SID }],
      }),
    );
    const { error } = await open(at.where.socket, at.steps());
    expect(error?.message ?? "opened").toContain(
      "the socket file's access list admits more than Administrators, SYSTEM and the hub's service account",
    );
    expect(error?.message).toContain("it lets in Everyone");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("a socket file owned by the person who runs the hub by hand: refused, and closed", async () => {
    const at = asAdministrator();
    setFor(
      at.fake.descriptors,
      at.where.socket,
      descriptorBytes({
        owner: USER_SID,
        control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
        dacl: contentAces(),
      }),
    );
    const { error } = await open(at.where.socket, at.steps());
    expect(error?.message).toContain(`its owner is ${USER_SID}`);
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("no socket file after listening (a path taken as a named pipe): refused, and closed", async () => {
    const at = place();
    let listened = false;
    const steps = at.steps({
      ...at.calls,
      findEntry: (path) => {
        if (!listened && path === at.where.socket) {
          listened = true;
          return at.calls.findEntry(path);
        }
        return path === at.where.socket ? ok(undefined) : at.calls.findEntry(path);
      },
    });
    const { error } = await open(at.where.socket, steps);
    expect(error?.message).toContain("listening left no socket file at the path");
    expect((await hubAnswers(at.where.socket))._unsafeUnwrap()).toBe(false);
  });

  test("something other than an AF_UNIX socket file at the path after listening: refused, and closed", async () => {
    const at = place();
    let looked = 0;
    const steps = at.steps({
      ...at.calls,
      findEntry: (path) =>
        path !== at.where.socket || looked++ === 0
          ? at.calls.findEntry(path)
          : ok({ attributes: 0x20, reparseTag: 0 }),
    });
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
    spawnSync(process.execPath, ["-e", script]);
    expect(existsSync(at.where.socket)).toBe(true);
    expect(await answers(await opens(at), at.where.socket)).toBe(true);
  });

  test("a socket a running hub answers on is not taken over", async () => {
    const at = place();
    await opens(at);
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
    const server = await opens(at);
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
    expect(socketStepsFor("darwin", () => undefined, ["C:\\x"])).toBe(UNIX_SOCKET_STEPS);
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
        otherTopFolders: ["C:\\never\\looked\\at"],
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

  test("the shape the steps set is the shape the rule accepts", () => {
    expect(ADMINISTRATORS_SID).toBe("S-1-5-32-544");
    expect([...SHAPE]).toEqual([...topShape(SERVICE_SID)._unsafeUnwrap()]);
  });
});
