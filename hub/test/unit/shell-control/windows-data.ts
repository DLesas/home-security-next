/**
 * Access lists as data, for the Windows rules' tests on every system: self-relative security
 * descriptors built from a description (as `GetSecurityInfo` returns them), and fake Win32 calls
 * that answer from a table, so the Windows steps run over a real AF_UNIX socket on macOS and
 * Linux with only the access lists and the accounts made up.
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
  INHERIT_ONLY_ACE,
  INHERITED_ACE,
  OBJECT_INHERIT_ACE,
  SE_DACL_PRESENT,
  SE_DACL_PROTECTED,
  SE_SELF_RELATIVE,
  SERVICE_TOP_RIGHTS,
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

/** The service account the tests stand in (a virtual account's form). */
export const SERVICE_SID = "S-1-5-80-1234567890-1111111111-2222222222-3333333333-4044444444";
/** A person: an administrator running the hub by hand, or an ordinary user. */
export const USER_SID = "S-1-5-21-1004336348-1177238915-682003330-1001";
export const USERS_SID = "S-1-5-32-545";
export const EVERYONE_SID = "S-1-1-0";
export const CREATOR_OWNER_SID = "S-1-3-0";
/** FILE_ALL_ACCESS, and READ_CONTROL alone. */
export const FULL = 0x001f_01ff;
export const READ_CONTROL = 0x0002_0000;
export const OI_CI = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
export const INSIDE_ONLY = OI_CI | INHERIT_ONLY_ACE;
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
  /** Undefined: Administrators. Null: none. */
  readonly owner?: string | null;
  /** Undefined: the top folder's shape. Null: no list at all. */
  readonly dacl?: readonly AceSpec[] | null;
  /** Undefined: protected, present and self-relative, as a top folder's. */
  readonly control?: number;
}

/** Administrators and SYSTEM in full control of a folder and its contents. */
export function adminAces(): readonly AceSpec[] {
  return [
    { kind: "allow", sid: ADMINISTRATORS_SID, flags: OI_CI, mask: FULL },
    { kind: "allow", sid: SYSTEM_SID, flags: OI_CI, mask: FULL },
  ];
}

/** The service account's two entries of a top folder. */
export function serviceAces(service: string = SERVICE_SID): readonly AceSpec[] {
  return [
    { kind: "allow", sid: service, flags: 0, mask: SERVICE_TOP_RIGHTS },
    { kind: "allow", sid: service, flags: INSIDE_ONLY, mask: FULL },
  ];
}

/** A top folder's list as the installer sets it (m2-design.md section 9). */
export function shapeAces(service: string = SERVICE_SID): readonly AceSpec[] {
  return [...adminAces(), ...serviceAces(service)];
}

/** What something inside a top folder of that shape inherits. */
export function contentAces(service: string = SERVICE_SID): readonly AceSpec[] {
  return [
    { kind: "allow", sid: ADMINISTRATORS_SID, flags: INHERITED, mask: FULL },
    { kind: "allow", sid: SYSTEM_SID, flags: INHERITED, mask: FULL },
    { kind: "allow", sid: service, flags: INHERITED, mask: FULL },
  ];
}

/** A content's descriptor: owned by `owner`, its list inherited (not protected). */
export function contentDescriptor(owner: string = SERVICE_SID, service = SERVICE_SID): Uint8Array {
  return descriptorBytes({
    owner,
    dacl: contentAces(service),
    control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
  });
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
  const owner = spec.owner === null ? undefined : sidBytes(spec.owner ?? ADMINISTRATORS_SID);
  const dacl = spec.dacl === undefined ? shapeAces() : spec.dacl;
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
  /** The account the hub's process runs as. */
  sid: Answer<Uint8Array>;
  /** Whether its token holds Administrators enabled. */
  administrator: Answer<boolean>;
  /** Each folder's attributes; unset: a plain folder. */
  readonly attributes: Map<string, Answer<number | undefined>>;
  /**
   * Descriptors by path; unset: a real socket file's is a content's, anything else the top
   * folder's shape.
   */
  readonly descriptors: Map<string, Answer<Uint8Array>>;
  /** `FindFirstFileW` by path; unset: what is really there (a socket shows as AF_UNIX). */
  readonly entries: Map<string, Answer<FoundEntry | undefined>>;
  volume: Answer<Volume>;
  /** The names in each folder; unset: none. */
  readonly contents: Map<string, readonly string[]>;
  /** What setting a top folder's shape does: it takes, it fails, or it changes nothing. */
  setShape: "takes" | "error" | "ignored";
  /** Paths whose "inherit from the parent" fails. */
  readonly inheritFails: Set<string>;
  /** Whether making the default owner Administrators fails. */
  ownerFails: boolean;
  /** What making a folder does: it takes, it fails, or the folder comes out otherwise. */
  createFolder: "takes" | "error" | "otherwise";
  /** Whether it was made: what the process creates is then Administrators'. */
  ownerIsAdministrators: boolean;
  /** Every shape set, with its path. */
  readonly shapesSet: { readonly path: string; readonly descriptor: Uint8Array }[];
  /** Every call made, in order: `<call> <path>`. */
  readonly calls: string[];
}

