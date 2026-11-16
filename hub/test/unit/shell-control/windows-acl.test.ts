/**
 * The Windows access-list rules (`shell/control/windows-acl.ts`), on every system, with access
 * lists given as data: the descriptor's bytes parsed as Windows lays them out (one vector written
 * out by hand, the rest built by `windows-data.ts`); the top folders' shape (m2-design.md section
 * 9, "The top folders") shown to accept exactly itself and to refuse each way of differing from
 * it, as the service and by hand; what is inside; every bound of the parser broken on its own;
 * thousands of byte strings read without a throw; and the shape the hub and the installer set.
 */
import { describe, expect, test } from "bun:test";
import {
  ADMINISTRATORS_SID,
  checkContent,
  checkTopFolder,
  deniedAccounts,
  DELETE,
  FILE_ALL_ACCESS,
  HUB_SERVICE_SID,
  INHERIT_ONLY_ACE,
  parseDescriptor,
  parseSid,
  type RunMode,
  SE_DACL_PRESENT,
  SE_DACL_PROTECTED,
  SE_SELF_RELATIVE,
  SERVICE_TOP_RIGHTS,
  serviceSid,
  sidToBytes,
  SYNCHRONIZE,
  SYSTEM_SID,
  topShape,
  topShapeSddl,
  WRITE_DAC,
  WRITE_OWNER,
} from "../../../src/shell/control/windows-acl.ts";
import {
  adminAces,
  CREATOR_OWNER_SID,
  contentAces,
  contentDescriptor,
  descriptorBytes,
  EVERYONE_SID,
  FULL,
  INHERITED,
  INSIDE_ONLY,
  OI_CI,
  READ_CONTROL,
  SERVICE_SID,
  serviceAces,
  shapeAces,
  sidBytes,
  USER_SID,
  USERS_SID,
} from "./windows-data.ts";

/** A top folder's problems as `mode` judges them, or "accepted". */
function top(bytes: Uint8Array, mode: RunMode = "service", service = SERVICE_SID): string {
  const checked = checkTopFolder(bytes, service, mode);
  return checked.isOk() ? "accepted" : checked.error.join("; ");
}

function content(bytes: Uint8Array): string {
  const checked = checkContent(bytes, SERVICE_SID);
  return checked.isOk() ? "accepted" : checked.error.join("; ");
}

/** Both modes' verdicts. */
const both = (bytes: Uint8Array): readonly string[] => [
  top(bytes, "service"),
  top(bytes, "administrator"),
];

/**
 * A fixed layout for the parser's tests: owner SYSTEM (12 bytes) at 20, the list at 32, its
 * first entry the service's (a SID of 6 sub-authorities), its last SYSTEM's (20 bytes).
 */
function layout(): Uint8Array {
  return descriptorBytes({
    owner: SYSTEM_SID,
    dacl: [
      { kind: "allow", sid: SERVICE_SID, flags: INSIDE_ONLY, mask: FULL },
      { kind: "allow", sid: ADMINISTRATORS_SID, flags: OI_CI, mask: FULL },
      { kind: "allow", sid: SYSTEM_SID, flags: OI_CI, mask: FULL },
    ],
  });
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
    expect(parseDescriptor(bytes).isOk()).toBe(true);
  });

  test("SIDs as ConvertSidToStringSidW writes them, a large authority in hexadecimal", () => {
    expect(parseSid(sidBytes(USER_SID), 0)._unsafeUnwrap().sid).toBe(USER_SID);
    expect(parseSid(sidBytes(SERVICE_SID), 0)._unsafeUnwrap().sid).toBe(SERVICE_SID);
    const big = new Uint8Array([1, 1, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 7, 0, 0, 0]);
    expect(parseSid(big, 0)._unsafeUnwrap().sid).toBe("S-1-0x010203040506-7");
  });

  test("a SID that claims more than its entry holds is refused, not read from the next entry", () => {
    const bytes = layout();
    // The first entry's SID (the service's, 6 sub-authorities) at 20 + 12 + 8 + 8: claim 7.
    const at = 20 + 12 + 8 + 8;
    expect(bytes[at + 1]).toBe(6);
    bytes[at + 1] = 7;
    const parsed = parseDescriptor(bytes);
    expect(parsed.isErr() ? parsed.error : "read").toBe("entry 1: a SID runs past its end");
  });

  test("bytes that are not a descriptor are refused, never read past their end", () => {
    const good = layout();
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
      expect(`${what}: ${top(bytes)}`).toContain(`${what}: it cannot be read`);
    }
  });
});

