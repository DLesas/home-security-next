/**
 * The Windows access-list rule (`shell/control/windows-acl.ts`), on every system, with access
 * lists given as data: the descriptor's bytes parsed as Windows lays them out (one vector written
 * out by hand, the rest built by `windows-data.ts`), each part of the rule shown to refuse what
 * it must and to let through what it must, every bound of the parser broken on its own, thousands
 * of byte strings read without a throw, and the list the hub sets on an open folder.
 */
import { describe, expect, test } from "bun:test";
import {
  ADMINISTRATORS_SID,
  allowedSids,
  checkDescriptor,
  FILE_ALL_ACCESS,
  parseAcl,
  protectedAcl,
  sidToBytes,
  INHERIT_ONLY_ACE,
  INHERITED_ACE,
  parseDescriptor,
  parseSid,
  SE_DACL_PRESENT,
  SE_DACL_PROTECTED,
  SE_SELF_RELATIVE,
  SYSTEM_SID,
} from "../../../src/shell/control/windows-acl.ts";
import {
  CREATOR_OWNER_SID,
  descriptorBytes,
  EVERYONE_SID,
  FULL,
  HUB_SID,
  USER_SID,
  lockedAces,
  OI_CI,
  READ_CONTROL,
  descriptorWithAcl,
  sidBytes,
  socketAces,
  USERS_SID,
} from "./windows-data.ts";

const HUB = { hub: HUB_SID };

/** The folder's problems, or "accepted". */
function folder(bytes: Uint8Array, accounts: { hub: string } = HUB) {
  const checked = checkDescriptor(bytes, accounts, true);
  return checked.isOk() ? "accepted" : checked.error.join("; ");
}

function socket(bytes: Uint8Array, accounts = HUB) {
  const checked = checkDescriptor(bytes, accounts, false);
  return checked.isOk() ? "accepted" : checked.error.join("; ");
}

describe("reading a security descriptor as Windows lays it out", () => {
  test("O:SYD:P(A;OICI;FA;;;SY), written out by hand, reads as SYSTEM's alone", () => {
    // prettier-ignore
    const bytes = new Uint8Array([
      0x01, 0x00, 0x04, 0x90, // revision 1; control: self-relative, protected, list present
      0x14, 0x00, 0x00, 0x00, // owner at 20
      0x00, 0x00, 0x00, 0x00, // no group
      0x00, 0x00, 0x00, 0x00, // no SACL
      0x20, 0x00, 0x00, 0x00, // the list at 32
      0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x12, 0x00, 0x00, 0x00, // S-1-5-18
      0x02, 0x00, 0x1c, 0x00, 0x01, 0x00, 0x00, 0x00, // ACL revision 2, 28 bytes, 1 entry
      0x00, 0x03, 0x14, 0x00, 0xff, 0x01, 0x1f, 0x00, // allow, OI|CI, 20 bytes, FILE_ALL_ACCESS
      0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, 0x12, 0x00, 0x00, 0x00, // S-1-5-18
    ]);
    const parsed = parseDescriptor(bytes);
    expect(parsed._unsafeUnwrap()).toEqual({
      control: SE_SELF_RELATIVE | SE_DACL_PROTECTED | SE_DACL_PRESENT,
      owner: SYSTEM_SID,
      dacl: [{ kind: "allow", type: 0, flags: OI_CI, mask: FULL, sid: SYSTEM_SID }],
    });
    const built = descriptorBytes({
      owner: SYSTEM_SID,
      dacl: [{ kind: "allow", sid: SYSTEM_SID, flags: OI_CI, mask: FULL }],
    });
    expect(built).toEqual(bytes);
    expect(folder(bytes)).toBe("accepted");
  });

  test("SIDs as ConvertSidToStringSidW writes them, a large authority in hexadecimal", () => {
    expect(parseSid(sidBytes(USER_SID), 0)._unsafeUnwrap().sid).toBe(USER_SID);
    expect(parseSid(sidBytes(HUB_SID), 0)._unsafeUnwrap().sid).toBe(HUB_SID);
    const big = new Uint8Array([1, 1, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 7, 0, 0, 0]);
    expect(parseSid(big, 0)._unsafeUnwrap().sid).toBe("S-1-0x010203040506-7");
  });

  test("a SID that claims more than its entry holds is refused, not read from the next entry", () => {
    const bytes = descriptorBytes();
    // The first entry's SID (the hub's, 6 sub-authorities) at 20 + 12 + 8 + 8: claim 7.
    const at = 20 + 12 + 8 + 8;
    expect(bytes[at + 1]).toBe(6);
    bytes[at + 1] = 7;
    const parsed = parseDescriptor(bytes);
    expect(parsed.isErr() ? parsed.error : "read").toBe("entry 1: a SID runs past its end");
  });

  test("bytes that are not a descriptor are refused, never read past their end", () => {
    const good = descriptorBytes();
    const cases: [string, Uint8Array][] = [
      ["too short", good.slice(0, 19)],
      ["cut inside the list", good.slice(0, good.length - 3)],
      ["revision 2", Uint8Array.from(good, (b, i) => (i === 0 ? 2 : b))],
      ["not self-relative", descriptorBytes({ control: SE_DACL_PRESENT | SE_DACL_PROTECTED })],
      ["a SID of 16 sub-authorities", Uint8Array.from(good, (b, i) => (i === 21 ? 16 : b))],
      ["an owner past the end", Uint8Array.from(good, (b, i) => (i === 4 ? 0xf0 : b))],
      ["an ACL of revision 9", Uint8Array.from(good, (b, i) => (i === 32 ? 9 : b))],
      ["an entry larger than its list", Uint8Array.from(good, (b, i) => (i === 42 ? 0xff : b))],
    ];
    for (const [what, bytes] of cases) {
      expect(`${what}: ${folder(bytes)}`).toContain(`${what}: it cannot be read`);
    }
  });
});