/** A path as the fake compares paths: as Windows resolves it, in lower case. */
export const pathKey = (path: string): string => win32.resolve(path).toLowerCase();

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

/**
 * Fake calls for a hub run as `runAs` (the service by default), with `service` its service
 * account.
 */
export function fakeWindows(
  runAs: string = SERVICE_SID,
  service: string = SERVICE_SID,
): { fake: FakeWindows; calls: WindowsCalls } {
  const fake: FakeWindows = {
    sid: sidBytes(runAs),
    administrator: false,
    attributes: new Map(),
    descriptors: new Map(),
    entries: new Map(),
    volume: { root: "C:\\", flags: FILE_PERSISTENT_ACLS, driveType: 3 },
    contents: new Map(),
    setShape: "takes",
    inheritFails: new Set(),
    ownerFails: false,
    createFolder: "takes",
    ownerIsAdministrators: false,
    shapesSet: [],
    calls: [],
  };
  const answer = <T>(value: Answer<T>, what: string) =>
    value === "error" ? err(failure(`${what} failed with Windows error 5`)) : ok(value);
  const lookup = <T>(map: Map<string, Answer<T>>, path: string): Answer<T> | "unset" => {
    const k = pathKey(path);
    return map.has(k) ? (map.get(k) as Answer<T>) : "unset";
  };
  /** Who owns what this process creates. */
  const creator = (): string => (fake.ownerIsAdministrators ? ADMINISTRATORS_SID : runAs);
  const calls: WindowsCalls = {
    processSid: () => {
      fake.calls.push("processSid");
      return answer(fake.sid, "OpenProcessToken");
    },
    isAdministrator: () => {
      fake.calls.push("isAdministrator");
      return answer(fake.administrator, "CheckTokenMembership");
    },
    securityDescriptor: (path) => {
      fake.calls.push(`securityDescriptor ${path}`);
      const set = lookup(fake.descriptors, path);
      if (set !== "unset") return answer(set, "GetSecurityInfo");
      const socket = realEntry(path)?.reparseTag === IO_REPARSE_TAG_AF_UNIX;
      return ok(
        socket
          ? contentDescriptor(creator(), service)
          : descriptorBytes({ dacl: shapeAces(service) }),
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
      return ok(fake.contents.get(pathKey(path)) ?? []);
    },
    setTopShape: (path, descriptor) => {
      fake.calls.push(`setTopShape ${path}`);
      fake.shapesSet.push({ path, descriptor: descriptor.slice() });
      if (fake.setShape === "error")
        return err(failure("SetKernelObjectSecurity failed with Windows error 5"));
      if (fake.setShape === "takes") fake.descriptors.set(pathKey(path), descriptor.slice());
      return ok(undefined);
    },
    inheritFromParent: (path) => {
      fake.calls.push(`inheritFromParent ${path}`);
      if (fake.inheritFails.has(pathKey(path)))
        return err(failure("SetNamedSecurityInfoW failed with Windows error 5"));
      fake.descriptors.set(pathKey(path), contentDescriptor(runAs, service));
      return ok(undefined);
    },
    createFolder: (path, descriptor) => {
      fake.calls.push(`createFolder ${path}`);
      if (fake.createFolder === "error")
        return err(failure("CreateDirectoryW failed with Windows error 5"));
      fake.attributes.set(pathKey(path), FILE_ATTRIBUTE_DIRECTORY);
      fake.descriptors.set(
        pathKey(path),
        fake.createFolder === "takes"
          ? descriptor.slice()
          : descriptorBytes({ control: SE_SELF_RELATIVE | SE_DACL_PRESENT }),
      );
      return ok(true);
    },
    defaultOwnerAdministrators: () => {
      fake.calls.push("defaultOwnerAdministrators");
      if (fake.ownerFails)
        return err(failure("SetTokenInformation failed with Windows error 1307"));
      fake.ownerIsAdministrators = true;
      return ok(undefined);
    },
  };
  return { fake, calls };
}

/** Sets an answer for a path, as the fake compares paths. */
export function setFor<T>(map: Map<string, Answer<T>>, path: string, value: Answer<T>): void {
  map.set(pathKey(path), value);
}