describe('a top folder\'s shape (m2-design.md section 9, "The top folders")', () => {
  test("exactly the shape is accepted, owned by Administrators or SYSTEM, as the service and by hand", () => {
    expect(both(descriptorBytes())).toEqual(["accepted", "accepted"]);
    expect(both(descriptorBytes({ owner: SYSTEM_SID }))).toEqual(["accepted", "accepted"]);
    // The order of the entries does not matter.
    expect(both(descriptorBytes({ dacl: [...shapeAces()].reverse() }))).toEqual([
      "accepted",
      "accepted",
    ]);
  });

  test("by hand, the shape without the service account's entries is accepted; as the service it is not", () => {
    const bytes = descriptorBytes({ dacl: adminAces() });
    expect(top(bytes, "administrator")).toBe("accepted");
    expect(top(bytes, "service")).toContain("has no entry on the folder itself");
    expect(top(bytes, "service")).toContain("no entry for what is inside");
  });

  test("by hand, one of the service account's two entries without the other is refused", () => {
    for (const one of serviceAces())
      expect(top(descriptorBytes({ dacl: [...adminAces(), one] }), "administrator")).not.toBe(
        "accepted",
      );
  });

  test("any other account or group is refused and named, whatever its rights, as the service and by hand", () => {
    for (const [sid, name] of [
      [USERS_SID, "Users (S-1-5-32-545)"],
      [EVERYONE_SID, "Everyone (S-1-1-0)"],
      ["S-1-5-11", "Authenticated Users (S-1-5-11)"],
      [CREATOR_OWNER_SID, "CREATOR OWNER (S-1-3-0)"],
      [USER_SID, USER_SID],
    ] as const) {
      for (const [flags, mask] of [
        [OI_CI, FULL],
        [0, READ_CONTROL],
        [INSIDE_ONLY, FULL],
      ] as const) {
        const bytes = descriptorBytes({
          dacl: [...shapeAces(), { kind: "allow", sid, flags, mask }],
        });
        for (const verdict of both(bytes)) expect(verdict).toContain(`it lets in ${name}`);
      }
    }
  });

  test("by hand, the administrator's own account in the list is refused: its unelevated programs hold it", () => {
    const bytes = descriptorBytes({
      dacl: [...shapeAces(), { kind: "allow", sid: USER_SID, flags: OI_CI, mask: FULL }],
    });
    expect(top(bytes, "administrator")).toContain(`it lets in ${USER_SID}`);
  });

  test("the service account owning the folder is refused: it could rewrite the list", () => {
    for (const verdict of both(descriptorBytes({ owner: SERVICE_SID })))
      expect(verdict).toContain(
        `its owner is the hub's service account (${SERVICE_SID}), which could rewrite the list`,
      );
  });

  test("any other owner, or none, is refused", () => {
    expect(top(descriptorBytes({ owner: USER_SID }))).toBe(
      `its owner is ${USER_SID}, who can change the list`,
    );
    expect(top(descriptorBytes({ owner: USERS_SID }))).toContain("its owner is Users");
    expect(top(descriptorBytes({ owner: null }))).toBe("it has no owner");
  });

  test("DELETE, WRITE_DAC or WRITE_OWNER for the service account on the folder itself is refused, each named", () => {
    for (const [right, what] of [
      [DELETE, "DELETE"],
      [WRITE_DAC, "WRITE_DAC"],
      [WRITE_OWNER, "WRITE_OWNER"],
    ] as const) {
      const bytes = descriptorBytes({
        dacl: [
          ...adminAces(),
          { kind: "allow", sid: SERVICE_SID, flags: 0, mask: SERVICE_TOP_RIGHTS | right },
          serviceAces()[1] ?? serviceAces()[0] ?? { kind: "allow", sid: SERVICE_SID },
        ],
      });
      for (const verdict of both(bytes))
        expect(verdict).toContain(`the hub's service account (${SERVICE_SID}) holds ${what}`);
    }
  });

  test("the service account's rights on the folder itself must be exactly the seven, no more and no fewer", () => {
    for (const mask of [
      SERVICE_TOP_RIGHTS & ~SYNCHRONIZE,
      SERVICE_TOP_RIGHTS | 0x0008,
      FILE_ALL_ACCESS,
      0x001200a9,
    ]) {
      const bytes = descriptorBytes({
        dacl: [
          ...adminAces(),
          { kind: "allow", sid: SERVICE_SID, flags: 0, mask },
          ...serviceAces().slice(1),
        ],
      });
      expect(top(bytes)).toContain(
        "not exactly list, add a file, add a folder, traverse, read attributes, read the list and synchronize (0x001200a7)",
      );
    }
  });

  test("the service account's rights on the folder passed on to what is inside are refused", () => {
    const bytes = descriptorBytes({
      dacl: [
        ...adminAces(),
        { kind: "allow", sid: SERVICE_SID, flags: OI_CI, mask: SERVICE_TOP_RIGHTS },
        ...serviceAces().slice(1),
      ],
    });
    expect(top(bytes)).toContain("on the folder itself, not exactly");
  });

  test("the service account's full control of what is inside must be one inherit-only entry of full control", () => {
    for (const [flags, mask] of [
      [INSIDE_ONLY, SERVICE_TOP_RIGHTS],
      [0x01 | INHERIT_ONLY_ACE, FULL],
      [0x02 | INHERIT_ONLY_ACE, FULL],
      [INSIDE_ONLY, 0x10000000],
    ] as const) {
      const bytes = descriptorBytes({
        dacl: [
          ...adminAces(),
          ...serviceAces().slice(0, 1),
          { kind: "allow", sid: SERVICE_SID, flags, mask },
        ],
      });
      expect(top(bytes)).toContain(
        "not one inherit-only entry of full control of the files and folders inside",
      );
    }
    const twice = descriptorBytes({ dacl: [...shapeAces(), ...serviceAces().slice(1)] });
    expect(top(twice)).toContain("for what is inside, not one inherit-only entry");
  });

  test("Administrators or SYSTEM without exactly one entry of full control of the folder and its contents is refused", () => {
    expect(top(descriptorBytes({ dacl: shapeAces().slice(1) }))).toContain(
      "it does not give Administrators (S-1-5-32-544) full control of the folder and its contents",
    );
    expect(top(descriptorBytes({ dacl: [...shapeAces(), ...adminAces().slice(1)] }))).toContain(
      "it gives SYSTEM (S-1-5-18) full control in 2 entries, not one",
    );
    const partial = descriptorBytes({
      dacl: [
        { kind: "allow", sid: ADMINISTRATORS_SID, flags: 0, mask: FULL },
        ...shapeAces().slice(1),
      ],
    });
    expect(top(partial)).toContain(
      "Administrators (S-1-5-32-544) has an entry of access 0x001f01ff, flags 0x00",
    );
  });

  test("a list that takes entries from the folder above, or an inherited entry, is refused", () => {
    expect(top(descriptorBytes({ control: SE_SELF_RELATIVE | SE_DACL_PRESENT }))).toBe(
      "it takes entries from the folder above (inheritance is on)",
    );
    const inherited = descriptorBytes({
      dacl: [...shapeAces(), { kind: "allow", sid: SYSTEM_SID, flags: INHERITED, mask: FULL }],
    });
    expect(top(inherited)).toBe("it has an entry inherited from above, for SYSTEM (S-1-5-18)");
  });

  test("no list at all is refused", () => {
    expect(top(descriptorBytes({ dacl: null }))).toContain("no access list at all");
    expect(top(descriptorBytes({ control: SE_SELF_RELATIVE | SE_DACL_PROTECTED }))).toContain(
      "no access list at all",
    );
  });

  test("an entry of a kind the rules do not read is refused (object, callback, conditional)", () => {
    for (const type of [0x05, 0x09, 0x0b, 0x02, 0x11]) {
      const bytes = descriptorBytes({ dacl: [...shapeAces(), { kind: type, sid: SYSTEM_SID }] });
      expect(top(bytes)).toContain(
        `an entry of a kind the hub does not read (type 0x${type.toString(16).padStart(2, "0")})`,
      );
    }
  });

  test("deny entries are accepted whoever they name, and excuse no allow entry", () => {
    const deny = descriptorBytes({
      dacl: [
        { kind: "deny", sid: EVERYONE_SID, flags: OI_CI },
        { kind: "deny", sid: SERVICE_SID, mask: DELETE },
        ...shapeAces(),
      ],
    });
    expect(both(deny)).toEqual(["accepted", "accepted"]);
    const excused = descriptorBytes({
      dacl: [
        { kind: "deny", sid: USERS_SID, flags: OI_CI },
        ...shapeAces(),
        { kind: "allow", sid: USERS_SID, flags: OI_CI },
      ],
    });
    expect(top(excused)).toContain("it lets in Users");
  });

  test("the shape names one service account: the same list with another's is refused", () => {
    expect(top(descriptorBytes(), "service", HUB_SERVICE_SID)).toContain(
      `it lets in ${SERVICE_SID}`,
    );
  });

  test("every problem is named at once", () => {
    const bytes = descriptorBytes({
      owner: USERS_SID,
      control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
      dacl: [...shapeAces(), { kind: "allow", sid: EVERYONE_SID, flags: INHERITED }],
    });
    expect(top(bytes).split("; ")).toEqual([
      "its owner is Users (S-1-5-32-545), who can change the list",
      "it takes entries from the folder above (inheritance is on)",
      "it has an entry inherited from above, for Everyone (S-1-1-0)",
    ]);
  });
});

