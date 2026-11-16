/**
 * `hsn` run elevated (m2-design.md section 9, "The privilege boundary"), on macOS and Linux:
 *
 * - **Fixed paths and an ignored environment.** As root, `hsn` follows neither `HSN_DATA_DIR`
 *   nor `HOME` nor the working folder: the data folder is the system's (`FIXED_DATA_FOLDERS`, the
 *   service's), and the working folder `/`. Only `SUDO_UID`, `SUDO_GID` and `SUDO_USER` are read,
 *   and only because the process is root and `sudo` set them; the person's name (`SUDO_USER`,
 *   else `USER`) stays the actor's text, a label only.
 * - **The drop.** For everything that talks to the hub, `hsn` becomes the hub's account: groups,
 *   then group, then user (`process.initgroups`, `setgid`, `setuid`, present in Bun 1.4.2 and in
 *   its compiled executables), then proves it: real, effective and saved user and group ids all
 *   the hub's (Linux `/proc/self/status`; macOS `ps -o ruid,uid,svuid,rgid,gid,svgid`), the
 *   groups the account's, and `setuid(0)` refused. The root-only test is `hub/test/root/`.
 *   **Unproved until the hosted job has run that test as root**; if it fails there, the drop
 *   becomes the re-run through the system's tool (`setpriv`, `sudo -u`) the design gives.
 *
 * Windows (an elevated administrator, who cannot become a virtual account) checks its peer
 * instead (A11's); nothing here runs there.
 */
import { readFileSync } from "node:fs";
import { err, ok, Result } from "neverthrow";

/** The service's data folders (`hub/src/shell/m2-values.ts`'s `SERVICE`, checked by a test). */
export const FIXED_DATA_FOLDERS = {
  darwin: "/Library/Application Support/HSN Hub",
  linux: "/var/lib/hsn-hub",
} as const;

/** The hub's program trees, siblings of the data folders (`hub/packaging/shared/layout.ts`). */
export const FIXED_PROGRAM_TREES = {
  darwin: "/Library/Application Support/HSN Hub Program",
  linux: "/var/lib/hsn-hub-program",
} as const;

/** The hub's account on each system (`SERVICE`, checked by a test). */
export const HUB_ACCOUNTS = { darwin: "_hsnhub", linux: "hsn" } as const;

export type UnixPlatform = keyof typeof FIXED_DATA_FOLDERS;

export function unixPlatform(platform: NodeJS.Platform): UnixPlatform | undefined {
  return platform === "darwin" || platform === "linux" ? platform : undefined;
}

/** Whether this process is root (macOS and Linux); never on Windows. */
export function isRoot(euid: number | undefined): boolean {
  return euid === 0;
}

/** An account by its ids, and its name for its groups. */
export interface Account {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
}

/**
 * The person who ran `sudo hsn`: `SUDO_UID`, `SUDO_GID`, `SUDO_USER`, believed only because the
 * process is root. Undefined when not root, or when root without `sudo` (the person is root).
 */
export function invokingUser(
  euid: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Account | undefined {
  if (!isRoot(euid)) return undefined;
  const uid = Number(env.SUDO_UID ?? "");
  const gid = Number(env.SUDO_GID ?? "");
  const name = env.SUDO_USER ?? "";
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || name === "" || env.SUDO_UID === "")
    return undefined;
  if (uid === 0) return undefined;
  return { name, uid, gid };
}

/**
 * The environment `hsn` uses as root: the fixed data folder and the actor's name, nothing else
 * (no `HSN_DATA_DIR`, `HOME` or anything a `.env` could have set; the executable loads none).
 */
export function elevatedEnv(
  platform: UnixPlatform,
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const actor = env.SUDO_USER ?? env.USER ?? "root";
  return { HSN_DATA_DIR: FIXED_DATA_FOLDERS[platform], USER: actor };
}

/** An account's ids from the system's root-owned `id` tool. */
export function lookupAccount(name: string): Result<Account, string> {
  const id = (flag: string): Result<number, string> => {
    const ran = Bun.spawnSync(["/usr/bin/id", flag, name], { env: {}, cwd: "/" });
    const value = Number(ran.stdout.toString().trim());
    return ran.exitCode === 0 && Number.isInteger(value)
      ? ok(value)
      : err(`no account ${name} on this computer`);
  };
  return id("-u").andThen((uid) => id("-g").map((gid) => ({ name, uid, gid })));
}