describe("the data folder's list (W2: it is the whole protection)", () => {
  test("the hub's account, Administrators and SYSTEM, protected: accepted", () => {
    expect(folder(descriptorBytes({ owner: ADMINISTRATORS_SID }))).toBe("accepted");
    expect(folder(descriptorBytes({ owner: HUB_SID }))).toBe("accepted");
    expect(folder(descriptorBytes({ owner: SYSTEM_SID, dacl: [] }))).toBe("accepted");
  });

  test("any allow entry for another account is refused and named, whatever its mask", () => {
    for (const [sid, name] of [
      [USERS_SID, "Users (S-1-5-32-545)"],
      [EVERYONE_SID, "Everyone (S-1-1-0)"],
      ["S-1-5-11", "Authenticated Users (S-1-5-11)"],
      [USER_SID, USER_SID],
    ] as const) {
      for (const mask of [FULL, READ_CONTROL]) {
        const bytes = descriptorBytes({
          dacl: [...lockedAces(), { kind: "allow", sid, flags: OI_CI, mask }],
        });
        expect(folder(bytes)).toContain(`it lets in ${name}`);
      }
    }
  });

  test("an inherit-only entry is refused too: it is passed on to the socket file", () => {
    const bytes = descriptorBytes({
      dacl: [
        ...lockedAces(),
        { kind: "allow", sid: CREATOR_OWNER_SID, flags: OI_CI | INHERIT_ONLY_ACE },
      ],
    });
    expect(folder(bytes)).toContain(
      "it lets in CREATOR OWNER (S-1-3-0) (access 0x001f01ff, passed on to what is made inside)",
    );
  });

  test("deny entries are accepted whoever they name: they only take access away", () => {
    const bytes = descriptorBytes({
      dacl: [
        { kind: "deny", sid: EVERYONE_SID, flags: OI_CI, mask: FULL },
        { kind: "deny", sid: USERS_SID, mask: READ_CONTROL },
        ...lockedAces(),
      ],
    });
    expect(folder(bytes)).toBe("accepted");
  });

  test("a deny entry does not excuse an allow entry for the same account", () => {
    const bytes = descriptorBytes({
      dacl: [
        { kind: "deny", sid: USERS_SID, flags: OI_CI },
        ...lockedAces(),
        { kind: "allow", sid: USERS_SID, flags: OI_CI },
      ],
    });
    expect(folder(bytes)).toContain("it lets in Users");
  });

  test("a list that takes entries from the folder above is refused, even with only the right accounts", () => {
    const bytes = descriptorBytes({ control: SE_SELF_RELATIVE | SE_DACL_PRESENT });
    expect(folder(bytes)).toBe("it takes entries from the folder above (inheritance is on)");
  });

  test("an inherited entry is refused, even for an allowed account and in a protected list", () => {
    const bytes = descriptorBytes({
      dacl: [...lockedAces(), { kind: "allow", sid: SYSTEM_SID, flags: INHERITED_ACE }],
    });
    expect(folder(bytes)).toBe("it has an entry inherited from above, for SYSTEM (S-1-5-18)");
  });

  test("no list at all lets everyone in, and is refused", () => {
    expect(folder(descriptorBytes({ dacl: null }))).toContain("no access list at all");
    const absent = descriptorBytes({ control: SE_SELF_RELATIVE | SE_DACL_PROTECTED });
    expect(folder(absent)).toContain("no access list at all");
  });

  test("an owner who is not an allowed account is refused: an owner can rewrite the list", () => {
    expect(folder(descriptorBytes({ owner: USERS_SID }))).toBe(
      "its owner is Users (S-1-5-32-545), who can change the list",
    );
    expect(folder(descriptorBytes({ owner: null }))).toBe("it has no owner");
  });

  test("an entry of a kind the rule does not read is refused (object, callback, conditional)", () => {
    for (const type of [0x05, 0x09, 0x0b, 0x02, 0x11]) {
      const bytes = descriptorBytes({ dacl: [...lockedAces(), { kind: type, sid: SYSTEM_SID }] });
      expect(folder(bytes)).toContain(
        `an entry of a kind the hub does not read (type 0x${type.toString(16).padStart(2, "0")})`,
      );
    }
  });

  test("the hub's account is the process's: the same list for another account is refused", () => {
    const other = "S-1-5-21-1-2-3-1002";
    expect(folder(descriptorBytes(), { hub: other })).toContain(`it lets in ${HUB_SID}`);
  });

  test("every problem is named at once", () => {
    const bytes = descriptorBytes({
      owner: USERS_SID,
      control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
      dacl: [{ kind: "allow", sid: EVERYONE_SID, flags: INHERITED_ACE }],
    });
    expect(folder(bytes).split("; ")).toEqual([
      "its owner is Users (S-1-5-32-545), who can change the list",
      "it takes entries from the folder above (inheritance is on)",
      "it has an entry inherited from above, for Everyone (S-1-1-0)",
      "it lets in Everyone (S-1-1-0) (access 0x001f01ff)",
    ]);
  });
});