describe("deny entries that may stop the hub later", () => {
  test("those naming the service account, Administrators or SYSTEM are named, once each; others are not", () => {
    const parsed = parseDescriptor(
      descriptorBytes({
        dacl: [
          { kind: "deny", sid: SERVICE_SID, mask: DELETE },
          { kind: "deny", sid: SERVICE_SID, mask: WRITE_DAC },
          { kind: "deny", sid: ADMINISTRATORS_SID, mask: DELETE },
          { kind: "deny", sid: EVERYONE_SID },
          ...shapeAces(),
        ],
      }),
    )._unsafeUnwrap();
    expect(deniedAccounts(parsed, SERVICE_SID)).toEqual([SERVICE_SID, ADMINISTRATORS_SID]);
    expect(deniedAccounts(parseDescriptor(descriptorBytes())._unsafeUnwrap(), SERVICE_SID)).toEqual(
      [],
    );
  });
});

describe("what is inside a top folder (the socket file, the hub's files)", () => {
  test("inherited from the shape, owned by the service, Administrators or SYSTEM: accepted", () => {
    for (const owner of [SERVICE_SID, ADMINISTRATORS_SID, SYSTEM_SID])
      expect(content(contentDescriptor(owner))).toBe("accepted");
  });

  test("another account in it, an owner who is not one of the three, or no list: refused", () => {
    const withUsers = descriptorBytes({
      owner: SERVICE_SID,
      control: SE_SELF_RELATIVE | SE_DACL_PRESENT,
      dacl: [...contentAces(), { kind: "allow", sid: USERS_SID, flags: INHERITED }],
    });
    expect(content(withUsers)).toContain("it lets in Users");
    expect(content(contentDescriptor(USER_SID))).toContain(`its owner is ${USER_SID}`);
    expect(content(descriptorBytes({ owner: SERVICE_SID, dacl: null }))).toContain(
      "no access list at all",
    );
    expect(
      content(descriptorBytes({ owner: SERVICE_SID, dacl: [{ kind: 0x09, sid: SYSTEM_SID }] })),
    ).toContain("a kind the hub does not read");
  });
});

