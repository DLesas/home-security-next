/**
 * People, clients, permissions and their rules (m2-design.md section 7, "People and permissions";
 * D13, D33, D61): owner A3's step 1. Requests come in as an app's would, or from the hub computer.
 */
import { describe, expect, test } from "bun:test";
import { ClientKind } from "../../../src/core/model/rows.ts";
import { clientId, personId } from "../../../src/core/model/ids.ts";
import {
  personHasGlobal,
  personMayManage,
  personMayView,
} from "../../../src/core/people/permissions.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN,
  BEN_LAPTOP,
  bodyOf,
  client,
  closes,
  codeOf,
  Committed,
  CONSOLE_CLIENT,
  decisionsOf,
  FRONT,
  GARAGE,
  HALL_SIREN,
  household,
  Hub,
  linkSecrets,
  nowWrites,
  onlyReply,
  permission,
  person,
  role,
  WALL_AT_START,
  containsAll,
} from "./support/hub.ts";

function booted(h = household()): Hub {
  const hub = new Hub();
  hub.boot(h);
  return hub;
}

/** User management on: Anna manages users and system and the front door; Ben views the garage. */
function managed(): Hub {
  return booted(
    household({
      userManagement: true,
      roles: [role(ANNA, true, true), role(BEN, false, false)],
      permissions: [permission(ANNA, FRONT, true, false), permission(BEN, GARAGE, false, true)],
    }),
  );
}

describe("permissions (D13, D33)", () => {
  test("user management off: every person has every permission, whatever the rows say", () => {
    const hub = booted(
      household({
        roles: [role(BEN, false, false)],
        permissions: [permission(BEN, FRONT, false, false)],
      }),
    );
    const slice = hub.state.people;
    expect(personHasGlobal(slice, BEN, "manageUsers")).toBe(true);
    expect(personHasGlobal(slice, BEN, "manageSystem")).toBe(true);
    expect(personMayManage(slice, BEN, FRONT)).toBe(true);
    expect(personMayView(slice, BEN, GARAGE)).toBe(true);
  });

  test("user management on: the rows decide; manage includes view; no row is no permission", () => {
    const slice = managed().state.people;
    expect(personMayManage(slice, ANNA, FRONT)).toBe(true);
    expect(personMayView(slice, ANNA, FRONT)).toBe(true);
    expect(personMayView(slice, ANNA, GARAGE)).toBe(false);
    expect(personMayManage(slice, BEN, GARAGE)).toBe(false);
    expect(personMayView(slice, BEN, GARAGE)).toBe(true);
    expect(personHasGlobal(slice, BEN, "manageSystem")).toBe(false);
  });

  test("a removed person has no permission, user management off or on", () => {
    const hub = booted(
      household({ people: [person(1, "Anna"), person(2, "Ben", { removedMs: WALL_AT_START })] }),
    );
    const slice = hub.state.people;
    expect(personHasGlobal(slice, BEN, "manageUsers")).toBe(false);
    expect(personMayView(slice, BEN, FRONT)).toBe(false);
  });

  test("switching user management on keeps every existing person with every permission", () => {
    const hub = booted();
    const conn = hub.connect(BEN_LAPTOP);
    const { effects } = hub.request(conn, BEN_LAPTOP, {
      op: "userManagement.set",
      body: { on: true },
    });
    expect(codeOf(onlyReply(effects, conn))).toBe("ok");
    const slice = hub.state.people;
    expect(slice.userManagement).toBe(true);
    for (const who of [ANNA, BEN]) {
      expect(personHasGlobal(slice, who, "manageUsers")).toBe(true);
      expect(personHasGlobal(slice, who, "manageSystem")).toBe(true);
      expect(personMayManage(slice, who, FRONT)).toBe(true);
      expect(personMayManage(slice, who, GARAGE)).toBe(true);
    }
    // Written now, as rows, so a restart keeps them.
    const tables = nowWrites(effects).map((op) => op.table);
    expect(tables).toContain("people_settings");
    expect(tables.filter((t) => t === "person_roles")).toHaveLength(2);
    expect(decisionsOf(effects).map((d) => [d.row.kind, d.row.value, d.durability])).toContainEqual(
      ["user_management_changed", 1, "now"],
    );
  });

  test("switching it off keeps what was set, and on again applies it", () => {
    const hub = managed();
    const conn = hub.connect(ANNA_LAPTOP);
    hub.request(conn, ANNA_LAPTOP, { op: "userManagement.set", body: { on: false } });
    expect(personMayManage(hub.state.people, BEN, FRONT)).toBe(true);
    hub.request(conn, ANNA_LAPTOP, { op: "userManagement.set", body: { on: true } });
    expect(personMayManage(hub.state.people, BEN, FRONT)).toBe(false);
    expect(personMayView(hub.state.people, BEN, GARAGE)).toBe(true);
  });

  test("only someone with manage users may switch it", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    const reply = onlyReply(
      hub.request(conn, BEN_LAPTOP, { op: "userManagement.set", body: { on: false } }).effects,
      conn,
    );
    expect(reply.ok ? undefined : reply.error).toEqual({
      code: "unauthorized",
      detail: { permission: "manageUsers" },
    });
    expect(hub.state.people.userManagement).toBe(true);
  });
});

