/**
 * Access lists as data, for the Windows rule's tests on every system: self-relative security
 * descriptors built from a description (as `GetSecurityInfo` returns them), and fake Win32 calls
 * that answer from a table, so the Windows steps run over a real AF_UNIX socket on macOS and
 * Linux with only the access lists made up.
 */
import { existsSync, lstatSync } from "node:fs";
import { win32 } from "node:path";
import { err, ok } from "neverthrow";
import type { HubError } from "../../../src/core/model/errors.ts";
import {
  ACCESS_ALLOWED_ACE_TYPE,
  ACCESS_DENIED_ACE_TYPE,
  ADMINISTRATORS_SID,
  CONTAINER_INHERIT_ACE,
  INHERITED_ACE,
  OBJECT_INHERIT_ACE,
  SE_DACL_PRESENT,
  SE_DACL_PROTECTED,
  parseDescriptor,
  SE_SELF_RELATIVE,
  SYSTEM_SID,
} from "../../../src/shell/control/windows-acl.ts";
import {
  FILE_ATTRIBUTE_DIRECTORY,
  FILE_ATTRIBUTE_REPARSE_POINT,
  FILE_PERSISTENT_ACLS,
  IO_REPARSE_TAG_AF_UNIX,
} from "../../../src/shell/control/windows.ts";
import {
  type FoundEntry,
  type Volume,
  WINDOWS_CALLS,
  type WindowsCalls,
} from "../../../src/shell/safe/control-socket-windows.ts";

export const HUB_SID = "S-1-5-80-1234567890-1111111111-2222222222-3333333333-4044444444";
export const USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
export const USERS_SID = "S-1-5-32-545";
export const EVERYONE_SID = "S-1-1-0";
export const CREATOR_OWNER_SID = "S-1-3-0";
/** FILE_ALL_ACCESS, and READ_CONTROL alone. */
export const FULL = 0x001f_01ff;
export const READ_CONTROL = 0x0002_0000;
export const OI_CI = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
export const INHERITED = INHERITED_ACE;