describe("every read is bounded (bytes from the system cross a security boundary)", () => {
  const parse = (bytes: Uint8Array): string => {
    const parsed = parseDescriptor(bytes);
    return parsed.isOk() ? "read" : parsed.error;
  };
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** `layout()`: header 20, owner SYSTEM (12 bytes) at 20, the list at 32. */
  const OWNER_AT = 20;
  const ACL_AT = 32;
  const FIRST_ACE = ACL_AT + 8;
  const good = layout;

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

  /** Every way the rules are asked: a top folder's as the service and by hand, a content's. */
  function verdicts(bytes: Uint8Array): readonly string[] {
    return [
      checkTopFolder(bytes, SERVICE_SID, "service"),
      checkTopFolder(bytes, SERVICE_SID, "administrator"),
      checkContent(bytes, SERVICE_SID),
    ].map((checked) => (checked.isOk() ? "accepted" : "refused"));
  }

  test("thousands of byte strings: a result every time, never a throw, accepted only when valid", () => {
    const valid = [
      descriptorBytes(),
      descriptorBytes({ owner: SYSTEM_SID }),
      descriptorBytes({
        dacl: [{ kind: "deny", sid: EVERYONE_SID, flags: OI_CI }, ...shapeAces()],
      }),
      descriptorBytes({ dacl: adminAces() }),
      contentDescriptor(),
      topShape(SERVICE_SID)._unsafeUnwrap(),
      layout(),
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
          expect(verdicts(changed)).toHaveLength(3);
        }
      }
    }
    expect(tried).toBeGreaterThan(4000);
    expect(accepted).toBe(0);
  });
});