/** The process's real, effective and saved ids and its groups, as the system reports them. */
export interface Ids {
  readonly ruid: number;
  readonly euid: number;
  readonly suid: number;
  readonly rgid: number;
  readonly egid: number;
  readonly sgid: number;
  readonly groups: readonly number[];
}

const numbers = (text: string): readonly number[] =>
  text
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "")
    .map(Number);

/** The ids now, from the kernel's own account of this process. */
export function currentIds(platform: UnixPlatform): Result<Ids, string> {
  const groups = Result.fromThrowable(
    () => process.getgroups?.() ?? [],
    () => "cannot read the groups",
  )();
  if (groups.isErr()) return err(groups.error);
  if (platform === "linux") {
    return Result.fromThrowable(
      () => readFileSync("/proc/self/status", "utf8"),
      () => "cannot read /proc/self/status",
    )().andThen((status) => {
      const field = (name: string) =>
        numbers(new RegExp(`^${name}:(.*)$`, "mu").exec(status)?.[1] ?? "");
      const [ruid, euid, suid] = field("Uid");
      const [rgid, egid, sgid] = field("Gid");
      if ([ruid, euid, suid, rgid, egid, sgid].some((n) => n === undefined))
        return err("cannot read the ids from /proc/self/status");
      return ok({
        ruid: ruid ?? -1,
        euid: euid ?? -1,
        suid: suid ?? -1,
        rgid: rgid ?? -1,
        egid: egid ?? -1,
        sgid: sgid ?? -1,
        groups: field("Groups"),
      });
    });
  }
  const ran = Bun.spawnSync(
    ["/bin/ps", "-o", "ruid=,uid=,svuid=,rgid=,gid=,svgid=", "-p", String(process.pid)],
    { env: {}, cwd: "/" },
  );
  const [ruid, euid, suid, rgid, egid, sgid] = numbers(ran.stdout.toString());
  if (ran.exitCode !== 0 || sgid === undefined) return err("cannot read the ids from ps");
  return ok({
    ruid: ruid ?? -1,
    euid: euid ?? -1,
    suid: suid ?? -1,
    rgid: rgid ?? -1,
    egid: egid ?? -1,
    sgid,
    groups: groups.value,
  });
}

/** Why the ids are not all `account`'s, or undefined when they are. */
export function idsProblem(ids: Ids, account: Account): string | undefined {
  const users = [ids.ruid, ids.euid, ids.suid];
  const groups = [ids.rgid, ids.egid, ids.sgid];
  if (users.some((id) => id !== account.uid))
    return `user ids ${users.join(", ")}, not ${account.uid}`;
  if (groups.some((id) => id !== account.gid))
    return `group ids ${groups.join(", ")}, not ${account.gid}`;
  if (ids.groups.includes(0) && account.gid !== 0) return "still in root's group";
  return undefined;
}

/**
 * Becomes `account` for good: groups, then group, then user; then checks every id and that root
 * cannot be taken back. An error leaves `hsn` to stop, never to go on as root.
 */
export function dropTo(account: Account, platform: UnixPlatform): Result<Ids, string> {
  const dropped = Result.fromThrowable(
    () => {
      // Bun has `initgroups` (Node's), which its type declarations leave out.
      (process as { initgroups?: (user: string, group: number) => void }).initgroups?.(
        account.name,
        account.gid,
      );
      process.setgid?.(account.gid);
      process.setuid?.(account.uid);
    },
    (thrown) =>
      `cannot become ${account.name}: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
  )();
  if (dropped.isErr()) return err(dropped.error);
  const regained = Result.fromThrowable(
    () => {
      process.setuid?.(0);
    },
    () => "refused",
  )();
  if (regained.isOk()) return err(`after becoming ${account.name}, root could be taken back`);
  return currentIds(platform).andThen((ids) => {
    const problem = idsProblem(ids, account);
    return problem === undefined ? ok(ids) : err(`after the drop: ${problem}`);
  });
}