describe("people (section 7)", () => {
  test("person.create needs manage users, refuses a name in use, and is written now", () => {
    const hub = managed();
    const ben = hub.connect(BEN_LAPTOP);
    expect(
      codeOf(
        onlyReply(
          hub.request(ben, BEN_LAPTOP, { op: "person.create", body: { name: "Cleo" } }).effects,
          ben,
        ),
      ),
    ).toBe("unauthorized");
    const anna = hub.connect(ANNA_LAPTOP);
    const taken = onlyReply(
      hub.request(anna, ANNA_LAPTOP, { op: "person.create", body: { name: "Ben" } }).effects,
      anna,
    );
    expect(taken.ok ? undefined : taken.error).toEqual({
      code: "invalid",
      detail: { field: "name", reason: "taken" },
    });
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "person.create",
      body: { name: "Cleo" },
    });
    const reply = onlyReply(effects, anna);
    expect(bodyOf(reply)).toMatchObject({ id: 3, name: "Cleo", revision: 0 });
    expect(nowWrites(effects).map((op) => op.table)).toContain("people");
    expect(decisionsOf(effects).map((d) => d.row.kind)).toContain("person_added");
  });

  test("a new person while user management is on starts with no permission", () => {
    const hub = managed();
    const anna = hub.connect(ANNA_LAPTOP);
    hub.request(anna, ANNA_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    const cleo = personId(3);
    expect(personHasGlobal(hub.state.people, cleo, "manageUsers")).toBe(false);
    expect(personMayView(hub.state.people, cleo, FRONT)).toBe(false);
  });

  test("a removed person's name may be used again", () => {
    const hub = booted(
      household({ people: [person(1, "Anna"), person(2, "Ben", { removedMs: WALL_AT_START })] }),
    );
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, { op: "person.create", body: { name: "Ben" } }).effects,
      anna,
    );
    expect(codeOf(reply)).toBe("ok");
  });

  test("person.rename at an old revision is a conflict carrying the person as it is", () => {
    const hub = booted(
      household({ people: [person(1, "Anna"), person(2, "Ben", { revision: 3 })] }),
    );
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "person.rename",
        body: { person: 2, name: "Benjamin", ifRevision: 2 },
      }).effects,
      anna,
    );
    expect(reply.ok ? undefined : reply.error.code).toBe("conflict");
    expect(reply.ok ? undefined : reply.error.detail).toMatchObject({
      revision: 3,
      object: { id: 2, name: "Ben", revision: 3 },
    });
    const done = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "person.rename",
        body: { person: 2, name: "Benjamin", ifRevision: 3 },
      }).effects,
      anna,
    );
    expect(bodyOf(done)).toMatchObject({ name: "Benjamin", revision: 4 });
  });

  test("removing a person removes their clients and unused tokens in one commit; sessions close", () => {
    const hub = booted();
    const ben = hub.connect(BEN_LAPTOP);
    // Ben makes a code for another device of his own.
    hub.request(ben, BEN_LAPTOP, { op: "link.create", body: { kind: "ownDevice", form: "code" } });
    expect(hub.state.people.tokens.size).toBe(1);
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "person.remove",
      body: { person: 2, ifRevision: 0 },
    });
    expect(codeOf(onlyReply(effects, anna))).toBe("ok");
    expect(hub.state.people.people.get(BEN)?.removedMs).not.toBeNull();
    expect(hub.state.people.clients.get(BEN_LAPTOP)?.removedMs).not.toBeNull();
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(effects).map((s) => s.psk)).toEqual([null]);
    expect(closes(effects).map((c) => c.client)).toEqual([BEN_LAPTOP]);
    const kinds = decisionsOf(effects).map((d) => d.row.kind);
    expect(kinds).toContain("client_removed");
    expect(kinds).toContain("person_removed");
    // Everything in this step's commit is now.
    containsAll(
      nowWrites(effects).map((op) => op.table),
      ["clients", "link_tokens", "link_secrets", "people"],
    );
    // A request after the removal is refused, and its sessions close (section 7, "Awkward cases").
    const after = hub.request(ben, BEN_LAPTOP, { op: "clients.list", body: {} });
    expect(after.effects.filter((e) => e.kind === "appSend")).toEqual([]);
  });
});

