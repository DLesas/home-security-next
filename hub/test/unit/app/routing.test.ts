/**
 * Request routing in `app` (m2-design.md sections 2, 3, 5 and 6): every operation checked on the
 * hub, the `seq` rule with stored replies for a retried request, and the requests numbered from
 * 2⁴⁰ towards M1a's modules. Owner A3's step 3.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { APP_REQUEST_BASE, connId, isAppRequest } from "../../../src/core/model/ids.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import { MODULES } from "../../../src/core/step.ts";
import {
  ANNA,
  ANNA_LAPTOP,
  BEN,
  BEN_LAPTOP,
  bodyOf,
  closes,
  codeOf,
  commandRows,
  Committed,
  CONSOLE_CLIENT,
  FRONT,
  GARAGE,
  HALL_SIREN,
  household,
  Hub,
  nowWrites,
  onlyReply,
  permission,
  repliesTo,
  rowWritten,
  role,
  testModules,
  writesTo,
} from "../people/support/hub.ts";

function booted(h = household()): Hub {
  const hub = new Hub();
  hub.boot(h);
  return hub;
}

function managed(): Hub {
  return booted(
    household({
      userManagement: true,
      roles: [role(ANNA, true, true), role(BEN, false, false)],
      permissions: [permission(BEN, FRONT, true, true), permission(BEN, GARAGE, false, true)],
    }),
  );
}

describe("the seq rule (section 5)", () => {
  test("a change is answered in the step that commits it with its seq, reply and record, all now", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const { effects, seq } = hub.request(conn, ANNA_LAPTOP, {
      op: "person.create",
      body: { name: "Cleo" },
    });
    expect(codeOf(onlyReply(effects, conn))).toBe("ok");
    const now = effects.filter((e) => e.kind === "write" && e.durability === "now");
    expect(rowWritten(now, "clients", { id: ANNA_LAPTOP, lastSeq: seq })).toBeDefined();
    expect(rowWritten(now, "client_replies", { clientId: ANNA_LAPTOP, seq })).toBeDefined();
    expect(nowWrites(effects).length).toBeGreaterThan(2);
    const commands = commandRows(effects);
    expect(commands.map((c) => [c.durability, c.row.actor, c.row.kind, c.row.outcome])).toEqual([
      ["now", "Anna (client 7)", "person.create", "ok"],
    ]);
  });

  test("a retry with the same seq gets the kept reply marked repeat, and nothing is done again", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    const people = hub.state.people.people.size;
    const retry = hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "person.create", body: { name: "Cleo" } },
      { seq: first.seq ?? 0 },
    );
    const reply = onlyReply(retry.effects, conn);
    expect(reply).toEqual({ ...onlyReply(first.effects, conn), id: retry.id, repeat: true });
    expect(hub.state.people.people.size).toBe(people);
    expect(nowWrites(retry.effects)).toEqual([]);
  });

  test("the kept reply survives a restart: a retry after it is still answered once", () => {
    const committed = new Committed(household());
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    committed.apply(first.effects);
    const again = new Hub();
    again.boot(committed.snapshot(), 2);
    const conn2 = again.connect(ANNA_LAPTOP);
    const retry = again.request(
      conn2,
      ANNA_LAPTOP,
      { op: "person.create", body: { name: "Cleo" } },
      { seq: first.seq ?? 0 },
    );
    const reply = onlyReply(retry.effects, conn2);
    expect(reply.repeat).toBe(true);
    expect(bodyOf(reply)).toMatchObject({ name: "Cleo" });
    expect(again.state.people.people.size).toBe(3);
  });

  test("an old seq whose reply is no longer kept is seqTooLow {last}, and nothing is done", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, {
      op: "client.rename",
      body: { client: 7, name: "a" },
    });
    for (let i = 0; i < 16; i++)
      hub.request(conn, ANNA_LAPTOP, { op: "client.rename", body: { client: 7, name: `n${i}` } });
    const replay = hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "client.rename", body: { client: 7, name: "a" } },
      { seq: first.seq ?? 0 },
    );
    expect(onlyReply(replay.effects, conn)).toMatchObject({
      ok: false,
      error: { code: "seqTooLow", detail: { last: 17 } },
    });
    expect(hub.state.people.clients.get(ANNA_LAPTOP)?.name).toBe("n15");
    // Only the last 16 are kept; the oldest was deleted in the commit that made the 17th.
    expect(hub.state.people.replies.get(ANNA_LAPTOP)?.size).toBe(16);
  });

  test("a refusal of a new seq is kept as its reply too: a retry is refused the same way", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    const first = hub.request(conn, BEN_LAPTOP, { op: "person.create", body: { name: "Cleo" } });
    expect(codeOf(onlyReply(first.effects, conn))).toBe("unauthorized");
    const retry = hub.request(
      conn,
      BEN_LAPTOP,
      { op: "person.create", body: { name: "Cleo" } },
      { seq: first.seq ?? 0 },
    );
    expect(onlyReply(retry.effects, conn)).toMatchObject({ ok: false, repeat: true });
  });

  test("a change from a client that is not linked is refused and its sessions closed", () => {
    const hub = booted();
    const conn = hub.connect(BEN_LAPTOP);
    const anna = hub.connect(ANNA_LAPTOP);
    hub.request(anna, ANNA_LAPTOP, { op: "person.remove", body: { person: 2, ifRevision: 0 } });
    // The session was closed by the removal; a request still on the wire finds no session.
    const late = hub.input({
      kind: "clientRequest",
      conn,
      client: BEN_LAPTOP,
      request: { id: 5, seq: 9, op: { op: "clients.list", body: {} } },
    });
    expect(repliesTo(late, conn)).toEqual([]);
  });
  test("a request from a client no longer linked is refused unauthorized, and its sessions closed", () => {
    const hub = booted();
    const conn = hub.connect(BEN_LAPTOP);
    // Ben's client removed in a state the session outlived (the request was already queued).
    const clients = new Map(hub.state.people.clients);
    const row = clients.get(BEN_LAPTOP);
    if (row !== undefined) clients.set(BEN_LAPTOP, { ...row, removedMs: 1 });
    hub.state = { ...hub.state, people: { ...hub.state.people, clients } };
    const { effects } = hub.request(conn, BEN_LAPTOP, { op: "clients.list", body: {} });
    expect(onlyReply(effects, conn)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(closes(effects).map((c) => c.client)).toEqual([BEN_LAPTOP]);
  });
});

describe("permissions checked on the hub (section 6)", () => {
  test("manage system: a person without it is refused before the owner sees it", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    const { effects } = hub.request(conn, BEN_LAPTOP, {
      op: "group.create",
      body: { name: "Ground", sensors: [FRONT], sirens: "all" },
    });
    expect(onlyReply(effects, conn)).toMatchObject({
      ok: false,
      error: { code: "unauthorized", detail: { permission: "manageSystem" } },
    });
    expect(effects.some((e) => (e as unknown as Internal).kind === "opRequest")).toBe(false);
  });

  test("with manage system it goes on to its owner (layout, a stand-in here)", () => {
    const hub = managed();
    const conn = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(conn, ANNA_LAPTOP, {
      op: "group.create",
      body: { name: "Ground", sensors: [FRONT], sirens: "all" },
    });
    expect(codeOf(onlyReply(effects, conn))).toBe("notBuilt");
  });

  test("an operation only the console may make is consoleOnly on the home network's listener", () => {
    const hub = booted();
    const lan = hub.connect(ANNA_LAPTOP);
    expect(
      onlyReply(
        hub.request(lan, ANNA_LAPTOP, { op: "usb.erase", body: { port: "/dev/x" } }).effects,
        lan,
      ),
    ).toMatchObject({ ok: false, error: { code: "consoleOnly" } });
    const console = hub.connect(CONSOLE_CLIENT, "console");
    expect(
      onlyReply(
        hub.request(console, CONSOLE_CLIENT, { op: "usb.erase", body: { port: "/dev/x" } }).effects,
        console,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid", detail: { field: "port" } } });
  });

  test("HB5a: arming a sensor needs manage on it, naming those it lacks", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    expect(
      onlyReply(
        hub.request(conn, BEN_LAPTOP, { op: "arm", body: { target: { sensor: GARAGE } } }).effects,
        conn,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized", detail: { devices: [GARAGE] } } });
    // With manage it reaches layout (a stand-in).
    expect(
      codeOf(
        onlyReply(
          hub.request(conn, BEN_LAPTOP, { op: "arm", body: { target: { sensor: FRONT } } }).effects,
          conn,
        ),
      ),
    ).toBe("notBuilt");
    // "mine" needs none.
    expect(
      codeOf(
        onlyReply(
          hub.request(conn, BEN_LAPTOP, { op: "disarm", body: { target: "mine" } }).effects,
          conn,
        ),
      ),
    ).toBe("notBuilt");
  });

  test("HB5a for a mode: layout says which sensors the switch changes; each needs manage", () => {
    const hub = new Hub(testModules({ layout: MODULES.layout }));
    hub.boot(
      household({
        userManagement: true,
        roles: [role(ANNA, true, true), role(BEN, false, false)],
        permissions: [permission(BEN, FRONT, true, true), permission(BEN, GARAGE, false, true)],
      }),
    );
    const conn = hub.connect(BEN_LAPTOP);
    expect(
      onlyReply(
        hub.request(conn, BEN_LAPTOP, { op: "mode.switch", body: { mode: 1 } }).effects,
        conn,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized", detail: { devices: [GARAGE] } } });
  });

  test("sensor.settings: manage the sensor for its countdown, manage system for its reply rate", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    expect(
      onlyReply(
        hub.request(conn, BEN_LAPTOP, {
          op: "sensor.settings",
          body: { sensor: FRONT, replyRate: 3 },
        }).effects,
        conn,
      ),
    ).toMatchObject({ ok: false, error: { detail: { permission: "manageSystem" } } });
    expect(
      onlyReply(
        hub.request(conn, BEN_LAPTOP, {
          op: "sensor.settings",
          body: { sensor: GARAGE, countdown: 20 },
        }).effects,
        conn,
      ),
    ).toMatchObject({ ok: false, error: { detail: { devices: [GARAGE] } } });
  });

  test("device.show of a sensor one may not view is unauthorized; sirens are anyone's", () => {
    const hub = booted(
      household({ userManagement: true, roles: [role(ANNA, true, true), role(BEN, false, false)] }),
    );
    const conn = hub.connect(BEN_LAPTOP);
    expect(
      codeOf(
        onlyReply(
          hub.request(conn, BEN_LAPTOP, { op: "device.show", body: { device: FRONT } }).effects,
          conn,
        ),
      ),
    ).toBe("unauthorized");
    expect(
      bodyOf(
        onlyReply(
          hub.request(conn, BEN_LAPTOP, { op: "device.show", body: { device: HALL_SIREN } })
            .effects,
          conn,
        ),
      ),
      // `device.show` replies `{device, settings}` (step 1, wave 2).
    ).toMatchObject({ device: { id: HALL_SIREN, role: "siren" }, settings: { version: 1 } });
  });

  test("history.query goes to the shell with what the person may see", () => {
    const hub = managed();
    const conn = hub.connect(BEN_LAPTOP);
    const { effects } = hub.request(conn, BEN_LAPTOP, { op: "history.query", body: { limit: 50 } });
    const read = effects.find((e) => e.kind === "historyRead");
    expect(read).toMatchObject({
      kind: "historyRead",
      conn,
      allowed: {
        devices: [FRONT, GARAGE, HALL_SIREN],
        person: BEN,
        clients: [BEN_LAPTOP],
        hub: false,
      },
    });
  });
});

describe("requests for M1a's modules (section 2)", () => {
  test("numbered from 2⁴⁰, sent as the module's own request; its answer becomes the reply", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const { effects } = hub.request(conn, ANNA_LAPTOP, {
      op: "device.rename",
      body: { device: FRONT, name: "porch" },
    });
    const reply = onlyReply(effects, conn);
    expect(bodyOf(reply)).toMatchObject({ id: FRONT, name: "porch", role: "sensor" });
    expect(hub.state.registry.devices.get(FRONT)?.name).toBe("porch");
    expect(commandRows(effects).map((c) => [c.row.kind, c.row.outcome])).toEqual([
      ["device.rename", "ok"],
    ]);
  });

  test("a module's refusal becomes section 5's error", () => {
    const hub = booted();
    const conn = hub.connect(ANNA_LAPTOP);
    const reply = onlyReply(
      hub.request(conn, ANNA_LAPTOP, {
        op: "device.rename",
        body: { device: FRONT, name: "garage" },
      }).effects,
      conn,
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "name", reason: "taken" } },
    });
  });

  test("an answer that comes in a later step: the seq is committed in the request's step, a retry meanwhile answered when it comes", () => {
    // Registry, its answers to app's requests held back until the next tick.
    let held: Internal[] = [];
    const real = MODULES.registry.handle;
    const delayed: Handler<"registry"> = (slice, message, ctx) => {
      if (message.kind === "tick" && held.length > 0) {
        const out = held;
        held = [];
        return ok({ slice, out });
      }
      return real(slice, message, ctx).map((handled) => {
        const answers = handled.out.filter(
          (m) =>
            (m as Internal).kind === "answer" &&
            isAppRequest((m as Extract<Internal, { kind: "answer" }>).request),
        );
        held.push(...(answers as Internal[]));
        return { slice: handled.slice, out: handled.out.filter((m) => !answers.includes(m)) };
      });
    };
    const hub = new Hub(testModules({ registry: { ...MODULES.registry, handle: delayed } }));
    hub.boot(household());
    const conn = hub.connect(ANNA_LAPTOP);
    const first = hub.request(conn, ANNA_LAPTOP, {
      op: "device.rename",
      body: { device: FRONT, name: "porch" },
    });
    expect(repliesTo(first.effects, conn)).toEqual([]);
    // The seq is committed now, with the request.
    expect(rowWritten(first.effects, "clients", { lastSeq: first.seq })).toBeDefined();
    const sent = first.effects.find(
      (e) => (e as unknown as Internal).kind === "deviceRenameRequest",
    );
    expect(sent).toBeUndefined();
    expect([...hub.state.app.m1a.keys()].every((r) => r >= APP_REQUEST_BASE)).toBe(true);
    const retry = hub.request(
      conn,
      ANNA_LAPTOP,
      { op: "device.rename", body: { device: FRONT, name: "porch" } },
      { seq: first.seq ?? 0 },
    );
    expect(repliesTo(retry.effects, conn)).toEqual([]);
    const answered = hub.input({ kind: "tick" });
    const replies = repliesTo(answered, conn);
    expect(replies.map((r) => [r.id, r.ok, r.repeat ?? false])).toEqual([
      [first.id, true, false],
      [retry.id, true, true],
    ]);
    expect(writesTo(answered, "client_replies")).toHaveLength(1);
  });
});

describe("sessions (section 5)", () => {
  test("a console client is accepted only on the console listener", () => {
    const hub = booted();
    const effects = hub.input({
      kind: "clientConnected",
      conn: connId(5),
      client: CONSOLE_CLIENT,
      listener: "lan",
      proto: 1,
      app: "1",
    });
    expect(closes(effects).map((c) => c.client)).toEqual([CONSOLE_CLIENT]);
    expect(hub.state.app.sessions.size).toBe(0);
  });

  test("an unknown client gets no session", () => {
    const hub = booted();
    const effects = hub.input({
      kind: "clientConnected",
      conn: connId(5),
      client: 77 as never,
      listener: "lan",
      proto: 1,
      app: "1",
    });
    expect(closes(effects)).toHaveLength(1);
  });
});
