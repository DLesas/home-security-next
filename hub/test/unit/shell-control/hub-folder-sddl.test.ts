/**
 * The installer and the checker cannot drift apart (m2-design.md section 9, "The top folders"):
 * `hub/packaging/windows/hub-folder.sddl` is the list A8's installer sets on each top folder
 * (`tree.ps1` reads it, `build-msi.ps1` refuses to build without it). It is read here as SDDL,
 * by a small reader of its own (not the hub's code), into the bytes Windows would hold, and the
 * hub's checker must accept exactly that, refuse it with any one right more on any entry, and
 * find it the same as the shape the hub itself sets.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADMINISTRATORS_SID,
  checkTopFolder,
  FILE_ALL_ACCESS,
  HUB_SERVICE_SID,
  SYSTEM_SID,
  topShape,
  topShapeSddl,
} from "../../../src/shell/control/windows-acl.ts";
import { type AceSpec, descriptorBytes } from "./windows-data.ts";

const FILE = join(import.meta.dir, "..", "..", "..", "packaging", "windows", "hub-folder.sddl");
const ALIASES: Readonly<Record<string, string>> = { BA: ADMINISTRATORS_SID, SY: SYSTEM_SID };
const FLAGS: Readonly<Record<string, number>> = {
  OI: 0x01,
  CI: 0x02,
  NP: 0x04,
  IO: 0x08,
  ID: 0x10,
};

interface Read {
  readonly owner: string;
  readonly protectedList: boolean;
  readonly aces: readonly AceSpec[];
}

const sidOf = (text: string): string | undefined =>
  ALIASES[text] ?? (/^S-1-\d+(-\d+)+$/u.test(text) ? text : undefined);

/** The SDDL this file uses (an owner, a list, allow entries), or why not. */
function readSddl(sddl: string): Read | string {
  const whole = /^O:([A-Z]{2}|S-[0-9-]+)D:(P?)((?:\([^()]*\))+)$/u.exec(sddl);
  if (whole === null) return `not the SDDL this reader knows: ${sddl}`;
  const owner = sidOf(whole[1] ?? "");
  if (owner === undefined) return `an owner this reader does not know: ${whole[1]}`;
  const aces: AceSpec[] = [];
  for (const [, body = ""] of (whole[3] ?? "").matchAll(/\(([^()]*)\)/gu)) {
    const [type, flags = "", rights = "", object = "", inherited = "", who = ""] = body.split(";");
    if (type !== "A" || object !== "" || inherited !== "")
      return `an entry this reader does not know: ${body}`;
    let flagBits = 0;
    for (const pair of flags.match(/../gu) ?? []) {
      const bit = FLAGS[pair];
      if (bit === undefined) return `a flag this reader does not know: ${pair}`;
      flagBits |= bit;
    }
    const mask =
      rights === "FA"
        ? FILE_ALL_ACCESS
        : /^0x[0-9a-f]+$/iu.test(rights)
          ? Number.parseInt(rights, 16)
          : undefined;
    const sid = sidOf(who);
    if (mask === undefined || sid === undefined)
      return `rights or an account this reader does not know: ${body}`;
    aces.push({ kind: "allow", sid, flags: flagBits, mask });
  }
  return { owner, protectedList: whole[2] === "P", aces };
}

function bytesOf(read: Read): Uint8Array {
  return descriptorBytes({
    owner: read.owner,
    dacl: read.aces,
    ...(read.protectedList ? {} : { control: 0x8004 }),
  });
}

const sddl = readFileSync(FILE, "utf8").trim();
const read = readSddl(sddl);

describe("hub-folder.sddl, the installer's list, against the hub's checker", () => {
  test("it reads, and is the SDDL the checker's shape writes", () => {
    expect(typeof read === "string" ? read : "read").toBe("read");
    expect(sddl).toBe(topShapeSddl(HUB_SERVICE_SID));
  });

  test("the checker accepts exactly what it holds, as the service and by hand, and it is the shape the hub sets", () => {
    if (typeof read === "string") return;
    const bytes = bytesOf(read);
    expect(checkTopFolder(bytes, HUB_SERVICE_SID, "service").isOk()).toBe(true);
    expect(checkTopFolder(bytes, HUB_SERVICE_SID, "administrator").isOk()).toBe(true);
    expect([...bytes]).toEqual([...topShape(HUB_SERVICE_SID)._unsafeUnwrap()]);
  });

  test("with any one right more on any of its entries, the checker refuses it", () => {
    if (typeof read === "string") return;
    let tried = 0;
    read.aces.forEach((ace, index) => {
      for (let bit = 0; bit < 32; bit++) {
        const right = 2 ** bit;
        const mask = ace.mask ?? 0;
        if ((mask & right) !== 0) continue;
        const more = read.aces.map((a, i) =>
          i === index ? { ...a, mask: (mask | right) >>> 0 } : a,
        );
        const checked = checkTopFolder(
          bytesOf({ ...read, aces: more }),
          HUB_SERVICE_SID,
          "service",
        );
        expect(`${index} +${right.toString(16)}: ${checked.isOk() ? "accepted" : "refused"}`).toBe(
          `${index} +${right.toString(16)}: refused`,
        );
        tried += 1;
      }
    });
    expect(tried).toBeGreaterThan(20);
  });

  test("without protection, owned by the service, or with an entry for Users added, the checker refuses it", () => {
    if (typeof read === "string") return;
    for (const changed of [
      { ...read, protectedList: false },
      { ...read, owner: HUB_SERVICE_SID },
      {
        ...read,
        aces: [
          ...read.aces,
          { kind: "allow" as const, sid: "S-1-5-32-545", flags: 3, mask: 0x1200a9 },
        ],
      },
    ])
      expect(checkTopFolder(bytesOf(changed), HUB_SERVICE_SID, "service").isErr()).toBe(true);
  });
});
