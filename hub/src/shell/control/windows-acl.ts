/**
 * The access-list rules of the hub's folders on Windows (m2-design.md section 9, "The privilege
 * boundary" and "The top folders"; W2; docs/spikes/W2-W3-windows-socket-and-service.md): pure,
 * over the bytes of self-relative security descriptors, so they are tested on every system with
 * access lists given as data.
 *
 * Spike W2 proved that the folder's list is what keeps another account out of the socket (the
 * socket file takes its list from the folder's inheritable entries). The security review then
 * made the hub's account unable to rewrite that list: an owner can always rewrite a list, so the
 * top folders are owned by Administrators, and the hub's service account may add to a top folder
 * but never delete it, re-permission it or take it.
 *
 * **A top folder** (the data folder, the program folder) has exactly this shape, `topShape`:
 * - its owner is Administrators or SYSTEM;
 * - its list is protected (nothing inherited from `%ProgramData%`) and holds no inherited entry;
 * - Administrators and SYSTEM each have one entry of full control of the folder and its contents
 *   (`FILE_ALL_ACCESS`, object and container inherit);
 * - the hub's service account has two entries: on the folder itself exactly list, add a file, add
 *   a folder, traverse, read attributes, read the list and synchronize (`SERVICE_TOP_RIGHTS`,
 *   0x001200a7), and an inherit-only full control of the files and folders inside;
 * - nothing else: any other account or group, any other right, any entry of another kind is
 *   refused, and so is the service account owning the folder or holding `DELETE`, `WRITE_DAC` or
 *   `WRITE_OWNER` on it. Deny entries are accepted whoever they name: they only take access away.
 * Run by an administrator by hand, the hub accepts the same shape with the service account's two
 * entries absent (a computer with no service yet); the administrator's own account is never
 * accepted, since its unelevated programs hold it too. A deny entry for the service account,
 * Administrators or SYSTEM is accepted and warned of (`deniedAccounts`).
 *
 * **What is inside** (the socket file, the hub's files), `contentProblems`: owned by
 * Administrators, SYSTEM or the service account; entries, inherited or not, only for those three.
 *
 * Every read is bounded: bytes the system hands over are checked against their own lengths
 * before any is read, so a malformed descriptor is an error, never a read past its end.
 */
import { createHash } from "node:crypto";
import { err, ok, Result } from "neverthrow";

export const SYSTEM_SID = "S-1-5-18";
export const ADMINISTRATORS_SID = "S-1-5-32-544";

/** Names for the SIDs a person is likely to meet in a refusal; any other is shown as its SID. */
const NAMES: Readonly<Record<string, string>> = {
  "S-1-1-0": "Everyone",
  "S-1-3-0": "CREATOR OWNER",
  "S-1-3-1": "CREATOR GROUP",
  "S-1-3-4": "OWNER RIGHTS",
  "S-1-5-4": "INTERACTIVE",
  "S-1-5-7": "ANONYMOUS LOGON",
  "S-1-5-11": "Authenticated Users",
  [SYSTEM_SID]: "SYSTEM",
  [ADMINISTRATORS_SID]: "Administrators",
  "S-1-5-32-545": "Users",
  "S-1-5-32-546": "Guests",
  "S-1-15-2-1": "ALL APPLICATION PACKAGES",
};

/** `SECURITY_DESCRIPTOR_CONTROL` bits (winnt.h). */
export const SE_DACL_PRESENT = 0x0004;
export const SE_DACL_PROTECTED = 0x1000;
export const SE_SELF_RELATIVE = 0x8000;

/** ACE types (winnt.h): the only two this rule reads. */
export const ACCESS_ALLOWED_ACE_TYPE = 0x00;
export const ACCESS_DENIED_ACE_TYPE = 0x01;

/** ACE flags (winnt.h). */
export const OBJECT_INHERIT_ACE = 0x01;
export const CONTAINER_INHERIT_ACE = 0x02;
export const INHERIT_ONLY_ACE = 0x08;
export const INHERITED_ACE = 0x10;

