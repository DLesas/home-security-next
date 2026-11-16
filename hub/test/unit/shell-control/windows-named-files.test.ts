/**
 * The decisions behind `hsn.exe`'s Windows rules (`shell/control/windows-named-files.ts`), on
 * every system, with access lists given as data: elevated or not, a path inside a hub tree, and
 * whether the service account may write in a folder or replace what an ancestor holds. Off
 * Windows, the calls of `shell/safe/control-socket-hsn.ts` say they cannot tell and never say yes.
 */
import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import {
  ADMINISTRATORS_SID,
  HUB_SERVICE_SID,
  parseDescriptor,
  SE_DACL_PRESENT,
  SE_SELF_RELATIVE,
  SYSTEM_SID,
} from "../../../src/shell/control/windows-acl.ts";
import {
  decideElevation,
  finalPathKey,
  isUnder,
  outsideHubTrees,
  serviceMayWrite,
  type SidKind,
} from "../../../src/shell/control/windows-named-files.ts";
import {
  beginExport,
  openNamedFileForReading,
  processElevation,
  sidKind,
} from "../../../src/shell/safe/control-socket-hsn.ts";
import {
  type AceSpec,
  descriptorBytes,
  FULL,
  OI_CI,
  INSIDE_ONLY,
  USER_SID,
  USERS_SID,
} from "./windows-data.ts";
import { isWindows } from "./windows-folders.ts";

const failure: HubError = { kind: "control", origin: "test", message: "Windows error 5" };
const AUTHENTICATED_USERS = "S-1-5-11";
const TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
/** Modify (icacls M): read, write, execute and delete, no DELETE_CHILD. */
const MODIFY = 0x001301bf;
const ADD_FILE = 0x2;
const ADD_SUBDIRECTORY = 0x4;
const DELETE_CHILD = 0x40;
const GENERIC_WRITE = 0x4000_0000;
const READ_EXECUTE = 0x001200a9;

/** Windows' answers about accounts: the person's is a user, every other account is not. */
const kinds = (sid: string): SidKind => (sid === USER_SID ? "user" : "other");

function folder(owner: string, aces: readonly AceSpec[], inherited = false) {
  return parseDescriptor(
    descriptorBytes({
      owner,
      dacl: aces,
      ...(inherited ? { control: SE_SELF_RELATIVE | SE_DACL_PRESENT } : {}),
    }),
  )._unsafeUnwrap();
}

/** A person's own folder, as Documents is: the person, Administrators and SYSTEM. */
const DOCUMENTS: readonly AceSpec[] = [
  { kind: "allow", sid: USER_SID, flags: OI_CI, mask: FULL },
  { kind: "allow", sid: ADMINISTRATORS_SID, flags: OI_CI, mask: FULL },
  { kind: "allow", sid: SYSTEM_SID, flags: OI_CI, mask: FULL },
];

describe("elevated or not", () => {
  test("elevated when Administrators is enabled or the token says so; not only when both say no", () => {
    expect(decideElevation(ok(true), ok(false))).toEqual({ kind: "elevated" });
    expect(decideElevation(ok(false), ok(true))).toEqual({ kind: "elevated" });
    expect(decideElevation(ok(true), ok(true))).toEqual({ kind: "elevated" });
    expect(decideElevation(ok(false), ok(false))).toEqual({ kind: "notElevated" });
  });

  test("either fact unreadable: cannot tell, with why", () => {
    expect(decideElevation(err(failure), ok(false))).toEqual({
      kind: "cannotTell",
      error: failure,
    });
    expect(decideElevation(ok(false), err(failure))).toEqual({
      kind: "cannotTell",
      error: failure,
    });
  });
});

describe("inside a hub tree", () => {
  test("a path under a tree, as Windows gives paths back, whatever the case", () => {
    expect(isUnder("\\\\?\\C:\\ProgramData\\HSN Hub\\hub.db", "C:\\ProgramData\\HSN Hub")).toBe(
      true,
    );
    expect(isUnder("\\\\?\\c:\\programdata\\hsn hub", "\\\\?\\C:\\ProgramData\\HSN Hub\\")).toBe(
      true,
    );
    expect(isUnder("\\\\?\\UNC\\server\\share\\x", "\\\\server\\share")).toBe(true);
  });

  test("a sibling whose name begins the same is not under it", () => {
    expect(isUnder("C:\\ProgramData\\HSN Hub Program\\staged", "C:\\ProgramData\\HSN Hub")).toBe(
      false,
    );
    expect(isUnder("C:\\ProgramData\\HSN Hubx", "C:\\ProgramData\\HSN Hub")).toBe(false);
    expect(finalPathKey("\\\\?\\C:\\A\\B\\")).toBe("c:\\a\\b");
  });

  test("the first tree it lies in is named in the refusal", () => {
    const refused = outsideHubTrees("\\\\?\\C:\\ProgramData\\HSN Hub Program\\x", [
      "C:\\ProgramData\\HSN Hub",
      "C:\\ProgramData\\HSN Hub Program",
    ]);
    expect(refused.isErr() ? refused.error.kind : "outside").toBe("insideHubTree");
    expect(refused.isErr() ? refused.error.message : "").toContain(
      "c:\\programdata\\hsn hub program",
    );
    expect(
      outsideHubTrees("C:\\Users\\me\\Documents\\x", ["C:\\ProgramData\\HSN Hub"]).isOk(),
    ).toBe(true);
  });
});