describe("the last-administrator rule (section 7 ‡)", () => {
  test("manage users cannot be taken from its last holder while user management is on", () => {
    const hub = managed();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "permissions.set",
        body: { person: 1, devices: [], manageUsers: false, manageSystem: true, ifRevision: 0 },
      }).effects,
      anna,
    );
    expect(reply.ok ? undefined : reply.error).toEqual({
      code: "invalid",
      detail: { field: "manageUsers", reason: "lastManager" },
    });
    expect(personHasGlobal(hub.state.people, ANNA, "manageUsers")).toBe(true);
  });

  test("nor its last holder removed", () => {
    const hub = managed();
    const console = hub.connect(CONSOLE_CLIENT, "console");
    const reply = onlyReply(
      hub.request(console, CONSOLE_CLIENT, {
        op: "person.remove",
        body: { person: 1, ifRevision: 0 },
      }).effects,
      console,
    );
    expect(reply.ok ? undefined : reply.error).toEqual({
      code: "invalid",
      detail: { field: "person", reason: "lastManager" },
    });
  });

  test("with a second holder, or with user management off, both are allowed", () => {
    const hub = booted(
      household({ userManagement: true, roles: [role(ANNA, true, true), role(BEN, true, false)] }),
    );
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "permissions.set",
        body: { person: 1, devices: [], manageUsers: false, manageSystem: true, ifRevision: 0 },
      }).effects,
      anna,
    );
    expect(codeOf(reply)).toBe("ok");
    const off = booted();
    const conn = off.connect(ANNA_LAPTOP);
    expect(
      codeOf(
        onlyReply(
          off.request(conn, ANNA_LAPTOP, {
            op: "person.remove",
            body: { person: 2, ifRevision: 0 },
          }).effects,
          conn,
        ),
      ),
    ).toBe("ok");
  });
});

describe("permissions.set (D33)", () => {
  test("replaces the person's rows, raises the revision, and is written now", () => {
    const hub = managed();
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "permissions.set",
      body: {
        person: 2,
        devices: [{ device: FRONT, manage: true, view: true }],
        manageUsers: false,
        manageSystem: true,
        ifRevision: 0,
      },
    });
    expect(bodyOf(onlyReply(effects, anna))).toMatchObject({
      id: 2,
      manageSystem: true,
      devices: [{ device: FRONT, manage: true, view: true }],
      revision: 1,
    });
    const slice = hub.state.people;
    expect(personMayManage(slice, BEN, FRONT)).toBe(true);
    expect(personMayView(slice, BEN, GARAGE)).toBe(false);
    expect(nowWrites(effects)).toContainEqual({
      table: "permissions",
      op: "delete",
      key: { personId: BEN, deviceId: GARAGE },
    });
    expect(decisionsOf(effects).map((d) => d.row.kind)).toContain("permissions_changed");
  });

  test("a device that is not a sensor is refused, naming its place in the list", () => {
    const hub = managed();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "permissions.set",
        body: {
          person: 2,
          devices: [
            { device: FRONT, manage: true, view: true },
            { device: HALL_SIREN, manage: true, view: true },
          ],
          manageUsers: false,
          manageSystem: false,
          ifRevision: 0,
        },
      }).effects,
      anna,
    );
    expect(reply.ok ? undefined : reply.error).toEqual({
      code: "invalid",
      detail: { field: "devices.1.device", reason: "unknownReference" },
    });
  });

  test("people.list shows everyone to manage users, and only oneself to anyone else", () => {
    const hub = managed();
    const ben = hub.connect(BEN_LAPTOP);
    const own = bodyOf(
      onlyReply(hub.request(ben, BEN_LAPTOP, { op: "people.list", body: {} }).effects, ben),
    );
    expect((own.people as { id: number }[]).map((p) => p.id)).toEqual([2]);
    expect((own.clients as { id: number }[]).map((c) => c.id)).toEqual([9]);
    const anna = hub.connect(ANNA_LAPTOP);
    const all = bodyOf(
      onlyReply(hub.request(anna, ANNA_LAPTOP, { op: "people.list", body: {} }).effects, anna),
    );
    expect((all.people as { id: number }[]).map((p) => p.id)).toEqual([1, 2]);
    expect((all.clients as { id: number }[]).map((c) => c.id)).toEqual([1, 7, 8, 9]);
  });
});