describe("the shape the hub and the installer set", () => {
  test("NT SERVICE\\HSNHub's SID is the service SID Windows derives from the name", () => {
    // Checked against a SID Windows publishes: TrustedInstaller's.
    expect(serviceSid("TrustedInstaller")).toBe(
      "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    );
    expect(serviceSid("trustedinstaller")).toBe(serviceSid("TrustedInstaller"));
    expect(HUB_SERVICE_SID).toBe("S-1-5-80-382789279-1444082746-186061269-2257954938-261857140");
  });

  test("SIDs as text go back to the bytes they came from", () => {
    for (const sid of [
      SERVICE_SID,
      USER_SID,
      SYSTEM_SID,
      ADMINISTRATORS_SID,
      "S-1-0x010203040506-7",
    ]) {
      const bytes = sidToBytes(sid)._unsafeUnwrap();
      expect(parseSid(bytes, 0)._unsafeUnwrap().sid).toBe(sid);
    }
    for (const bad of ["S-2-5-18", "S-1-x-18", "s-1-5-18", "S-1-5-4294967296", "S-1"])
      expect(sidToBytes(bad).isErr()).toBe(true);
  });

  test("the shape the hub sets is owned by Administrators, protected, and exactly the shape", () => {
    const bytes = topShape(SERVICE_SID)._unsafeUnwrap();
    const parsed = parseDescriptor(bytes)._unsafeUnwrap();
    expect(parsed.owner).toBe(ADMINISTRATORS_SID);
    expect(parsed.control & SE_DACL_PROTECTED).toBe(SE_DACL_PROTECTED);
    expect(parsed.dacl).toEqual([
      { kind: "allow", type: 0, flags: OI_CI, mask: FULL, sid: ADMINISTRATORS_SID },
      { kind: "allow", type: 0, flags: OI_CI, mask: FULL, sid: SYSTEM_SID },
      { kind: "allow", type: 0, flags: 0, mask: SERVICE_TOP_RIGHTS, sid: SERVICE_SID },
      { kind: "allow", type: 0, flags: INSIDE_ONLY, mask: FULL, sid: SERVICE_SID },
    ]);
    expect(both(bytes)).toEqual(["accepted", "accepted"]);
    expect(SERVICE_TOP_RIGHTS).toBe(0x001200a7);
  });

  test("the installer's SDDL says the same", () => {
    expect(topShapeSddl(HUB_SERVICE_SID)).toBe(
      "O:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;;0x001200a7;;;S-1-5-80-382789279-1444082746-186061269-2257954938-261857140)(A;OICIIO;FA;;;S-1-5-80-382789279-1444082746-186061269-2257954938-261857140)",
    );
  });

  test("a service account that is not a SID makes no shape", () => {
    expect(topShape("nobody").isErr()).toBe(true);
  });
});