const DESCRIPTOR_HEADER_BYTES = 20;
const ACL_HEADER_BYTES = 8;
const ACE_HEADER_BYTES = 4;
const SID_HEADER_BYTES = 8;
const SID_MAX_SUB_AUTHORITIES = 15;

export interface Ace {
  /** "other" for any type but the two read here; its SID is not read. */
  readonly kind: "allow" | "deny" | "other";
  readonly type: number;
  readonly flags: number;
  readonly mask: number;
  /** Undefined for an entry of another kind. */
  readonly sid: string | undefined;
}

export interface Descriptor {
  readonly control: number;
  /** Undefined when the descriptor names no owner. */
  readonly owner: string | undefined;
  /** Null when there is no list at all: everyone may enter. */
  readonly dacl: readonly Ace[] | null;
}

/** A SID as text, `S-1-5-21-…`, as `ConvertSidToStringSidW` writes it. */
export function parseSid(
  bytes: Uint8Array,
  at: number,
  end: number = bytes.length,
): Result<{ readonly sid: string; readonly end: number }, string> {
  if (at + SID_HEADER_BYTES > end) return err("a SID runs past its end");
  const revision = bytes[at] ?? 0;
  const count = bytes[at + 1] ?? 0;
  if (revision !== 1) return err(`a SID of revision ${revision}`);
  if (count > SID_MAX_SUB_AUTHORITIES) return err(`a SID with ${count} sub-authorities`);
  const after = at + SID_HEADER_BYTES + 4 * count;
  if (after > end) return err("a SID runs past its end");
  let authority = 0;
  for (let i = 0; i < 6; i++) authority = authority * 256 + (bytes[at + 2 + i] ?? 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [
    "S",
    "1",
    authority < 2 ** 32
      ? String(authority)
      : `0x${authority.toString(16).toUpperCase().padStart(12, "0")}`,
  ];
  for (let i = 0; i < count; i++)
    parts.push(String(view.getUint32(at + SID_HEADER_BYTES + 4 * i, true)));
  return ok({ sid: parts.join("-"), end: after });
}

/** An access list (`ACL`) at `at`, and its entries. */
export function parseAcl(bytes: Uint8Array, at: number): Result<readonly Ace[], string> {
  if (at + ACL_HEADER_BYTES > bytes.length) return err("the access list runs past its end");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const revision = bytes[at] ?? 0;
  if (revision !== 2 && revision !== 4) return err(`an access list of revision ${revision}`);
  const size = view.getUint16(at + 2, true);
  const count = view.getUint16(at + 4, true);
  const end = at + size;
  if (size < ACL_HEADER_BYTES || end > bytes.length)
    return err("the access list runs past its end");
  const aces: Ace[] = [];
  let p = at + ACL_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (p + ACE_HEADER_BYTES > end) return err(`entry ${i + 1} runs past the access list`);
    const type = bytes[p] ?? 0;
    const flags = bytes[p + 1] ?? 0;
    const aceSize = view.getUint16(p + 2, true);
    if (aceSize < ACE_HEADER_BYTES || p + aceSize > end)
      return err(`entry ${i + 1} runs past the access list`);
    if (type !== ACCESS_ALLOWED_ACE_TYPE && type !== ACCESS_DENIED_ACE_TYPE) {
      aces.push({ kind: "other", type, flags, mask: 0, sid: undefined });
    } else {
      if (aceSize < ACE_HEADER_BYTES + 4 + SID_HEADER_BYTES)
        return err(`entry ${i + 1} is too short`);
      const sid = parseSid(bytes, p + ACE_HEADER_BYTES + 4, p + aceSize);
      if (sid.isErr()) return err(`entry ${i + 1}: ${sid.error}`);
      aces.push({
        kind: type === ACCESS_ALLOWED_ACE_TYPE ? "allow" : "deny",
        type,
        flags,
        mask: view.getUint32(p + ACE_HEADER_BYTES, true),
        sid: sid.value.sid,
      });
    }
    p += aceSize;
  }
  return ok(aces);
}