describe('clients (section 7, "A lost device")', () => {
  /** Anna's phone (8) linked Anna's tablet (10) a day ago and an old laptop (11) 40 days ago. */
  function withLinked(): Hub {
    const day = 86_400_000;
    return booted(
      household({
        userManagement: true,
        roles: [role(ANNA, false, false), role(BEN, true, false)],
        clients: [
          client(1, null),
          client(7, 1),
          client(8, 1, { kind: ClientKind.Phone }),
          client(9, 2),
          client(10, 1, { linkedByClient: ANNA_PHONE, createdMs: WALL_AT_START - day }),
          client(11, 1, { linkedByClient: ANNA_PHONE, createdMs: WALL_AT_START - 40 * day }),
        ],
      }),
    );
  }

  test("one's own client may be removed with the clients it linked in the last 30 days", () => {
    const hub = withLinked();
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "client.remove",
      body: { client: ANNA_PHONE, also: [10] },
    });
    expect(codeOf(onlyReply(effects, anna))).toBe("ok");
    expect(closes(effects).map((c) => c.client)).toEqual([ANNA_PHONE, clientId(10)]);
    expect(hub.state.people.clients.get(ANNA_LAPTOP)?.removedMs).toBeNull();
  });

  test("`also` linked more than 30 days ago is tooOld; not linked by it is unknownReference", () => {
    const hub = withLinked();
    const anna = hub.connect(ANNA_LAPTOP);
    const old = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "client.remove",
        body: { client: ANNA_PHONE, also: [11] },
      }).effects,
      anna,
    );
    expect(old.ok ? undefined : old.error).toEqual({
      code: "invalid",
      detail: { field: "also.0", reason: "tooOld" },
    });
    const stranger = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "client.remove",
        body: { client: ANNA_PHONE, also: [9] },
      }).effects,
      anna,
    );
    expect(stranger.ok ? undefined : stranger.error.detail).toEqual({
      field: "also.0",
      reason: "unknownReference",
    });
    // Nothing was removed by either.
    expect(hub.state.people.clients.get(ANNA_PHONE)?.removedMs).toBeNull();
  });

  test("another person's client needs manage users", () => {
    const hub = withLinked();
    const anna = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(anna, ANNA_LAPTOP, {
        op: "client.remove",
        body: { client: BEN_LAPTOP, also: [] },
      }).effects,
      anna,
    );
    expect(codeOf(reply)).toBe("unauthorized");
    const ben = hub.connect(BEN_LAPTOP);
    const byManager = onlyReply(
      hub.request(ben, BEN_LAPTOP, {
        op: "client.remove",
        body: { client: ANNA_PHONE, also: [10] },
      }).effects,
      ben,
    );
    expect(codeOf(byManager)).toBe("ok");
  });

  test("removing a client voids every unused token it made", () => {
    const hub = booted();
    const phone = hub.connect(ANNA_PHONE);
    hub.request(phone, ANNA_PHONE, {
      op: "link.create",
      body: { kind: "ownDevice", form: "code" },
    });
    expect(hub.state.people.tokens.size).toBe(1);
    const laptop = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(laptop, ANNA_LAPTOP, {
      op: "client.remove",
      body: { client: ANNA_PHONE, also: [] },
    });
    expect(hub.state.people.tokens.size).toBe(0);
    expect(linkSecrets(effects).map((s) => s.psk)).toEqual([null]);
  });

  test("client.rename: one's own, or with manage users", () => {
    const hub = withLinked();
    const anna = hub.connect(ANNA_LAPTOP);
    expect(
      codeOf(
        onlyReply(
          hub.request(anna, ANNA_LAPTOP, {
            op: "client.rename",
            body: { client: 10, name: "Tablet" },
          }).effects,
          anna,
        ),
      ),
    ).toBe("ok");
    expect(
      codeOf(
        onlyReply(
          hub.request(anna, ANNA_LAPTOP, { op: "client.rename", body: { client: 9, name: "Mine" } })
            .effects,
          anna,
        ),
      ),
    ).toBe("unauthorized");
  });

  test("a restart reads back what was written: removed stays removed", () => {
    const hub = booted();
    const committed = new Committed(household());
    const anna = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(anna, ANNA_LAPTOP, {
      op: "client.remove",
      body: { client: BEN_LAPTOP, also: [] },
    });
    committed.apply(effects);
    const again = new Hub();
    again.boot(committed.snapshot(), 2);
    expect(again.state.people.clients.get(BEN_LAPTOP)?.removedMs).not.toBeNull();
  });
});

