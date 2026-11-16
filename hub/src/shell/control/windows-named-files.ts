/**
 * The decisions behind `hsn.exe`'s Windows rules (m2-design.md section 9, "The privilege
 * boundary", the row for an elevated `hsn.exe` and "Files a person names to `hsn`"): pure, so
 * they are tested on every system; the Win32 calls that feed them are
 * `shell/safe/control-socket-hsn.ts`.
 *
 * - **Elevated or not** (`decideElevation`): elevated when the token holds Administrators enabled
 *   (not deny-only, as a normal prompt's filtered token holds it) or says it is elevated; not
 *   elevated only when both say no; "cannot tell" when either cannot be read, which the caller
 *   treats as elevated (the stricter rules).
 * - **Inside a hub tree** (`isUnder`): a path compared, after Windows resolved it by its handle,
 *   with each hub tree resolved the same way, so a junction on the way into a tree is seen.
 * - **Can the service account write here?** (`serviceMayWrite`; told with an export, not refused,
 *   since D124): from a folder's owner and list,
 *   answered conservatively: yes unless every account that may write, or rewrite the list, is one
 *   the service's token cannot hold. Only these cannot be held: Administrators, SYSTEM, LOCAL
 *   SERVICE, NETWORK SERVICE, TrustedInstaller, and an account Windows names a user (a user's SID
 *   is in no other account's token). Every group but those, and every account Windows will not
 *   name, may be held. Deny entries are not counted (they could only take a right away, and their
 *   order would have to be judged); a list that cannot be read, or no list, means yes. An ancestor
 *   counts too, with the rights that let its holder rename or replace what it holds.
 */
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import {
  ADMINISTRATORS_SID,
  DELETE,
  type Descriptor,
  FILE_ADD_FILE,
  FILE_ADD_SUBDIRECTORY,
  INHERIT_ONLY_ACE,
  nameOf,
  SYSTEM_SID,
  WRITE_DAC,
  WRITE_OWNER,
} from "./windows-acl.ts";

/** Whether `hsn.exe` runs with an elevated administrator's token. */
export type Elevation =
  | { readonly kind: "elevated" }
  | { readonly kind: "notElevated" }
  /** The caller treats this as elevated. */
  | { readonly kind: "cannotTell"; readonly error: HubError };

/** From the token: Administrators enabled (`CheckTokenMembership`) and `TokenIsElevated`. */
export function decideElevation(
  administratorsEnabled: Result<boolean, HubError>,
  tokenElevated: Result<boolean, HubError>,
): Elevation {
  if (administratorsEnabled.isErr())
    return { kind: "cannotTell", error: administratorsEnabled.error };
  if (tokenElevated.isErr()) return { kind: "cannotTell", error: tokenElevated.error };
  return administratorsEnabled.value || tokenElevated.value
    ? { kind: "elevated" }
    : { kind: "notElevated" };
}

/** A path as Windows gives it back (`\\?\C:\…`, `\\?\UNC\…`), compared without case. */
export function finalPathKey(path: string): string {
  const plain = path.startsWith("\\\\?\\UNC\\")
    ? `\\\\${path.slice(8)}`
    : path.startsWith("\\\\?\\")
      ? path.slice(4)
      : path;
  return plain.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
}

/** Whether `path` is `tree` or inside it, both as Windows resolved them. */
export function isUnder(path: string, tree: string): boolean {
  const p = finalPathKey(path);
  const t = finalPathKey(tree);
  return p === t || p.startsWith(`${t}\\`);
}

/** What Windows says an account is: a user's account, or anything else (a group, unknown). */
export type SidKind = "user" | "other";

const LOCAL_SERVICE_SID = "S-1-5-19";
const NETWORK_SERVICE_SID = "S-1-5-20";
const TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
const NEVER_HELD: ReadonlySet<string> = new Set([
  ADMINISTRATORS_SID,
  SYSTEM_SID,
  LOCAL_SERVICE_SID,
  NETWORK_SERVICE_SID,
  TRUSTED_INSTALLER_SID,
]);

