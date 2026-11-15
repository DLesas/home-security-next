/**
 * Every event of the live stream is sent (m2-design.md section 5, "Every event of the live
 * stream, and what raises it"), on the whole hub: the loop running the real core with every
 * module over the real store, with scripted gateways, sensors and sirens (`test/world/home.ts`),
 * and sessions as the app channel gives them. For each of the 19, the test causes what the
 * design says raises it and requires the event to reach a subscribed session permitted to see it.
 *
 * `NOT_YET` names the exceptions, each with its owner and reason; it is empty when M2 is done
 * (`fileChunk` and `fileFailed` are the shell's export job's, not the core's: section 5 has them
 * tested in the shell, `shell-app/end-to-end.test.ts`).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { type AppEvent, type AppMessage, type AppOp, APP_OPS, TOPICS } from "@hsn/protocol/app";
import type { HubEvent } from "../../../src/core/model/events.ts";
import { type ClientId, clientId, type ConnId, connId } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot, FileOutcome } from "../../../src/core/model/events.ts";
import { BACKUP_STATE_DEFAULTS, UpdateResult } from "../../../src/core/model/rows.ts";
import { MODULES } from "../../../src/core/step.ts";
import { Home } from "../../world/home.ts";
import {
  ANNA,
  ANNA_LAPTOP as SUPPORT_ANNA_LAPTOP,
  CONSOLE_CLIENT,
  FACTS,
  household,
  Hub as SupportHub,
  repliesTo,
  role,
} from "../people/support/hub.ts";

/** Section 5's events, all 19. */
const EVENTS = [
  "arming",
  "countdown",
  "alarm",
  "door",
  "reading",
  "health",
  "device",
  "notification",
  "record",
  "config",
  "people",
  "site",
  "hub",
  "session",
  "ping",
  "forget",
  "backupKeyChanged",
  "fileChunk",
  "fileFailed",
] as const;

/** The shell's own events (section 5): sent by the channel, never by the core. */
const SHELLS: ReadonlySet<string> = new Set(["fileChunk", "fileFailed", "ping"]);

/**
 * The exceptions: event, owner, and why it is not sent here. When M2 is done it holds only the
 * shell's own events, `SHELLS`.
 */
const NOT_YET: Readonly<
  Partial<Record<(typeof EVENTS)[number], { readonly owner: string; readonly why: string }>>
> = {
  fileChunk: { owner: "step 0 owner", why: "the shell's export job, tested in shell-app" },
  fileFailed: { owner: "step 0 owner", why: "the shell's export job, tested in shell-app" },
  ping: { owner: "step 0 owner", why: "the shell's keepalive (section 5), tested in shell-app" },
};

const CONSOLE = clientId(1);
const ANNA_LAPTOP = clientId(7);
const ANNA_PHONE = clientId(8);
const ANNA_TABLET = clientId(10);
const BEN_LAPTOP = clientId(9);

let home: Home | undefined;
afterAll(() => {
  home?.close();
});

/** Anna (manage users and system), Ben (views door-1 only), their clients and the console. */
function people(store: NonNullable<Home["store"]>): void {
  {
    const door1 =
      store.db.query<{ id: number }, []>(`SELECT id FROM devices WHERE name = 'door-1'`).get()
        ?.id ?? 0;
    const at = 1_794_000_000_000;
    store.db.run(`INSERT INTO people VALUES (1, 'Anna', ?, NULL, 0), (2, 'Ben', ?, NULL, 0)`, [
      at,
      at,
    ]);
    store.db.run(`INSERT INTO person_roles VALUES (1, 1, 1, 0), (2, 0, 0, 0)`);
    store.db.run(`INSERT INTO permissions VALUES (2, ?, 0, 1)`, [door1]);
    store.db.run(`DELETE FROM people_settings`);
    store.db.run(`INSERT INTO people_settings VALUES (1)`);
    const client = (id: number, person: number | null, kind: number, name: string): void => {
      store.db.run(
        `INSERT INTO clients (id, person_id, static_key, kind, name, linked_by_client, created_ms, removed_ms, last_seq, last_seen_ms, backup_key_epoch) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL, ?)`,
        // Phones hold the backup key of the first start (epoch 1).
        [id, person, new Uint8Array(32).fill(id), kind, name, at, kind === 2 ? 1 : null],
      );
    };
    // The app key, as `ensureAppKeys` makes it at start (the snapshot's `hub.identity`).
    store.db.run(`UPDATE hub_keys SET app_static_public = ?`, [new Uint8Array(32).fill(0x42)]);
    client(CONSOLE, null, 0, "The hub computer");
    client(ANNA_LAPTOP, 1, 1, "Anna's laptop");
    client(ANNA_PHONE, 1, 2, "Anna's phone");
    client(ANNA_TABLET, 1, 2, "Anna's other phone");
    client(BEN_LAPTOP, 2, 1, "Ben's laptop");
  }
}