/** A self-relative security descriptor's owner and access list. */
export function parseDescriptor(bytes: Uint8Array): Result<Descriptor, string> {
  if (bytes.length < DESCRIPTOR_HEADER_BYTES) return err("the descriptor is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const revision = bytes[0] ?? 0;
  if (revision !== 1) return err(`a descriptor of revision ${revision}`);
  const control = view.getUint16(2, true);
  if ((control & SE_SELF_RELATIVE) === 0) return err("the descriptor is not self-relative");
  const ownerAt = view.getUint32(4, true);
  const daclAt = view.getUint32(16, true);
  const owner = ownerAt === 0 ? ok(undefined) : parseSid(bytes, ownerAt).map(({ sid }) => sid);
  if (owner.isErr()) return err(`its owner: ${owner.error}`);
  if ((control & SE_DACL_PRESENT) === 0 || daclAt === 0)
    return ok({ control, owner: owner.value, dacl: null });
  return parseAcl(bytes, daclAt).map((dacl) => ({ control, owner: owner.value, dacl }));
}

/** The service's name, and so its virtual account `NT SERVICE\HSNHub` (section 9). */
export const HUB_SERVICE_NAME = "HSNHub";

/**
 * A service's own SID, as Windows derives it (`sc showsid`): S-1-5-80 and the SHA-1 of the
 * service's name in upper case, UTF-16LE, read as five little-endian 32-bit numbers.
 */
export function serviceSid(name: string): string {
  const digest = createHash("sha1").update(Buffer.from(name.toUpperCase(), "utf16le")).digest();
  const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  return `S-1-5-80-${[0, 4, 8, 12, 16].map((at) => view.getUint32(at, true)).join("-")}`;
}

/** `NT SERVICE\HSNHub`. */
export const HUB_SERVICE_SID = serviceSid(HUB_SERVICE_NAME);

/** File and standard access rights (winnt.h). */
export const FILE_LIST_DIRECTORY = 0x0001;
export const FILE_ADD_FILE = 0x0002;
export const FILE_ADD_SUBDIRECTORY = 0x0004;
export const FILE_TRAVERSE = 0x0020;
export const FILE_READ_ATTRIBUTES = 0x0080;
export const DELETE = 0x0001_0000;
export const READ_CONTROL = 0x0002_0000;
export const WRITE_DAC = 0x0004_0000;
export const WRITE_OWNER = 0x0008_0000;
export const SYNCHRONIZE = 0x0010_0000;
/** FILE_ALL_ACCESS, SDDL's `FA`. */
export const FILE_ALL_ACCESS = 0x001f_01ff;
/** The service account's rights on a top folder itself (section 9), 0x001200a7. */
export const SERVICE_TOP_RIGHTS =
  FILE_LIST_DIRECTORY |
  FILE_ADD_FILE |
  FILE_ADD_SUBDIRECTORY |
  FILE_TRAVERSE |
  FILE_READ_ATTRIBUTES |
  READ_CONTROL |
  SYNCHRONIZE;

const FULL_INHERIT = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const INSIDE_ONLY = FULL_INHERIT | INHERIT_ONLY_ACE;

/** Who the hub runs as: the service, or an administrator by hand. */
export type RunMode = "service" | "administrator";

/** A SID as a person reads it: `Users (S-1-5-32-545)`, or the SID alone. */
export function nameOf(sid: string, service?: string): string {
  if (service === sid) return `the hub's service account (${sid})`;
  const name = NAMES[sid];
  return name === undefined ? sid : `${name} (${sid})`;
}

function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, "0")}`;
}

const isAdministratorsOrSystem = (sid: string): boolean =>
  sid === ADMINISTRATORS_SID || sid === SYSTEM_SID;

/** What a right on the folder itself would let the service account do. */
const FORBIDDEN: readonly [number, string][] = [
  [DELETE, "DELETE (it could delete or rename the folder)"],
  [WRITE_DAC, "WRITE_DAC (it could rewrite the list)"],
  [WRITE_OWNER, "WRITE_OWNER (it could take the folder)"],
];

/**
 * What in a top folder's descriptor is not the shape (the top of this file), each as a person
 * reads it; none when it is.
 */
export function topFolderProblems(
  descriptor: Descriptor,
  service: string,
  mode: RunMode,
): readonly string[] {
  const problems: string[] = [];
  if (descriptor.owner === undefined) problems.push("it has no owner");
  else if (descriptor.owner === service)
    problems.push(`its owner is ${nameOf(service, service)}, which could rewrite the list`);
  else if (!isAdministratorsOrSystem(descriptor.owner))
    problems.push(`its owner is ${nameOf(descriptor.owner, service)}, who can change the list`);
  if (descriptor.dacl === null) {
    problems.push("it has no access list at all, so everyone may enter");
    return problems;
  }
  if ((descriptor.control & SE_DACL_PROTECTED) === 0)
    problems.push("it takes entries from the folder above (inheritance is on)");
  const full = new Map<string, number>([
    [ADMINISTRATORS_SID, 0],
    [SYSTEM_SID, 0],
  ]);
  const onFolder: Ace[] = [];
  const inside: Ace[] = [];
  for (const ace of descriptor.dacl) {
    if (ace.kind === "other" || ace.sid === undefined) {
      problems.push(`it has an entry of a kind the hub does not read (type ${hex(ace.type, 2)})`);
      continue;
    }
    if ((ace.flags & INHERITED_ACE) !== 0) {
      problems.push(`it has an entry inherited from above, for ${nameOf(ace.sid, service)}`);
      continue;
    }
    if (ace.kind === "deny") continue;
    if (isAdministratorsOrSystem(ace.sid)) {
      if (ace.flags === FULL_INHERIT && ace.mask === FILE_ALL_ACCESS)
        full.set(ace.sid, (full.get(ace.sid) ?? 0) + 1);
      else
        problems.push(
          `${nameOf(ace.sid, service)} has an entry of access ${hex(ace.mask, 8)}, flags ${hex(ace.flags, 2)}, not full control of the folder and its contents`,
        );
      continue;
    }
    if (ace.sid === service) {
      if ((ace.flags & INHERIT_ONLY_ACE) === 0) onFolder.push(ace);
      else inside.push(ace);
      continue;
    }
    problems.push(
      `it lets in ${nameOf(ace.sid, service)} (access ${hex(ace.mask, 8)}${(ace.flags & INHERIT_ONLY_ACE) !== 0 ? ", passed on to what is made inside" : ""})`,
    );
  }
  for (const [sid, count] of full)
    if (count !== 1)
      problems.push(
        count === 0
          ? `it does not give ${nameOf(sid)} full control of the folder and its contents`
          : `it gives ${nameOf(sid)} full control in ${count} entries, not one`,
      );
  if (mode === "administrator" && onFolder.length === 0 && inside.length === 0) return problems;
  const who = nameOf(service, service);
  for (const ace of onFolder)
    for (const [right, what] of FORBIDDEN)
      if ((ace.mask & right) !== 0) problems.push(`${who} holds ${what} on the folder itself`);
  const exact = onFolder.length === 1 ? onFolder[0] : undefined;
  if (exact?.flags !== 0 || exact.mask !== SERVICE_TOP_RIGHTS)
    problems.push(
      `${who} has ${onFolder.length === 0 ? "no entry" : onFolder.map((a) => `access ${hex(a.mask, 8)}, flags ${hex(a.flags, 2)}`).join(" and ")} on the folder itself, not exactly list, add a file, add a folder, traverse, read attributes, read the list and synchronize (${hex(SERVICE_TOP_RIGHTS, 8)}) on the folder alone`,
    );
  const within = inside.length === 1 ? inside[0] : undefined;
  if (within?.flags !== INSIDE_ONLY || within.mask !== FILE_ALL_ACCESS)
    problems.push(
      `${who} has ${inside.length === 0 ? "no entry" : inside.map((a) => `access ${hex(a.mask, 8)}, flags ${hex(a.flags, 2)}`).join(" and ")} for what is inside, not one inherit-only entry of full control of the files and folders inside`,
    );
  return problems;
}

/**
 * The accounts among the service account, Administrators and SYSTEM that a deny entry of a top
 * folder names. Accepted by the rule (they only take access away), but each may stop the hub or
 * the uninstaller later, so the hub warns of them at start.
 */
export function deniedAccounts(descriptor: Descriptor, service: string): readonly string[] {
  const named = new Set<string>();
  for (const ace of descriptor.dacl ?? [])
    if (
      ace.kind === "deny" &&
      ace.sid !== undefined &&
      (ace.sid === service || isAdministratorsOrSystem(ace.sid))
    )
      named.add(ace.sid);
  return [...named];
}

/**
 * What in the descriptor of something inside a top folder (the socket file, the hub's files) is
 * not as the top folder hands down: an owner or an entry for anyone but Administrators, SYSTEM
 * and the service account, no list, or an entry of a kind the hub does not read.
 */
export function contentProblems(descriptor: Descriptor, service: string): readonly string[] {
  const allowed = (sid: string): boolean => isAdministratorsOrSystem(sid) || sid === service;
  const problems: string[] = [];
  if (descriptor.owner === undefined) problems.push("it has no owner");
  else if (!allowed(descriptor.owner))
    problems.push(`its owner is ${nameOf(descriptor.owner, service)}, who can change the list`);
  if (descriptor.dacl === null) {
    problems.push("it has no access list at all, so everyone may enter");
    return problems;
  }
  for (const ace of descriptor.dacl) {
    if (ace.kind === "other" || ace.sid === undefined)
      problems.push(`it has an entry of a kind the hub does not read (type ${hex(ace.type, 2)})`);
    else if (ace.kind === "allow" && !allowed(ace.sid))
      problems.push(`it lets in ${nameOf(ace.sid, service)} (access ${hex(ace.mask, 8)})`);
  }
  return problems;
}

/** A top folder's descriptor bytes read and judged: the problems, or why it could not be read. */
export function checkTopFolder(
  bytes: Uint8Array,
  service: string,
  mode: RunMode,
): Result<void, readonly string[]> {
  const parsed = parseDescriptor(bytes);
  if (parsed.isErr()) return err([`it cannot be read (${parsed.error})`]);
  const problems = topFolderProblems(parsed.value, service, mode);
  return problems.length === 0 ? ok(undefined) : err(problems);
}

/** The same for something inside a top folder. */
export function checkContent(bytes: Uint8Array, service: string): Result<void, readonly string[]> {
  const parsed = parseDescriptor(bytes);
  if (parsed.isErr()) return err([`it cannot be read (${parsed.error})`]);
  const problems = contentProblems(parsed.value, service);
  return problems.length === 0 ? ok(undefined) : err(problems);
}

const ACL_REVISION = 2;

/** A SID's bytes from its text; an error for text that is not a SID. */
export function sidToBytes(sid: string): Result<Uint8Array, string> {
  const parts = sid.split("-");
  const [s, revision, authority = "", ...subs] = parts;
  if (s !== "S" || revision !== "1" || subs.length > SID_MAX_SUB_AUTHORITIES)
    return err(`not a SID: ${sid}`);
  const value = /^0x[0-9A-F]{12}$/u.test(authority)
    ? Number.parseInt(authority.slice(2), 16)
    : /^\d+$/u.test(authority) && Number(authority) < 2 ** 32
      ? Number(authority)
      : undefined;
  if (value === undefined || !subs.every((sub) => /^\d+$/u.test(sub) && Number(sub) < 2 ** 32))
    return err(`not a SID: ${sid}`);
  const bytes = new Uint8Array(SID_HEADER_BYTES + 4 * subs.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  bytes[1] = subs.length;
  let rest = value;
  for (let i = 5; i >= 0; i--) {
    bytes[2 + i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  subs.forEach((sub, i) => {
    view.setUint32(SID_HEADER_BYTES + 4 * i, Number(sub), true);
  });
  return ok(bytes);
}

/** One allow entry for an `ACL`. */
interface AllowEntry {
  readonly sid: Uint8Array;
  readonly flags: number;
  readonly mask: number;
}

/** An `ACL`'s bytes from its allow entries, in order. */
export function aclBytes(entries: readonly AllowEntry[]): Uint8Array {
  const size =
    ACL_HEADER_BYTES + entries.reduce((sum, e) => sum + ACE_HEADER_BYTES + 4 + e.sid.length, 0);
  const acl = new Uint8Array(size);
  const view = new DataView(acl.buffer);
  acl[0] = ACL_REVISION;
  view.setUint16(2, size, true);
  view.setUint16(4, entries.length, true);
  let at = ACL_HEADER_BYTES;
  for (const entry of entries) {
    const aceSize = ACE_HEADER_BYTES + 4 + entry.sid.length;
    acl[at] = ACCESS_ALLOWED_ACE_TYPE;
    acl[at + 1] = entry.flags;
    view.setUint16(at + 2, aceSize, true);
    view.setUint32(at + 4, entry.mask, true);
    acl.set(entry.sid, at + 8);
    at += aceSize;
  }
  return acl;
}

/** An empty `ACL`: with the list unprotected, an object holds only what it inherits. */
export const EMPTY_ACL = aclBytes([]);

/** A self-relative descriptor of an owner and a protected list. */
function protectedDescriptor(owner: Uint8Array, acl: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(DESCRIPTOR_HEADER_BYTES + owner.length + acl.length);
  const view = new DataView(bytes.buffer);
  bytes[0] = 1;
  view.setUint16(2, SE_SELF_RELATIVE | SE_DACL_PRESENT | SE_DACL_PROTECTED, true);
  view.setUint32(4, DESCRIPTOR_HEADER_BYTES, true);
  view.setUint32(16, DESCRIPTOR_HEADER_BYTES + owner.length, true);
  bytes.set(owner, DESCRIPTOR_HEADER_BYTES);
  bytes.set(acl, DESCRIPTOR_HEADER_BYTES + owner.length);
  return bytes;
}

/**
 * A top folder's shape as a self-relative descriptor (the top of this file): what an
 * administrator's run of the hub sets on an open top folder, and what the installer sets.
 */
export function topShape(service: string): Result<Uint8Array, string> {
  return Result.combine([
    sidToBytes(ADMINISTRATORS_SID),
    sidToBytes(SYSTEM_SID),
    sidToBytes(service),
  ]).map(([administrators, system, account]) =>
    protectedDescriptor(
      administrators,
      aclBytes([
        { sid: administrators, flags: FULL_INHERIT, mask: FILE_ALL_ACCESS },
        { sid: system, flags: FULL_INHERIT, mask: FILE_ALL_ACCESS },
        { sid: account, flags: 0, mask: SERVICE_TOP_RIGHTS },
        { sid: account, flags: INSIDE_ONLY, mask: FILE_ALL_ACCESS },
      ]),
    ),
  );
}

/** The same shape in SDDL, for the installer (A8). */
export function topShapeSddl(service: string): string {
  return `O:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;;${hex(SERVICE_TOP_RIGHTS, 8)};;;${service})(A;OICIIO;FA;;;${service})`;
}
