/**
 * What the health and notify modules add to a day's rows and commits (hub-design.md section 5,
 * "Budget"; m2-design.md section 3), for homes A, B and C, counted on the two handlers: section 5's
 * day (heartbeats, siren reports, 20 door changes a sensor, two countdowns disarmed in time, four
 * mode switches) with section 3's household (4 people, 6 clients, every client connected all day
 * and reading every notification it is given). The budget's owner adds these to the whole hub's
 * day (hub/test/budget/); this test only says what these two modules write, and that neither
 * causes a commit of its own.
 */
import { describe, expect, test } from "bun:test";
import { Role } from "@hsn/protocol";
import { handleHealth } from "../../../src/core/health/handle.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  type ClientId,
  clientId,
  connId,
  type DeviceId,
  deviceId,
  personId,
  type Seq,
} from "../../../src/core/model/ids.ts";
import type { Actor, Internal } from "../../../src/core/model/messages.ts";
import { ArmState, ClientKind, DeviceState, type DeviceRow } from "../../../src/core/model/rows.ts";
import type { Durability } from "../../../src/core/model/store.ts";
import { handleNotify, recipientBytes } from "../../../src/core/notify/handle.ts";
import {
  accepted,
  boot,
  MINUTE_US,
  rec,
  Runner,
  sensorMessage,
  sirenMessage,
  snapshotWith,
  viewWith,
  WALL0,
} from "../health/support.ts";

interface Home {
  readonly name: string;
  readonly sensors: number;
  readonly sirens: number;
}

const HOMES: readonly Home[] = [
  { name: "A", sensors: 10, sirens: 4 },
  { name: "B", sensors: 30, sirens: 4 },
  { name: "C", sensors: 64, sirens: 8 },
];

const DAY_US = 24 * 60 * MINUTE_US;
const PEOPLE = [1, 2, 3, 4].map(personId);
const CLIENTS: readonly { id: ClientId; person: number }[] = [
  { id: clientId(11), person: 1 },
  { id: clientId(12), person: 1 },
  { id: clientId(21), person: 2 },
  { id: clientId(22), person: 2 },
  { id: clientId(31), person: 3 },
  { id: clientId(41), person: 4 },
];

interface Counted {
  notificationRows: number;
  readRows: number;
  decisionRows: number;
  nowItems: number;
  /** "Now" items emitted in answer to a message that was not itself "now": commits of their own. */
  ownCommits: number;
}

function device(id: DeviceId, role: number): DeviceRow {
  return {
    id,
    address: 0x2000 + id,
    role,
    name: `d${id}`,
    chipId: new Uint8Array(8),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Paired,
    addedMs: WALL0,
    removedMs: null,
  };
}

