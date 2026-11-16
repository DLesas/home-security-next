/**
 * `hsn` run as root (m2-design.md section 9, "The privilege boundary"): the fixed folders are the
 * service's and the packages', `SUDO_*` is believed only as root, the environment is ignored, and
 * a drop's ids are checked whole. The drop itself needs root: `hub/test/root/`.
 */
import { describe, expect, test } from "bun:test";
import {
  elevatedEnv,
  FIXED_DATA_FOLDERS,
  FIXED_PROGRAM_TREES,
  HUB_ACCOUNTS,
  idsProblem,
  invokingUser,
} from "../../../cli/elevated.ts";
import { dataFolder } from "../../../cli/paths.ts";
import { INSTALL } from "../../../packaging/shared/layout.ts";
import { SERVICE } from "../../../src/shell/m2-values.ts";

const SUDO = { SUDO_UID: "501", SUDO_GID: "20", SUDO_USER: "anna" };

describe("hsn as root (section 9)", () => {
  test("the fixed folders and accounts are the service's and the packages'", () => {
    expect<string>(FIXED_DATA_FOLDERS.darwin).toBe(INSTALL.macos.dataFolder);
    expect<string>(FIXED_DATA_FOLDERS.linux).toBe(INSTALL.linux.dataFolder);
    expect<string>(FIXED_PROGRAM_TREES.darwin).toBe(INSTALL.macos.programTree);
    expect<string>(FIXED_PROGRAM_TREES.linux).toBe(INSTALL.linux.programTree);
    expect<string>(HUB_ACCOUNTS.darwin).toBe(SERVICE.macos.user);
    expect<string>(HUB_ACCOUNTS.linux).toBe(SERVICE.linux.user);
  });

  test("SUDO_UID is believed only as root, and never names root", () => {
    expect(invokingUser(0, SUDO)).toEqual({ name: "anna", uid: 501, gid: 20 });
    expect(invokingUser(501, SUDO)).toBeUndefined();
    expect(invokingUser(0, {})).toBeUndefined();
    expect(invokingUser(0, { ...SUDO, SUDO_UID: "0" })).toBeUndefined();
    expect(invokingUser(0, { ...SUDO, SUDO_UID: "" })).toBeUndefined();
  });

  test("the environment is ignored: only the fixed data folder and the actor's name remain", () => {
    const hostile = {
      ...SUDO,
      HSN_DATA_DIR: "/tmp/planted",
      HOME: "/tmp/home",
      BUN_OPTIONS: "--preload=/tmp/evil.ts",
    };
    expect(elevatedEnv("linux", hostile)).toEqual({
      HSN_DATA_DIR: "/var/lib/hsn-hub",
      USER: "anna",
    });
    expect(elevatedEnv("darwin", { USER: "root" })).toEqual({
      HSN_DATA_DIR: "/Library/Application Support/HSN Hub",
      USER: "root",
    });
  });

  test("as root: an explicit --data is honoured (D124), HSN_DATA_DIR is not, else the fixed folder", () => {
    const env = elevatedEnv("linux", { ...SUDO, HSN_DATA_DIR: "/tmp/planted" });
    expect(dataFolder(undefined, env)).toBe("/var/lib/hsn-hub");
    expect(dataFolder("/tmp/hsn-tests", env)).toBe("/tmp/hsn-tests");
  });

  test("after a drop every id must be the account's, and root's group gone", () => {
    const hub = { name: "hsn", uid: 990, gid: 990 };
    const all = {
      ruid: 990,
      euid: 990,
      suid: 990,
      rgid: 990,
      egid: 990,
      sgid: 990,
      groups: [990, 20],
    };
    expect(idsProblem(all, hub)).toBeUndefined();
    expect(idsProblem({ ...all, suid: 0 }, hub)).toContain("user ids");
    expect(idsProblem({ ...all, sgid: 0 }, hub)).toContain("group ids");
    expect(idsProblem({ ...all, groups: [990, 0] }, hub)).toContain("root's group");
  });
});