describe("renaming is a decision (section 4)", () => {
  test("person_renamed and client_renamed, written now, with the old and new names", () => {
    const hub = booted();
    const anna = hub.connect(ANNA_LAPTOP);
    const person = hub.request(anna, ANNA_LAPTOP, {
      op: "person.rename",
      body: { person: 2, name: "Benjamin", ifRevision: 0 },
    });
    const client = hub.request(anna, ANNA_LAPTOP, {
      op: "client.rename",
      body: { client: 9, name: "Ben's desk" },
    });
    const of = (effects: Parameters<typeof decisionsOf>[0]) =>
      decisionsOf(effects).map((d) => [
        d.row.kind,
        d.durability,
        d.row.value,
        JSON.parse(new TextDecoder().decode(d.row.detail ?? new Uint8Array())) as unknown,
      ]);
    expect(of(person.effects)).toEqual([
      ["person_renamed", "now", 2, { from: "Ben", to: "Benjamin", by: "Anna (client 7)" }],
    ]);
    expect(of(client.effects)).toEqual([
      ["client_renamed", "now", 9, { from: "client-9", to: "Ben's desk", by: "Anna (client 7)" }],
    ]);
  });
});

describe("a removed person or client is not acted on again (section 7)", () => {
  test("renaming, changing or removing a removed person is notFound", () => {
    const hub = booted(
      household({ people: [person(1, "Anna"), person(2, "Ben", { removedMs: WALL_AT_START })] }),
    );
    const anna = hub.connect(ANNA_LAPTOP);
    for (const op of [
      { op: "person.rename", body: { person: 2, name: "Benjamin", ifRevision: 0 } },
      { op: "person.remove", body: { person: 2, ifRevision: 0 } },
      {
        op: "permissions.set",
        body: { person: 2, devices: [], manageUsers: false, manageSystem: false, ifRevision: 0 },
      },
    ] as const) {
      const reply = onlyReply(hub.request(anna, ANNA_LAPTOP, op).effects, anna);
      expect([op.op, reply.ok ? undefined : reply.error]).toEqual([
        op.op,
        { code: "notFound", detail: { what: "person", id: 2 } },
      ]);
    }
    expect(hub.state.people.people.get(BEN)?.name).toBe("Ben");
  });

  test("renaming or removing a removed client is notFound", () => {
    const hub = booted(
      household({
        clients: [client(1, null), client(7, 1), client(9, 2, { removedMs: WALL_AT_START })],
      }),
    );
    const anna = hub.connect(ANNA_LAPTOP);
    for (const op of [
      { op: "client.rename", body: { client: 9, name: "Again" } },
      { op: "client.remove", body: { client: 9, also: [] } },
    ] as const) {
      const reply = onlyReply(hub.request(anna, ANNA_LAPTOP, op).effects, anna);
      expect([op.op, reply.ok ? undefined : reply.error]).toEqual([
        op.op,
        { code: "notFound", detail: { what: "client", id: 9 } },
      ]);
    }
    expect(hub.state.people.clients.get(BEN_LAPTOP)?.name).toBe("client-9");
  });
});