function day(home: Home): Counted {
  const sensors = Array.from({ length: home.sensors }, (_, i) => deviceId(100 + i));
  const sirens = Array.from({ length: home.sirens }, (_, i) => deviceId(300 + i));
  const base = viewWith();
  const view = {
    ...base,
    registry: {
      ...base.registry,
      devices: new Map(
        [
          ...sensors.map((s) => device(s, Role.Sensor)),
          ...sirens.map((s) => device(s, Role.Siren)),
        ].map((row) => [row.id, row]),
      ),
    },
    alarm: {
      ...base.alarm,
      sensors: new Map(
        sensors.map((s) => [
          s,
          {
            arm: ArmState.Disarmed,
            armedBoot: null,
            armedMono: null,
            countdownS: 30,
            door: undefined,
            doorNow: undefined,
            doorWarned: false,
            changesWarned: undefined,
            batteryMv: undefined,
          },
        ]),
      ),
    },
  };
  const peopleView = {
    ...view,
    people: {
      ...view.people,
      people: new Map(
        PEOPLE.map((id) => [
          id,
          { id, name: `p${id}`, createdMs: 0, removedMs: null, revision: 1 },
        ]),
      ),
      clients: new Map(
        CLIENTS.map((c) => [
          c.id,
          {
            id: c.id,
            personId: personId(c.person),
            staticKey: new Uint8Array(32),
            kind: ClientKind.Web,
            name: `c${c.id}`,
            linkedByClient: null,
            createdMs: 0,
            removedMs: null,
            lastSeq: 0,
            lastSeenMs: null,
            backupKeyEpoch: null,
          },
        ]),
      ),
    },
  };
  const snapshot = snapshotWith();
  const health = new Runner("health", handleHealth, peopleView);
  const notify = new Runner("notify", handleNotify, peopleView);
  const counted: Counted = {
    notificationRows: 0,
    readRows: 0,
    decisionRows: 0,
    nowItems: 0,
    ownCommits: 0,
  };
  let recordN = 0;

  /** One message through health, then what it emitted and the message through notify, as the queue runs. */
  function step(message: Internal, arrived: Durability): void {
    const queue: { message: Internal; arrived: Durability }[] = [{ message, arrived }];
    let own = false;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) break;
      for (const runner of [health, notify] as const) {
        const out = runner.run(next.message);
        for (const item of out) own = count(item) || own;
        for (const item of out) {
          if (item.kind === "auditRecord") queue.push({ message: item, arrived: item.durability });
        }
      }
    }
    if (own && arrived !== "now") counted.ownCommits += 1;

    /** Counts one item; true when it is written now. */
    function count(item: Internal | Effect): boolean {
      if (item.kind === "auditRecord") {
        if (item.record.kind === "notification") counted.notificationRows += 1;
        if (item.record.kind === "notificationRead") counted.readRows += 1;
        if (item.record.kind === "decision") counted.decisionRows += 1;
        if (item.durability === "now") {
          counted.nowItems += 1;
          return true;
        }
      }
      if (item.kind === "write" && item.durability === "now") {
        counted.nowItems += 1;
        return true;
      }
      return false;
    }
  }

  function decided(
    kind: "countdown_started" | "arming_changed" | "armed" | "disarmed" | "report_while_disarmed",
    deviceIdOf: DeviceId | null,
    cause: Seq | null,
    detail: Uint8Array | null,
  ): Internal {
    recordN += 1;
    return {
      kind: "auditRecord",
      durability: "now",
      record: {
        kind: "decision",
        row: {
          seq: rec(recordN),
          atMs: 0,
          clockOk: true,
          kind,
          deviceId: deviceIdOf,
          causeSeq: cause,
          value: null,
          detail,
        },
      },
    };
  }

  health.run(boot(snapshot));
  notify.run(boot(snapshot));
  const actor = new TextEncoder().encode("Anna (client 11)");

  // Heartbeats every 3 minutes, siren reports every 30 s and LoRa checks every 5 minutes: routine.
  for (let t = 0; t < DAY_US; t += 3 * MINUTE_US) {
    health.at(t);
    notify.at(t);
    for (const s of sensors) step(accepted(s, sensorMessage(3900)), "routine");
  }
  for (let t = 0; t < DAY_US; t += 30 * 1_000_000) {
    health.at(t);
    for (const s of sirens) step(accepted(s, sirenMessage(4000)), "routine");
  }
  // 20 door changes a sensor while disarmed: event reports, written now; recorded only (D46).
  for (const s of sensors) {
    for (let i = 0; i < 20; i++) {
      step(accepted(s, sensorMessage(3900, { type: "door" })), "now");
      step(decided("report_while_disarmed", s, null, null), "now");
    }
  }
  // Four arming actions (two arming every sensor, two disarming them), each a request whose
  // decisions are now: its summary naming the sensors it changes (here `arming_changed`; a
  // switch's `mode_switched` is told the same way), then the per-sensor decisions, which raise
  // nothing; and two countdowns disarmed in time.
  for (let action = 0; action < 4; action++) {
    const t = (6 + action * 4) * 60 * MINUTE_US;
    health.at(t);
    notify.at(t);
    recordN += 1;
    const cause = rec(recordN);
    step(decided("arming_changed", null, cause, recipientBytes(sensors)), "now");
    for (const s of sensors)
      step(decided(action % 2 === 0 ? "armed" : "disarmed", s, cause, actor), "now");
    if (action % 2 === 0) step(decided("countdown_started", sensors[0] ?? null, null, null), "now");
  }
  // Every client reads what it was given.
  const given = notify.slice.notifications.map((raised) => raised.row.seq);
  CLIENTS.forEach((c, i) => {
    const actorOf: Actor = {
      kind: "person",
      person: personId(c.person),
      client: c.id,
      name: `p (client ${c.id})`,
    };
    step(
      {
        kind: "opRequest",
        owner: "notify",
        op: { op: "notifications.read", body: { seqs: given } },
        actor: actorOf,
        answerTo: { kind: "app", conn: connId(i + 1), client: c.id, id: 1, seq: 1 },
        record: rec(1),
      },
      "routine",
    );
  });
  return counted;
}

describe("a day of homes A, B and C, by these two modules", () => {
  test.each(HOMES)("home $name", (home) => {
    const counted = day(home);
    console.log(`A6 home ${home.name}:`, counted);
    // One notification per action, two countdowns; no door while disarmed, no steady reading.
    expect(counted.notificationRows).toBe(6);
    // Each of the 6 clients reads the 6.
    expect(counted.readRows).toBe(36);
    // No health decision on a steady battery, no tamper.
    expect(counted.decisionRows).toBe(0);
    // The two countdowns' notifications ride on their decisions' commits; nothing commits of its own.
    expect(counted.ownCommits).toBe(0);
  });
});
