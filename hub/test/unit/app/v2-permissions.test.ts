/**
 * Who may run each operation version 2 adds or changes (the coordinator's follow-up 2; m2-design.md
 * section 7, "People and permissions"; D13, D33), one table, every row: with user management off
 * every person may; with it on, a person whose role lacks manage system (as every person made
 * while it is on starts) is refused an operation the design marks manage system (MS), and one with
 * it is let through. A person with no `person_roles` row at all while it is on has every
 * permission: section 7 keeps every person there was when it was switched on "with every
 * permission until someone changes them", and `userManagement.set` writes their rows when it
 * switches on, so that person exists only in a database written otherwise; version 1's checks
 * read it the same way (`people/permissions.ts`). The phone's own operations ("own") are a
 * phone's whatever its role.
 */
import { describe, expect, test } from "bun:test";
import {
  APP_OPS_V2,
  type AppErrorV2,
  type AppOpNameV2,
  type AppOpV2,
  NEW_OPS_V2,
} from "@hsn/protocol/app";
import { type ClientId, clientId, type PersonId, personId } from "../../../src/core/model/ids.ts";
import { ClientKind } from "../../../src/core/model/rows.ts";
import { client, person, role } from "../people/support/hub.ts";
import { Disk, errorOf, PhoneHub, replyTo } from "./support/phone-hub.ts";

const UNAUTHORIZED_MS: AppErrorV2 = {
  code: "unauthorized",
  detail: { permission: "manageSystem" },
};
/** An Identity (§10): a siren, its chip, firmware 1.2.3, unpaired, a release build. */
const IDENTITY = `f10202a1b2c3d4e5f601020300${"00".repeat(8)}00`;

/** A body for every operation version 2 adds or changes. */
const BODIES: Readonly<Record<string, unknown>> = {
  "backup.keyHeld": { epoch: 99 },
  "pair.prepare": { identity: IDENTITY, name: "porch" },
  "pair.finish": { device: 77, result: "f10400" },
  "presence.set": { away: true },
  "push.register": {
    platform: "fcm",
    environment: "development",
    token: "token-1",
    keyId: "0011223344556677",
    key: "A".repeat(43),
  },
  "push.unregister": {},
  "push.test": {},
  "relay.status": {},
  "relay.set": { url: "wss://relay.example.org" },
  "update.offers": {},
  "update.fetch": { version: "9.9.9" },
  "firmware.list": {},
  "firmware.offers": {},
  "firmware.fetch": { version: "9.9.9" },
  "firmware.upload": { job: 1 },
  "firmware.remove": { image: 5 },
  "firmware.download": { image: 5 },
  "firmware.bluetooth": { device: 11 },
  "rollout.start": { image: 5 },
  "rollout.pause": { rollout: 1 },
  "rollout.resume": { rollout: 1 },
  "rollout.cancel": { rollout: 1 },
  "rollout.status": {},
  "site.wifi": { name: "home", password: "secret-words" },
  "backup.key": {},
};

/** The rows version 2 changes as well as those it adds (m3-design sections 4 and 5). */
const CHANGED_ROWS: readonly AppOpNameV2[] = ["site.wifi", "backup.key"];
const OPS: readonly AppOpNameV2[] = [...NEW_OPS_V2, ...CHANGED_ROWS];

/** Five people, each on a phone: one per way their permissions can stand. */
const OFF = personId(20);
const NO_ROW = personId(21);
const WITHOUT = personId(22);
const WITH = personId(23);
const MADE_WHILE_ON = personId(24);

function phoneOf(who: PersonId): ClientId {
  return clientId(who + 100);
}

function disk(on: boolean): Disk {
  const d = new Disk();
  d.people.userManagement = on;
  for (const who of [OFF, NO_ROW, WITHOUT, WITH, MADE_WHILE_ON]) {
    d.people.people.set(who, person(who, `p${who}`));
    d.people.clients.set(phoneOf(who), client(phoneOf(who), who, { kind: ClientKind.Phone }));
  }
  d.people.roles.set(WITHOUT, role(WITHOUT, true, false));
  d.people.roles.set(WITH, role(WITH, false, true));
  // As `person.create` makes a person while user management is on: no permission at all.
  d.people.roles.set(MADE_WHILE_ON, role(MADE_WHILE_ON, false, false));
  return d;
}

function asked(hub: PhoneHub, who: PersonId, name: AppOpNameV2): AppErrorV2 | undefined {
  const conn = hub.connect(phoneOf(who));
  const op = { op: name, body: BODIES[name] } as AppOpV2;
  return errorOf(replyTo(hub.request(conn, phoneOf(who), op).effects, conn)) as
    AppErrorV2 | undefined;
}

describe("every version 2 operation, by who asks", () => {
  test("the table has a body for every operation version 2 adds or changes, and no other", () => {
    expect(Object.keys(BODIES).toSorted()).toEqual([...OPS].toSorted());
  });

  test.each(OPS)("%s", (name) => {
    const ms = APP_OPS_V2[name].scope === "MS";
    // User management off: nobody is refused manage system (D13).
    const off = new PhoneHub(disk(false)).boot();
    expect(asked(off, OFF, name)).not.toEqual(UNAUTHORIZED_MS);
    const on = new PhoneHub(disk(true)).boot();
    const refusedWithout = asked(on, WITHOUT, name);
    const refusedNone = asked(on, MADE_WHILE_ON, name);
    const refusedWith = asked(on, WITH, name);
    const refusedNoRow = asked(on, NO_ROW, name);
    if (ms) {
      // `firmware.upload` is also console-only (C): refused either way on a phone.
      if (APP_OPS_V2[name].console)
        expect([JSON.stringify(UNAUTHORIZED_MS), `{"code":"consoleOnly","detail":{}}`]).toContain(
          JSON.stringify(refusedWithout),
        );
      else {
        expect(refusedWithout).toEqual(UNAUTHORIZED_MS);
        expect(refusedNone).toEqual(UNAUTHORIZED_MS);
      }
    } else {
      expect(refusedWithout).not.toEqual(UNAUTHORIZED_MS);
      expect(refusedNone).not.toEqual(UNAUTHORIZED_MS);
    }
    expect(refusedWith).not.toEqual(UNAUTHORIZED_MS);
    expect(refusedNoRow).not.toEqual(UNAUTHORIZED_MS);
  });
});
