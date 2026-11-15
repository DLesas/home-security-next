/**
 * The access-list rule of the control socket on Windows (hub-design.md section 9; m2-design.md
 * section 9, W2; docs/spikes/W2-W3-windows-socket-and-service.md): pure, over the bytes of a
 * self-relative security descriptor, so it is tested on every system with access lists given as
 * data.
 *
 * What spike W2 proved decides it. Everyone holds "bypass traverse checking", so a folder's list
 * does not keep anyone from walking through it; what keeps a second account out of the socket is
 * the socket file's own list, which it takes from the folder's inheritable entries when it is
 * made. In an ordinary folder the second account got in. So the folder's list is the whole
 * protection, and the rule is strict:
 *
 * - **Allowed accounts**: the hub's own account (its process's SID), Administrators (S-1-5-32-544)
 *   and SYSTEM (S-1-5-18), and no one else (m2-design.md section 9: only administrators use
 *   `hsn`, from an elevated prompt; no user's SID is recorded, no group made).
 * - **Every allow entry** names one of them, whatever its mask, inherit-only entries included
 *   (CREATOR OWNER is refused: it is not one of them).
 * - **Deny entries** are accepted whoever they name: they only take access away.
 * - **Any other kind of entry** (object, callback, conditional, anything this file does not read)
 *   is refused.
 * - **The owner** is one of the allowed accounts: an owner can always rewrite the list.
 * - **No list at all** (a NULL DACL: everyone may enter) is refused.
 * - **The folder's list is protected and holds no inherited entry**: otherwise it depends on
 *   folders above, which the hub does not check and which can change after it has (a change
 *   above flows down). The socket file's list is inherited from the folder by design, so for it
 *   inherited entries are expected; every other rule is the same.
 *
 * Every read is bounded: bytes the system hands over are checked against their own lengths
 * before any is read, so a malformed descriptor is an error, never a read past its end.
 */
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

/** The account the socket admits besides Administrators and SYSTEM. */
export interface Accounts {
  /** The hub's own account: the SID of its process. */
  readonly hub: string;
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

/** A SID as a person reads it: `Users (S-1-5-32-545)`, or the SID alone. */
export function nameOf(sid: string, accounts?: Accounts): string {
  if (accounts?.hub === sid) return `the hub's account (${sid})`;
  const name = NAMES[sid];
  return name === undefined ? sid : `${name} (${sid})`;
}

function hex(value: number, digits: number): string {
  return `0x${value.toString(16).padStart(digits, "0")}`;
}

/** The only accounts the folder and the socket may admit, in the order the hub writes them. */
export function allowedSids(accounts: Accounts): readonly string[] {
  return [accounts.hub, ADMINISTRATORS_SID, SYSTEM_SID];
}

function allowedSet(accounts: Accounts): ReadonlySet<string> {
  return new Set(allowedSids(accounts));
}

/** Whether the owner is one of the allowed accounts: setting the list cannot change an owner. */
export function ownerAllowed(descriptor: Descriptor, accounts: Accounts): boolean {
  return descriptor.owner !== undefined && allowedSet(accounts).has(descriptor.owner);
}

/**
 * What in a descriptor breaks the rule (the top of this file), each as a person reads it; none
 * when it holds. `folder` is true for the data folder, false for the socket file.
 */
export function descriptorProblems(
  descriptor: Descriptor,
  accounts: Accounts,
  folder: boolean,
): readonly string[] {
  const allowed = allowedSet(accounts);
  const problems: string[] = [];
  if (descriptor.owner === undefined) problems.push("it has no owner");
  else if (!allowed.has(descriptor.owner))
    problems.push(`its owner is ${nameOf(descriptor.owner, accounts)}, who can change the list`);
  if (descriptor.dacl === null) {
    problems.push("it has no access list at all, so everyone may enter");
    return problems;
  }
  if (folder && (descriptor.control & SE_DACL_PROTECTED) === 0)
    problems.push("it takes entries from the folder above (inheritance is on)");
  for (const ace of descriptor.dacl) {
    if (ace.kind === "other") {
      problems.push(`it has an entry of a kind the hub does not read (type ${hex(ace.type, 2)})`);
      continue;
    }
    if (folder && (ace.flags & INHERITED_ACE) !== 0 && ace.sid !== undefined)
      problems.push(`it has an entry inherited from above, for ${nameOf(ace.sid, accounts)}`);
    if (ace.kind === "allow" && ace.sid !== undefined && !allowed.has(ace.sid))
      problems.push(
        `it lets in ${nameOf(ace.sid, accounts)} (access ${hex(ace.mask, 8)}${(ace.flags & INHERIT_ONLY_ACE) !== 0 ? ", passed on to what is made inside" : ""})`,
      );
  }
  return problems;
}

/** The descriptor's bytes read and checked: the problems found, or why it could not be read. */
export function checkDescriptor(
  bytes: Uint8Array,
  accounts: Accounts,
  folder: boolean,
): Result<void, readonly string[]> {
  const parsed = parseDescriptor(bytes);
  if (parsed.isErr()) return err([`it cannot be read (${parsed.error})`]);
  const problems = descriptorProblems(parsed.value, accounts, folder);
  return problems.length === 0 ? ok(undefined) : err(problems);
}

/** FILE_ALL_ACCESS: what the installer's list gives each allowed account (m2-design.md section 9). */
export const FILE_ALL_ACCESS = 0x001f_01ff;
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

/**
 * The list the hub sets on an open data folder (m2-design.md section 9), the installer's: full
 * control for each allowed account, passed on to everything inside, and nothing else. Set as a
 * protected list, so nothing from above is added to it.
 */
export function protectedAcl(accounts: Accounts): Result<Uint8Array, string> {
  return Result.combine(allowedSids(accounts).map(sidToBytes)).map(aclOf);
}

function aclOf(bodies: readonly Uint8Array[]): Uint8Array {
  const size =
    ACL_HEADER_BYTES + bodies.reduce((sum, sid) => sum + ACE_HEADER_BYTES + 4 + sid.length, 0);
  const acl = new Uint8Array(size);
  const view = new DataView(acl.buffer);
  acl[0] = ACL_REVISION;
  view.setUint16(2, size, true);
  view.setUint16(4, bodies.length, true);
  let at = ACL_HEADER_BYTES;
  for (const sid of bodies) {
    const aceSize = ACE_HEADER_BYTES + 4 + sid.length;
    acl[at] = ACCESS_ALLOWED_ACE_TYPE;
    acl[at + 1] = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
    view.setUint16(at + 2, aceSize, true);
    view.setUint32(at + 4, FILE_ALL_ACCESS, true);
    acl.set(sid, at + 8);
    at += aceSize;
  }
  return acl;
}