describe("the socket file's list (read back after listening)", () => {
  const inherited = SE_SELF_RELATIVE | SE_DACL_PRESENT;

  test("inherited from a locked folder: accepted", () => {
    expect(
      socket(descriptorBytes({ owner: HUB_SID, dacl: socketAces(), control: inherited })),
    ).toBe("accepted");
  });

  test("another account in it, or an owner who is not allowed, or no list: refused", () => {
    const withUsers = descriptorBytes({
      owner: HUB_SID,
      control: inherited,
      dacl: [...socketAces(), { kind: "allow", sid: USERS_SID, flags: INHERITED_ACE }],
    });
    expect(socket(withUsers)).toContain("it lets in Users");
    expect(
      socket(descriptorBytes({ owner: USERS_SID, dacl: socketAces(), control: inherited })),
    ).toContain("its owner is Users");
    expect(socket(descriptorBytes({ owner: HUB_SID, dacl: null }))).toContain(
      "no access list at all",
    );
  });
});

/** Each bound the parser checks, broken on its own: the exact error, never a read past the end. */
describe("every read is bounded (bytes from the system cross a security boundary)", () => {
  const parse = (bytes: Uint8Array): string => {
    const parsed = parseDescriptor(bytes);
    return parsed.isOk() ? "read" : parsed.error;
  };
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** The default descriptor: header 20, owner SYSTEM (12 bytes) at 20, the list at 32. */
  const OWNER_AT = 20;
  const ACL_AT = 32;
  const FIRST_ACE = ACL_AT + 8;
  const good = () => descriptorBytes();

  test("a descriptor shorter than its header", () => {
    for (let n = 0; n < 20; n++)
      expect(parse(good().slice(0, n))).toBe("the descriptor is too short");
  });

  test("an owner whose SID header runs past the end", () => {
    const bytes = good();
    view(bytes).setUint32(4, bytes.length - 4, true);
    expect(parse(bytes)).toBe("its owner: a SID runs past its end");
  });

  test("an owner whose sub-authorities run past the end", () => {
    const bytes = good().slice(0, OWNER_AT + 12);
    view(bytes).setUint32(16, 0, true); // no list, so only the owner is read
    view(bytes).setUint16(2, SE_SELF_RELATIVE, true);
    expect(parse(bytes)).toBe("read");
    bytes[OWNER_AT + 1] = 2;
    expect(parse(bytes)).toBe("its owner: a SID runs past its end");
  });

  test("a list whose header runs past the end", () => {
    const bytes = good();
    view(bytes).setUint32(16, bytes.length - 4, true);
    bytes.set([2, 0, 8, 0], bytes.length - 4);
    expect(parse(bytes)).toBe("the access list runs past its end");
  });

  test("a list whose size runs past the end", () => {
    const bytes = good();
    view(bytes).setUint16(ACL_AT + 2, bytes.length - ACL_AT + 4, true);
    expect(parse(bytes)).toBe("the access list runs past its end");
  });

  test("a list smaller than its own header", () => {
    const bytes = good();
    view(bytes).setUint16(ACL_AT + 2, 4, true);
    expect(parse(bytes)).toBe("the access list runs past its end");
  });

  test("an entry whose header runs past the list (more entries counted than there are)", () => {
    const bytes = good();
    view(bytes).setUint16(ACL_AT + 4, 4, true);
    expect(parse(bytes)).toBe("entry 4 runs past the access list");
  });

  test("an entry whose size runs past the end of the list", () => {
    const bytes = good();
    const last = bytes.length - 20; // the third entry, SYSTEM's: 20 bytes
    expect(bytes[last + 2]).toBe(20);
    view(bytes).setUint16(last + 2, 24, true);
    expect(parse(bytes)).toBe("entry 3 runs past the access list");
  });

  test("an entry whose size runs past the list but not past the bytes", () => {
    // The list says it ends 4 bytes before the bytes do; its last entry claims those 4 bytes.
    const base = good();
    const bytes = new Uint8Array(base.length + 4);
    bytes.set(base);
    const last = base.length - 20;
    view(bytes).setUint16(last + 2, 24, true);
    expect(parse(bytes)).toBe("entry 3 runs past the access list");
  });

  test("an entry smaller than an entry's header", () => {
    const bytes = good();
    view(bytes).setUint16(FIRST_ACE + 2, 2, true);
    expect(parse(bytes)).toBe("entry 1 runs past the access list");
  });

  test("an allow entry too short to hold a mask and a SID", () => {
    const bytes = good();
    view(bytes).setUint16(FIRST_ACE + 2, 12, true);
    expect(parse(bytes)).toBe("entry 1 is too short");
  });

  test("a SID that claims more than its entry holds is read from nowhere else", () => {
    const bytes = good();
    expect(bytes[FIRST_ACE + 8 + 1]).toBe(6);
    bytes[FIRST_ACE + 8 + 1] = 7;
    expect(parse(bytes)).toBe("entry 1: a SID runs past its end");
  });

  /** A small seeded generator (mulberry32), so the run is the same every time. */
  function random(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Every way the rule is asked: as a folder's list and as the socket file's. */
  function verdicts(bytes: Uint8Array): readonly string[] {
    return [true, false].map((asFolder) => {
      const checked = checkDescriptor(bytes, HUB, asFolder);
      return checked.isOk() ? "accepted" : "refused";
    });
  }

  test("thousands of byte strings: a result every time, never a throw, accepted only when valid", () => {
    const valid = [
      descriptorBytes(),
      descriptorBytes({ owner: HUB_SID }),
      descriptorBytes({
        dacl: [{ kind: "deny", sid: EVERYONE_SID, flags: OI_CI }, ...lockedAces()],
      }),
      descriptorBytes({
        owner: HUB_SID,
        dacl: socketAces(),
        control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
      }),
      descriptorWithAcl(ADMINISTRATORS_SID, protectedAcl(HUB)._unsafeUnwrap()),
    ];
    const validText = new Set(valid.map((bytes) => bytes.join(",")));
    let tried = 0;
    let accepted = 0;
    const check = (bytes: Uint8Array): void => {
      tried += 1;
      const parsed = parseDescriptor(bytes);
      expect(parsed.isOk() !== parsed.isErr()).toBe(true);
      const said = verdicts(bytes);
      if (said.includes("accepted")) {
        accepted += 1;
        expect(validText.has(bytes.join(","))).toBe(true);
      }
    };
    // Every truncation of every valid descriptor.
    for (const bytes of valid) for (let n = 0; n < bytes.length; n++) check(bytes.slice(0, n));
    // Seeded random bytes, of every length up to 160.
    const next = random(0x4a11);
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(Math.floor(next() * 160));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(next() * 256);
      check(bytes);
    }
    // Seeded random bytes behind a plausible header: revision 1, self-relative, offsets inside.
    for (let i = 0; i < 2000; i++) {
      const bytes = new Uint8Array(20 + Math.floor(next() * 140));
      for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(next() * 256);
      const dv = new DataView(bytes.buffer);
      bytes[0] = 1;
      dv.setUint16(
        2,
        SE_SELF_RELATIVE | SE_DACL_PRESENT | (next() < 0.5 ? SE_DACL_PROTECTED : 0),
        true,
      );
      dv.setUint32(4, Math.floor(next() * bytes.length), true);
      dv.setUint32(16, Math.floor(next() * bytes.length), true);
      if (bytes.length > 24) bytes[dv.getUint32(16, true)] = 2;
      check(bytes);
    }
    // Each valid descriptor with one byte changed to every value.
    for (const bytes of valid.slice(0, 1)) {
      for (let at = 0; at < bytes.length; at++) {
        for (const value of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
          const changed = bytes.slice();
          changed[at] = value;
          tried += 1;
          const parsed = parseDescriptor(changed);
          expect(parsed.isOk() !== parsed.isErr()).toBe(true);
          expect(verdicts(changed)).toHaveLength(2);
        }
      }
    }
    expect(tried).toBeGreaterThan(4000);
    expect(accepted).toBe(0);
  });
});