/** The events each connection got, from what the loop handed the app side. */
function eventsTo(h: Home, conn: ConnId): readonly AppEvent[] {
  return h.app.flatMap((e) => {
    if (e.kind !== "appSend" || e.conn !== conn) return [];
    const message: AppMessage = e.message;
    return "t" in message && message.t === "evt" ? [message] : [];
  });
}

describe("every event of the live stream reaches a session permitted to see it (section 5)", () => {
  test("each of the 19, from what the design says raises it", async () => {
    // A home of two doors, a siren and a gateway; its people added before the hub starts.
    home = await Home.create(
      { name: "events", sensors: 2, sirens: 1, gateways: 1, seed: 7 },
      people,
    );
    const hub = home;
    const step = (ms: number) => {
      expect(hub.advanceBy(ms * 1000).isOk()).toBe(true);
    };
    let conns = 1000;
    let ids = 0;
    const seqs = new Map<ClientId, number>();
    const session = (client: ClientId, listener: "lan" | "console" = "lan"): ConnId => {
      const conn = connId(conns++);
      hub.input({ kind: "clientConnected", conn, client, listener, proto: 1, app: "1.0.0" });
      request(conn, client, { op: "snapshot", body: {} });
      request(conn, client, { op: "subscribe", body: { topics: [...TOPICS] } });
      return conn;
    };
    const request = (conn: ConnId, client: ClientId, op: AppOp): void => {
      const seq = APP_OPS[op.op].change ? (seqs.get(client) ?? 0) + 1 : undefined;
      if (seq !== undefined) seqs.set(client, seq);
      const event: HubEvent = {
        kind: "clientRequest",
        conn,
        client,
        request: { id: ++ids, seq, op },
      };
      hub.input(event);
    };
    const door1 = hub.sensors.find((m) => m.row.name === "door-1");
    const door2 = hub.sensors.find((m) => m.row.name === "door-2");
    expect(door1).toBeDefined();

    // The shell's facts and time zone, before any client (section 2).
    hub.input({
      kind: "hubFacts",
      version: "0.1.0",
      addresses: ["192.168.1.20"],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    hub.input({ kind: "timeZone", zone: "Europe/London" });
    const console = session(CONSOLE, "console");
    const ben = session(BEN_LAPTOP);
    const laptop = session(ANNA_LAPTOP);
    const tablet = session(ANNA_TABLET);
    const quiet = connId(conns++);
    hub.input({
      kind: "clientConnected",
      conn: quiet,
      client: BEN_LAPTOP,
      listener: "lan",
      proto: 1,
      app: "1.0.0",
    });
    step(2000);

    // arming, notification, hub (the first change: no backup folder), countdown, alarm.
    request(console, CONSOLE, { op: "mode.switch", body: { mode: 1 } });
    step(5000);
    door1?.sensor.door(mono(hub.clock.now().mono), true);
    step(45_000);
    request(console, CONSOLE, { op: "mode.switch", body: { mode: 2 } });
    step(5000);
    // door: a door changed while disarmed.
    door1?.sensor.door(mono(hub.clock.now().mono), false);
    step(5000);
    // reading and health: a battery gone low, in the minutes of heartbeats that follow.
    if (door2 !== undefined) door2.sensor.batteryCode = 0;
    step(3 * 60_000);
    // device, config, people, site.
    request(console, CONSOLE, {
      op: "device.rename",
      body: { device: door2?.row.id ?? 0, name: "back-door" },
    });
    request(console, CONSOLE, {
      op: "group.create",
      body: { name: "Ground", sensors: [], sirens: "all" },
    });
    request(console, CONSOLE, { op: "person.create", body: { name: "Cleo" } });
    request(console, CONSOLE, { op: "site.set", body: { countdown: 20 } });
    // site: a site move started (`siteMove`), then cancelled.
    request(console, CONSOLE, { op: "site.change", body: { start: { channel: 2 } } });
    step(2000);
    request(console, CONSOLE, { op: "site.change", body: "cancel" });
    // forget: Ben's view of door-1 taken away.
    request(console, CONSOLE, {
      op: "permissions.set",
      body: { person: 2, devices: [], manageUsers: false, manageSystem: false, ifRevision: 0 },
    });
    // backupKeyChanged: a phone removed, so the key is replaced; Anna's other phone is told.
    request(console, CONSOLE, { op: "client.remove", body: { client: ANNA_PHONE, also: [] } });
    // session: Anna's laptop removed while its session is open.
    request(console, CONSOLE, { op: "client.remove", body: { client: ANNA_LAPTOP, also: [] } });
    // A quiet while: what the minute's heartbeats and timers bring.
    step(25_000);

    const sent = new Map<string, string>();
    for (const [who, conn] of [
      ["console", console],
      ["ben", ben],
      ["laptop", laptop],
      ["tablet", tablet],
      ["quiet", quiet],
    ] as const)
      for (const e of eventsTo(hub, conn)) if (!sent.has(e.ev)) sent.set(e.ev, who);
    const missing = EVENTS.filter((ev) => !sent.has(ev) && NOT_YET[ev] === undefined);
    for (const [ev, why] of Object.entries(NOT_YET))
      process.stdout.write(`not yet: ${ev} (${why.owner}): ${why.why}\n`);
    process.stdout.write(
      `events sent: ${[...sent].map(([ev, who]) => `${ev}→${who}`).join(", ")}\n`,
    );
    expect(missing).toEqual([]);
    // An exception that is sent after all leaves the list: it would hide a regression.
    expect(Object.keys(NOT_YET).filter((ev) => sent.has(ev) && !SHELLS.has(ev))).toEqual([]);
    // Ben, who may view door-1 only (until it was taken away), never saw door-2's events.
    const door2Id = door2?.row.id;
    expect(
      eventsTo(hub, ben).filter(
        (e) =>
          (e.ev === "door" && e.body.sensor === door2Id) ||
          (e.ev === "reading" && e.body.device === door2Id),
      ),
    ).toEqual([]);
    // And the event each was sent as, by whom.
    expect(sent.get("forget")).toBe("ben");
    expect(sent.get("session")).toBe("laptop");
    expect(sent.get("backupKeyChanged")).toBe("tablet");
  }, 120_000);
});

/** `hub.what`'s eight values (section 5, wave 2). */
const HUB_WHATS = [
  "updateStaged",
  "updateRefused",
  "updateSwitching",
  "backup",
  "databaseFailing",
  "databaseRecovered",
  "databaseSize",
  "historyShortened",
] as const;

/** The values not sent yet, each with its owner and reason. Empty when M2 is done. */
const HUB_NOT_YET: Readonly<
  Partial<Record<(typeof HUB_WHATS)[number], { readonly owner: string; readonly why: string }>>
> = {};

describe("every value of the hub event reaches the console (section 5, `hub.what`)", () => {
  test("each of the eight, from what the design says raises it", () => {
    const whats = new Set<string>();
    const take = (effects: readonly Effect[], conn: ConnId): void => {
      for (const e of effects)
        if (e.kind === "appSend" && e.conn === conn && "t" in e.message && e.message.t === "evt")
          if (e.message.ev === "hub") whats.add(e.message.body.what);
    };
    const subscribe = (hub: SupportHub, conn: ConnId): void => {
      hub.request(conn, CONSOLE_CLIENT, { op: "subscribe", body: { topics: [...TOPICS] } });
    };

    // The updates: a release staged, one refused, the switch approved.
    const hub = new SupportHub(MODULES);
    hub.boot(household({ userManagement: true, roles: [role(ANNA, true, true)] }));
    const conn = hub.connect(CONSOLE_CLIENT, "console");
    subscribe(hub, conn);
    const staged = (outcome: FileOutcome): void => {
      const { effects } = hub.request(conn, CONSOLE_CLIENT, {
        op: "update.upload",
        body: { job: 1 },
      });
      take(effects, conn);
      for (const e of effects)
        if (e.kind === "fileJob") take(hub.input({ kind: "fileReady", job: e.job, outcome }), conn);
    };
    staged({ kind: "failed", reason: "badFile", message: "not a release" });
    staged({ kind: "updateStaged", version: "9.9.9" });
    take(hub.request(conn, CONSOLE_CLIENT, { op: "update.approve", body: {} }).effects, conn);
    // The database: a failed commit, its recovery, a trim, the guard's state changing.
    for (const outcome of [
      { kind: "failed", message: "disk I/O error" },
      { kind: "recovered" },
      {
        kind: "trimmed",
        report: {
          routineRows: 10,
          eventRows: 2,
          oldestRoutineMs: 1,
          oldestEventMs: 1,
          inUseBytes: 1000,
        },
      },
      { kind: "trimEnded", inUseBytes: 900 },
    ] as const)
      take(hub.input({ kind: "commit", outcome }), conn);
    // A backup decision: the first change a backup would hold, with no folder chosen.
    take(
      hub.request(conn, CONSOLE_CLIENT, { op: "person.create", body: { name: "Dora" } }).effects,
      conn,
    );
    take(hub.advance(2 * 3_600_000_000), conn);

    for (const [what, why] of Object.entries(HUB_NOT_YET))
      process.stdout.write(`hub ${what} not yet (${why.owner}): ${why.why}\n`);
    process.stdout.write(`hub values sent: ${[...whats].join(", ")}\n`);
    expect(HUB_WHATS.filter((w) => !whats.has(w) && HUB_NOT_YET[w] === undefined)).toEqual([]);
    expect(Object.keys(HUB_NOT_YET).filter((w) => whats.has(w))).toEqual([]);
  });
});

/**
 * What comes before any session (section 5): a restore, an update's outcome. Each is a
 * notification, which waits until read: the first session after it, of a person with manage
 * system, has it in its snapshot; and `update.status` gives the outcome and when.
 */
describe("a restore and an update's outcome reach the first session after them (section 5)", () => {
  const boot = (m2: Partial<DurableSnapshot["m2"]>, version: string): SupportHub => {
    const hub = new SupportHub(MODULES);
    const snapshot = household({ userManagement: true, roles: [role(ANNA, true, true)] });
    hub.boot({ ...snapshot, m2: { ...snapshot.m2, ...m2 } }, 1, false);
    hub.input({ kind: "hubFacts", ...FACTS, version });
    hub.input({ kind: "timeZone", zone: "Europe/London" });
    return hub;
  };
  const switched = {
    updateState: {
      stagedVersion: "9.9.9",
      stagedMs: 1,
      approvedBy: "anna",
      approvedMs: 1,
      switchingMs: 1,
      previousVersion: "1.0.0",
      lastResult: UpdateResult.None,
      lastResultMs: null,
    },
  } as const;
  /** The kinds of the notifications Anna's first session finds in its snapshot. */
  const firstSession = (hub: SupportHub): readonly string[] => {
    const conn = hub.connect(SUPPORT_ANNA_LAPTOP);
    const { id, effects } = hub.request(conn, SUPPORT_ANNA_LAPTOP, { op: "snapshot", body: {} });
    const reply = repliesTo(effects, conn).find((r) => r.id === id);
    const body = reply?.ok === true ? (reply.body as { notifications?: { kind: string }[] }) : {};
    return (body.notifications ?? []).map((n) => n.kind);
  };
  const status = (hub: SupportHub): unknown => {
    const conn = hub.connect(CONSOLE_CLIENT, "console");
    const { id, effects } = hub.request(conn, CONSOLE_CLIENT, { op: "update.status", body: {} });
    const reply = repliesTo(effects, conn).find((r) => r.id === id);
    return reply?.ok === true ? reply.body : reply;
  };

  test("restored", () => {
    const hub = boot({ backupState: { ...BACKUP_STATE_DEFAULTS, restoredFromMs: 1 } }, "0.1.0");
    expect(firstSession(hub)).toContain("restored");
  });

  test("update_healthy, and update.status says healthy and when", () => {
    const hub = boot(switched, "9.9.9");
    expect(firstSession(hub)).toContain("update_healthy");
    expect(status(hub)).toMatchObject({ lastResult: "healthy", lastResultMs: hub.wall() });
  });

  test("update_rolled_back, and update.status says rolled back and when", () => {
    const hub = boot(switched, "1.0.0");
    expect(firstSession(hub)).toContain("update_rolled_back");
    expect(status(hub)).toMatchObject({ lastResult: "rolledBack", lastResultMs: hub.wall() });
  });
});