const FILE_WRITE_EA = 0x0010;
const FILE_DELETE_CHILD = 0x0040;
const FILE_WRITE_ATTRIBUTES = 0x0100;
const MAXIMUM_ALLOWED = 0x0200_0000;
const GENERIC_ALL = 0x1000_0000;
const GENERIC_WRITE = 0x4000_0000;
/** Rights on a folder that let their holder put something in it, or change or replace it. */
export const WRITES_INTO =
  FILE_ADD_FILE |
  FILE_ADD_SUBDIRECTORY |
  FILE_WRITE_EA |
  FILE_DELETE_CHILD |
  FILE_WRITE_ATTRIBUTES |
  DELETE |
  WRITE_DAC |
  WRITE_OWNER |
  MAXIMUM_ALLOWED |
  GENERIC_ALL |
  GENERIC_WRITE;
/** Rights on an ancestor that let their holder rename or replace what is inside it. */
export const REPLACES_INSIDE =
  FILE_DELETE_CHILD | WRITE_DAC | WRITE_OWNER | MAXIMUM_ALLOWED | GENERIC_ALL | GENERIC_WRITE;

/**
 * Why the service account may write in a folder (`role` "folder") or replace what an ancestor
 * holds (`role` "ancestor"); none when it cannot. `kindOf` is what Windows says each account is.
 */
export function serviceMayWrite(
  descriptor: Descriptor | undefined,
  kindOf: (sid: string) => SidKind,
  role: "folder" | "ancestor",
): readonly string[] {
  if (descriptor === undefined) return ["its access list cannot be read"];
  const held = (sid: string): boolean => !NEVER_HELD.has(sid) && kindOf(sid) !== "user";
  const reasons: string[] = [];
  if (descriptor.owner === undefined) reasons.push("it has no owner");
  else if (held(descriptor.owner))
    reasons.push(`its owner, ${nameOf(descriptor.owner)}, may be held by the service account`);
  if (descriptor.dacl === null) {
    reasons.push("it has no access list at all");
    return reasons;
  }
  const rights = role === "folder" ? WRITES_INTO : REPLACES_INSIDE;
  for (const ace of descriptor.dacl) {
    if (ace.kind === "other" || ace.sid === undefined) {
      reasons.push(`it has an entry of a kind hsn does not read (type ${ace.type})`);
      continue;
    }
    if (ace.kind !== "allow" || (ace.flags & INHERIT_ONLY_ACE) !== 0) continue;
    if ((ace.mask & rights) !== 0 && held(ace.sid))
      reasons.push(
        `${nameOf(ace.sid)} may ${role === "folder" ? "write in it" : "rename or replace what it holds"}, and the service account may hold it`,
      );
  }
  return reasons;
}

/** The refusals of a file a person names to `hsn.exe`. */
export type NamedFileRefusal =
  /** The path's last part is a reparse point (a link, a junction, a mount point). */
  | { readonly kind: "reparsePoint"; readonly message: string }
  /** It lies inside one of the hub's trees. */
  | { readonly kind: "insideHubTree"; readonly message: string }
  /** Not a plain file (a folder, a device). */
  | { readonly kind: "notAFile"; readonly message: string }
  /** Windows would not do it, or would not say. */
  | { readonly kind: "failed"; readonly message: string };

/** The first hub tree `finalPath` lies in, as a refusal; none when it lies in none. */
export function outsideHubTrees(
  finalPath: string,
  trees: readonly string[],
): Result<void, NamedFileRefusal> {
  const tree = trees.find((t) => isUnder(finalPath, t));
  return tree === undefined
    ? ok(undefined)
    : err({
        kind: "insideHubTree",
        message: `${finalPathKey(finalPath)} is inside the hub's folder ${finalPathKey(tree)}: hsn reads and writes no file there`,
      });
}