describe("the list the hub sets on an open folder (m2-design.md section 9)", () => {
  test("SIDs as text go back to the bytes they came from", () => {
    for (const sid of [HUB_SID, USER_SID, SYSTEM_SID, ADMINISTRATORS_SID, "S-1-0x010203040506-7"]) {
      const bytes = sidToBytes(sid)._unsafeUnwrap();
      expect(parseSid(bytes, 0)._unsafeUnwrap().sid).toBe(sid);
    }
    for (const bad of ["S-2-5-18", "S-1-x-18", "s-1-5-18", "S-1-5-4294967296", "S-1"])
      expect(sidToBytes(bad).isErr()).toBe(true);
  });

  test("it names the hub's account, Administrators and SYSTEM, full control, passed on, and no one else", () => {
    const acl = protectedAcl(HUB)._unsafeUnwrap();
    expect(parseAcl(acl, 0)._unsafeUnwrap()).toEqual(
      allowedSids(HUB).map((sid) => ({
        kind: "allow",
        type: 0,
        flags: OI_CI,
        mask: FILE_ALL_ACCESS,
        sid,
      })),
    );
    expect(allowedSids(HUB)).toEqual([HUB_SID, ADMINISTRATORS_SID, SYSTEM_SID]);
  });

  test("set as a protected list it passes the rule, for the folder and for what is made inside", () => {
    const acl = protectedAcl(HUB)._unsafeUnwrap();
    expect(folder(descriptorWithAcl(ADMINISTRATORS_SID, acl))).toBe("accepted");
    expect(folder(descriptorWithAcl(HUB_SID, acl))).toBe("accepted");
  });

  test("a hub account that is not a SID makes no list", () => {
    expect(protectedAcl({ hub: "nobody" }).isErr()).toBe(true);
  });
});