/** A SID's bytes from its text. */
export function sidBytes(sid: string): Uint8Array {
  const [, revision, authority, ...subs] = sid.split("-");
  const bytes = new Uint8Array(8 + 4 * subs.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = Number(revision);
  bytes[1] = subs.length;
  let value = Number(authority);
  for (let i = 5; i >= 0; i--) {
    bytes[2 + i] = value % 256;
    value = Math.floor(value / 256);
  }
  subs.forEach((sub, i) => {
    view.setUint32(8 + 4 * i, Number(sub), true);
  });
  return bytes;
}

export interface AceSpec {
  /** "allow", "deny", or another ACE type by number (its body is a mask and a SID). */
  readonly kind: "allow" | "deny" | number;
  readonly sid: string;
  readonly flags?: number;
  readonly mask?: number;
}

export interface DescriptorSpec {
  /** Undefined: SYSTEM. Null: none. */
  readonly owner?: string | null;
  /** Undefined: protected, the hub, Administrators and SYSTEM. Null: no list at all. */
  readonly dacl?: readonly AceSpec[] | null;
  /** Undefined: protected, present and self-relative, as a locked folder's. */
  readonly control?: number;
}

/** The list of a folder locked as the installer locks it: the hub, Administrators, SYSTEM. */
export function lockedAces(hub: string = HUB_SID): readonly AceSpec[] {
  return [
    { kind: "allow", sid: hub, flags: OI_CI, mask: FULL },
    { kind: "allow", sid: ADMINISTRATORS_SID, flags: OI_CI, mask: FULL },
    { kind: "allow", sid: SYSTEM_SID, flags: OI_CI, mask: FULL },
  ];
}

/** The socket file's list, inherited from a locked folder. */
export function socketAces(hub: string = HUB_SID): readonly AceSpec[] {
  return lockedAces(hub).map((ace) => ({ ...ace, flags: INHERITED_ACE }));
}

function aceBytes(ace: AceSpec): Uint8Array {
  const sid = sidBytes(ace.sid);
  const bytes = new Uint8Array(8 + sid.length);
  const view = new DataView(bytes.buffer);
  bytes[0] =
    ace.kind === "allow"
      ? ACCESS_ALLOWED_ACE_TYPE
      : ace.kind === "deny"
        ? ACCESS_DENIED_ACE_TYPE
        : ace.kind;
  bytes[1] = ace.flags ?? 0;
  view.setUint16(2, bytes.length, true);
  view.setUint32(4, ace.mask ?? FULL, true);
  bytes.set(sid, 8);
  return bytes;
}

/** A self-relative security descriptor: header, owner, then the list. */
export function descriptorBytes(spec: DescriptorSpec = {}): Uint8Array {
  const owner = spec.owner === null ? undefined : sidBytes(spec.owner ?? SYSTEM_SID);
  const dacl = spec.dacl === undefined ? lockedAces() : spec.dacl;
  const aces = (dacl ?? []).map(aceBytes);
  const aclSize = 8 + aces.reduce((sum, a) => sum + a.length, 0);
  const ownerAt = owner === undefined ? 0 : 20;
  const daclAt = dacl === null ? 0 : 20 + (owner?.length ?? 0);
  const bytes = new Uint8Array(20 + (owner?.length ?? 0) + (dacl === null ? 0 : aclSize));
  const view = new DataView(bytes.buffer);
  const control =
    spec.control ?? SE_SELF_RELATIVE | SE_DACL_PROTECTED | (dacl === null ? 0 : SE_DACL_PRESENT);
  bytes[0] = 1;
  view.setUint16(2, control, true);
  view.setUint32(4, ownerAt, true);
  view.setUint32(16, daclAt, true);
  if (owner !== undefined) bytes.set(owner, ownerAt);
  if (dacl !== null) {
    bytes[daclAt] = 2;
    view.setUint16(daclAt + 2, aclSize, true);
    view.setUint16(daclAt + 4, aces.length, true);
    let at = daclAt + 8;
    for (const ace of aces) {
      bytes.set(ace, at);
      at += ace.length;
    }
  }
  return bytes;
}

const failure = (message: string): HubError => ({
  kind: "control",
  origin: "test/windows-data",
  message,
});

type Answer<T> = T | "error";

/** What the fake calls answer, by path (compared as Windows paths); anything unset is ordinary. */
export interface FakeWindows {
  sid: Answer<Uint8Array>;
  /** The folder's and each folder above's attributes; unset: a plain folder. */
  readonly attributes: Map<string, Answer<number | undefined>>;
  /** Descriptors by path; unset: a locked folder's, or a socket's inherited one. */
  readonly descriptors: Map<string, Answer<Uint8Array>>;
  /** `FindFirstFileW` by path; unset: what is really there (a socket shows as AF_UNIX). */
  readonly entries: Map<string, Answer<FoundEntry | undefined>>;
  volume: Answer<Volume>;
  /** The names in each folder; unset: none. */
  readonly contents: Map<string, readonly string[]>;
  /** What setting a list does: it takes, it fails, or it seems to work and changes nothing. */
  setList: "takes" | "error" | "ignored";
  /** Every list set, with its path. */
  readonly listsSet: { readonly path: string; readonly acl: Uint8Array }[];
  /** Every call made, in order: `<call> <path>`. */
  readonly calls: string[];
}

/** A self-relative descriptor of `owner` and an `ACL`'s bytes, protected. */
export function descriptorWithAcl(owner: string, acl: Uint8Array): Uint8Array {
  const sid = sidBytes(owner);
  const bytes = new Uint8Array(20 + sid.length + acl.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(2, SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT, true);
  view.setUint32(4, 20, true);
  view.setUint32(16, 20 + sid.length, true);
  bytes.set(sid, 20);
  bytes.set(acl, 20 + sid.length);
  return bytes;
}

/** A path as the fake compares paths: as Windows resolves it, in lower case. */
export const pathKey = (path: string): string => win32.resolve(path).toLowerCase();
const key = pathKey;

/**
 * What is really at a path, as `FindFirstFileW` describes it: asked of Windows itself there
 * (where `lstat` of a socket file fails), worked out from `lstat` elsewhere.
 */
function realEntry(path: string): FoundEntry | undefined {
  if (process.platform === "win32") return WINDOWS_CALLS.findEntry(path)._unsafeUnwrap();
  if (!existsSync(path)) return undefined;
  const stats = lstatSync(path);
  if (stats.isSocket())
    return { attributes: FILE_ATTRIBUTE_REPARSE_POINT, reparseTag: IO_REPARSE_TAG_AF_UNIX };
  return { attributes: stats.isDirectory() ? FILE_ATTRIBUTE_DIRECTORY : 0x20, reparseTag: 0 };
}

export function fakeWindows(hub: string = HUB_SID): { fake: FakeWindows; calls: WindowsCalls } {
  const fake: FakeWindows = {
    sid: sidBytes(hub),
    attributes: new Map(),
    descriptors: new Map(),
    entries: new Map(),
    volume: { root: "C:\\", flags: FILE_PERSISTENT_ACLS, driveType: 3 },
    contents: new Map(),
    setList: "takes",
    listsSet: [],
    calls: [],
  };
  const answer = <T>(value: Answer<T>, what: string) =>
    value === "error" ? err(failure(`${what} failed with Windows error 5`)) : ok(value);
  const lookup = <T>(map: Map<string, Answer<T>>, path: string): Answer<T> | "unset" => {
    const k = key(path);
    return map.has(k) ? (map.get(k) as Answer<T>) : "unset";
  };
  const calls: WindowsCalls = {
    processSid: () => {
      fake.calls.push("processSid");
      return answer(fake.sid, "OpenProcessToken");
    },
    securityDescriptor: (path) => {
      fake.calls.push(`securityDescriptor ${path}`);
      const set = lookup(fake.descriptors, path);
      if (set !== "unset") return answer(set, "GetSecurityInfo");
      const socket = realEntry(path)?.reparseTag === IO_REPARSE_TAG_AF_UNIX;
      return ok(
        descriptorBytes(
          socket
            ? { owner: hub, dacl: socketAces(hub), control: SE_SELF_RELATIVE | SE_DACL_PRESENT }
            : { owner: ADMINISTRATORS_SID, dacl: lockedAces(hub) },
        ),
      );
    },
    attributes: (path) => {
      fake.calls.push(`attributes ${path}`);
      const set = lookup(fake.attributes, path);
      return set === "unset" ? ok(FILE_ATTRIBUTE_DIRECTORY) : answer(set, "GetFileAttributesW");
    },
    findEntry: (path) => {
      fake.calls.push(`findEntry ${path}`);
      const set = lookup(fake.entries, path);
      return set === "unset" ? ok(realEntry(path)) : answer(set, "FindFirstFileW");
    },
    volume: (path) => {
      fake.calls.push(`volume ${path}`);
      return answer(fake.volume, "GetVolumeInformationW");
    },
    list: (path) => {
      fake.calls.push(`list ${path}`);
      return ok(fake.contents.get(key(path)) ?? []);
    },
    setProtectedList: (path, acl) => {
      fake.calls.push(`setProtectedList ${path}`);
      fake.listsSet.push({ path, acl: acl.slice() });
      if (fake.setList === "error")
        return err(failure("SetSecurityInfo failed with Windows error 5"));
      if (fake.setList === "ignored") return ok(undefined);
      const before = calls.securityDescriptor(path);
      const owner = before.isOk()
        ? parseDescriptor(before.value).map((d) => d.owner)
        : ok(undefined);
      const kept = owner.isOk() ? owner.value : undefined;
      fake.descriptors.set(key(path), descriptorWithAcl(kept ?? ADMINISTRATORS_SID, acl));
      return ok(undefined);
    },
  };
  return { fake, calls };
}

/** Sets an answer for a path, as the fake compares paths. */
export function setFor<T>(map: Map<string, Answer<T>>, path: string, value: Answer<T>): void {
  map.set(key(path), value);
}