describe("can the service account write here (cannot tell means it can)", () => {
  test("a person's own folder, as Documents is: it cannot", () => {
    expect(serviceMayWrite(folder(USER_SID, DOCUMENTS), kinds, "folder")).toEqual([]);
    expect(serviceMayWrite(folder(SYSTEM_SID, DOCUMENTS), kinds, "ancestor")).toEqual([]);
  });

  test("a group that may write, the service's own account, or one Windows will not name: it can", () => {
    for (const [sid, mask] of [
      [AUTHENTICATED_USERS, MODIFY],
      [USERS_SID, ADD_FILE],
      [USERS_SID, ADD_SUBDIRECTORY],
      ["S-1-1-0", GENERIC_WRITE],
      [HUB_SERVICE_SID, ADD_FILE],
      ["S-1-5-21-1-2-3-1500", ADD_FILE],
    ] as const) {
      const reasons = serviceMayWrite(
        folder(USER_SID, [...DOCUMENTS, { kind: "allow", sid, flags: OI_CI, mask }]),
        kinds,
        "folder",
      );
      expect(reasons.join("; ")).toContain("may write in it, and the service account may hold it");
    }
  });

  test("rights that only read, or an entry only passed on to what is inside, do not count on the folder", () => {
    expect(
      serviceMayWrite(
        folder(USER_SID, [
          ...DOCUMENTS,
          { kind: "allow", sid: USERS_SID, flags: OI_CI, mask: READ_EXECUTE },
        ]),
        kinds,
        "folder",
      ),
    ).toEqual([]);
    expect(
      serviceMayWrite(
        folder(USER_SID, [
          ...DOCUMENTS,
          { kind: "allow", sid: AUTHENTICATED_USERS, flags: INSIDE_ONLY, mask: MODIFY },
        ]),
        kinds,
        "folder",
      ),
    ).toEqual([]);
  });

  test("Administrators, SYSTEM, LOCAL SERVICE, NETWORK SERVICE and TrustedInstaller are never held", () => {
    for (const sid of [ADMINISTRATORS_SID, SYSTEM_SID, "S-1-5-19", "S-1-5-20", TRUSTED_INSTALLER])
      expect(
        serviceMayWrite(
          folder(sid, [{ kind: "allow", sid, flags: OI_CI, mask: FULL }]),
          kinds,
          "folder",
        ),
      ).toEqual([]);
  });

  test("an owner the service may hold can rewrite the list: it can", () => {
    expect(serviceMayWrite(folder(USERS_SID, DOCUMENTS), kinds, "folder").join()).toContain(
      "its owner",
    );
    expect(serviceMayWrite(folder(HUB_SERVICE_SID, DOCUMENTS), kinds, "folder").join()).toContain(
      "its owner",
    );
    expect(serviceMayWrite(folder(USERS_SID, DOCUMENTS), kinds, "ancestor").join()).toContain(
      "its owner",
    );
  });

  test("a deny entry does not take the right away here: it is not counted", () => {
    const reasons = serviceMayWrite(
      folder(USER_SID, [
        { kind: "deny", sid: USERS_SID, flags: OI_CI, mask: FULL },
        ...DOCUMENTS,
        { kind: "allow", sid: USERS_SID, flags: OI_CI, mask: ADD_FILE },
      ]),
      kinds,
      "folder",
    );
    expect(reasons.length).toBe(1);
  });

  test("no list, no owner, a list that cannot be read, an entry of a kind not read: it can", () => {
    expect(serviceMayWrite(folder(USER_SID, []), kinds, "folder")).toEqual([]);
    expect(
      serviceMayWrite(
        parseDescriptor(descriptorBytes({ owner: USER_SID, dacl: null }))._unsafeUnwrap(),
        kinds,
        "folder",
      ).join(),
    ).toContain("no access list");
    expect(
      serviceMayWrite(
        parseDescriptor(descriptorBytes({ owner: null, dacl: DOCUMENTS }))._unsafeUnwrap(),
        kinds,
        "folder",
      ).join(),
    ).toContain("no owner");
    expect(serviceMayWrite(undefined, kinds, "folder").join()).toContain("cannot be read");
    expect(
      serviceMayWrite(
        folder(USER_SID, [...DOCUMENTS, { kind: 0x09, sid: USERS_SID }]),
        kinds,
        "folder",
      ).join(),
    ).toContain("a kind hsn does not read");
  });

  test("an ancestor counts with the rights that rename or replace what it holds, not with adding", () => {
    const withRight = (mask: number) =>
      serviceMayWrite(
        folder(SYSTEM_SID, [
          ...DOCUMENTS,
          { kind: "allow", sid: AUTHENTICATED_USERS, flags: 0, mask },
        ]),
        kinds,
        "ancestor",
      );
    expect(withRight(ADD_FILE | ADD_SUBDIRECTORY)).toEqual([]);
    expect(withRight(DELETE_CHILD).join()).toContain("may rename or replace what it holds");
    expect(withRight(GENERIC_WRITE).join()).toContain("may rename or replace what it holds");
    expect(withRight(0x0004_0000).join()).toContain("may rename or replace");
  });
});

describe.skipIf(isWindows)("off Windows, hsn.exe's calls never say yes", () => {
  test("elevation cannot be told; files cannot be opened or exported; no account is a user", () => {
    expect(processElevation().kind).toBe("cannotTell");
    const read = openNamedFileForReading("C:\\x\\file", []);
    expect(read.isErr() ? read.error.kind : "opened").toBe("failed");
    const written = beginExport("C:\\x\\file", []);
    expect(written.isErr() ? written.error.kind : "began").toBe("failed");
    expect(sidKind(USER_SID)).toBe("other");
  });
});
