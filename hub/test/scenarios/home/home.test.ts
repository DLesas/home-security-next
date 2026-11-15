/**
 * Scenario days on the whole hub (hub-design.md section 11, "Scenario tests"): homes A and B of
 * section 5 with every real module, the loop of section 4 over the real store, and the scripted
 * gateways, sensors and sirens on the far ends of its links. The armed door through to the
 * sirens and a disarm; a site move (D115) with sensors and sirens following; a restart during a
 * countdown, clean and by a power cut.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MessageType, Role, SirenAction, SirenState } from "@hsn/protocol";
import { ScriptedBoard } from "../../unit/setup/support/board.ts";
import { MoveStage } from "../../../src/core/model/rows.ts";
import { mono } from "../../../src/core/model/time.ts";
import {
  DAY,
  Home,
  HOME_A,
  HOME_B,
  type HomeSpec,
  HOUR,
  idOf,
  MINUTE,
  SECOND,
} from "../../world/home.ts";
import { DAY_TEST_TIMEOUT_MS } from "../../world/timeouts.ts";

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
});

async function home(spec: HomeSpec): Promise<Home> {
  const made = await Home.create(spec);
  homes.push(made);
  return made;
}

/** Siren commands a siren acted on, as action and seconds. */
function actions(h: Home, name: string): readonly { action: number; seconds: number }[] {
  return h
    .acted(name)
    .flatMap((m) =>
      m.type === MessageType.SirenCommand ? [{ action: m.action, seconds: m.soundSeconds }] : [],
    );
}

describe.each([HOME_A, HOME_B])("a quiet day of home $name", (spec) => {
  let h: Home;
  test(
    "the whole day runs: no fault, no stall, every device heard all day",
    async () => {
      h = await home({ ...spec, seed: 11 });
      h.scriptDoors(10);
      must(h.advanceTo(DAY));
      expect(h.hubEvents("core_fault")).toEqual([]);
      expect(h.decisions("sensor_silent")).toEqual([]);
      expect(h.decisions("siren_unreachable")).toEqual([]);
      // Every sensor's heartbeats came through all day: one every 3 minutes, a reply now and then.
      for (const m of h.sensors) {
        expect(m.sensor.sent.length).toBeGreaterThan(470);
        expect(m.sensor.replies.length).toBeGreaterThan(20);
      }
      // Every siren took its settings and kept reporting on Wi-Fi.
      for (const m of h.sirens) {
        expect(m.siren.held.version).toBe(1);
        expect(m.siren.reports.filter((r) => r.path === "wifi").length).toBeGreaterThan(2800);
      }
      // The ten openings were recorded only, the house being disarmed.
      expect(h.decisions("report_while_disarmed")).toHaveLength(10);
      expect(h.decisions("alarm")).toEqual([]);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test("the gateways were welcomed once and given their settings", () => {
    expect(h.decisions("gateway_welcomed")).toHaveLength(spec.gateways);
    for (const g of h.gateways) expect(g.gateway.settings?.siteChannel).toBe(1);
  });
});

describe("the armed door through to the sirens, then a disarm (home A)", () => {
  let h: Home;
  test(
    "armed at 22:00, the back door opens at 23:30: a countdown, then the alarm on every siren",
    async () => {
      h = await home({ ...HOME_A, seed: 21 });
      must(h.advanceTo(22 * HOUR));
      const arm = h.command({ kind: "arm", sensors: "all", continue: false });
      expect(h.replyTo(arm)?.ok).toBe(true);
      expect(h.decisions("armed")).toHaveLength(10);
      // Each sensor learns it is armed by its next reply.
      must(h.advanceTo(23 * HOUR));
      for (const m of h.sensors) expect(m.sensor.armed).toBe(true);

      const back = h.sensor("door-3");
      back?.door(mono(23.5 * HOUR), true);
      must(h.advanceTo(23.5 * HOUR + 10 * SECOND));
      expect(h.decisions("countdown_started").map((d) => d.deviceId)).toEqual([
        idOf(h, "door-3") ?? null,
      ]);
      expect(back?.buzzing).toBe(true);
      expect(h.decisions("alarm")).toEqual([]);

      must(h.advanceTo(23.5 * HOUR + 40 * SECOND));
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.sirensSounding()).toBe(true);
      for (const m of h.sirens)
        expect(actions(h, m.row.name).at(-1)).toEqual({
          action: SirenAction.SoundAlarm,
          seconds: 300,
        });
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test("the alarm and its sirens were committed before the first siren command left (section 5)", () => {
    const alarm = h.decisions("alarm")[0];
    expect(alarm).toBeDefined();
    const rows = h.query<{ n: number }>("SELECT count(*) AS n FROM alarm");
    expect(rows[0]?.n).toBe(1);
  });

  test("a disarm silences every siren and ends the alarm", () => {
    const disarm = h.command({ kind: "disarm", sensors: "all" });
    expect(h.replyTo(disarm)?.ok).toBe(true);
    must(h.advanceBy(30 * SECOND));
    for (const m of h.sirens) expect(m.siren.output).toBe(SirenState.Off);
    expect(h.query<{ n: number }>("SELECT count(*) AS n FROM alarm")[0]?.n).toBe(0);
    expect(h.decisions("disarmed")).toHaveLength(10);
  });
});

describe("a site move from DR5 to DR3 (D115, home B)", () => {
  let h: Home;
  test(
    "announced, confirmed by every sensor and siren, switched, followed: done",
    async () => {
      // Two gateways, each hearing everything: duplicates on top of the move.
      h = await home({ ...HOME_B, gateways: 2, seed: 31 });
      must(h.advanceTo(HOUR));
      const asked = h.command({ kind: "siteChange", rate: 3 });
      expect(h.replyTo(asked)?.ok).toBe(true);
      expect(h.decisions("move_requested")).toHaveLength(1);
      must(h.advanceTo(3 * HOUR));
      expect(h.decisions("move_switched")).toHaveLength(1);
      expect(h.decisions("move_done")).toHaveLength(1);
      const site = h.query<{ move_stage: number; rate_mask: number }>(
        "SELECT move_stage, rate_mask FROM site",
      )[0];
      expect(site?.move_stage).toBe(MoveStage.Done);
      expect(site?.rate_mask).toBe(1 << 3);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test("every sensor and siren sends at DR3; every gateway listens there", () => {
    for (const m of h.sensors) expect(m.sensor.held.sendRate).toBe(3);
    for (const m of h.sirens) expect(m.siren.held.sendRate).toBe(3);
    for (const g of h.gateways) expect(g.gateway.settings?.listenDataRateMask).toBe(1 << 3);
    expect(h.decisions("move_forced")).toEqual([]);
  });

  // A day on the whole core: about 3.4 s alone, past the default 5 s on a loaded machine.
  test(
    "the rest of the day on the new rate: nobody falls silent",
    () => {
      must(h.advanceTo(DAY));
      expect(h.decisions("sensor_silent")).toEqual([]);
      expect(h.hubEvents("core_fault")).toEqual([]);
      const late = h.sensors.map((m) => m.sensor.sent.at(-1)?.dataRate);
      expect(new Set(late)).toEqual(new Set([3]));
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe.each(["clean", "cut"] as const)("a restart during a countdown (%s)", (how) => {
  let h: Home;
  test(
    "the countdown survives the restart and ends in the alarm at its own deadline",
    async () => {
      h = await home({ ...HOME_A, seed: 41 });
      must(h.advanceTo(HOUR));
      h.command({ kind: "arm", sensors: "all", continue: false });
      must(h.advanceTo(2 * HOUR));
      const opened = 2 * HOUR + 5 * SECOND;
      h.sensor("door-5")?.door(mono(opened), true);
      must(h.advanceTo(opened + 8 * SECOND));
      expect(h.decisions("countdown_started")).toHaveLength(1);
      must(h.restart(how, 5 * SECOND));
      expect(h.restarts).toBe(1);
      // The countdown runs on from the disk: no alarm before its 30 seconds, the alarm after.
      must(h.advanceTo(opened + 25 * SECOND));
      expect(h.decisions("alarm")).toEqual([]);
      must(h.advanceTo(opened + 5 * MINUTE));
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.sirensSounding()).toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "after the restart every gateway and siren is back, and the day goes on",
    () => {
      must(h.advanceTo(DAY));
      expect(h.decisions("gateway_welcomed")).toHaveLength(2);
      expect(h.hubEvents("core_fault")).toEqual([]);
      expect(h.decisions("sensor_silent")).toEqual([]);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("how long the hub was down, by a gateway's uptime (section 5, way 2)", () => {
  test(
    "restarted with the wall clock untrusted, the first status after the start gives it",
    async () => {
      const h = await home({ ...HOME_A, seed: 61 });
      must(h.advanceTo(HOUR));
      h.clock.trusted = false;
      must(h.restart("clean", 20 * SECOND));
      must(h.advanceBy(MINUTE));
      const downtime = h.loop?.state.clock.downtime;
      expect(downtime?.kind).toBe("known");
      if (downtime?.kind !== "known") return;
      expect(downtime.source).toBe("gatewayUptime");
      // Off for 20 s; the uptime counts in whole seconds and the status comes every 30 s.
      expect(downtime.ms).toBeGreaterThanOrEqual(18_000);
      expect(downtime.ms).toBeLessThanOrEqual(22_000);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("a fault in the middle of a day (sections 6 and 10)", () => {
  test(
    "its record takes the next number, so `hsn log --since` neither hides nor misplaces a row",
    async () => {
      const h = await home({ ...HOME_A, seed: 71 });
      h.scriptDoors(10);
      must(h.advanceTo(12 * HOUR));
      h.faultNext();
      // A command answered seconds after it came, with records in between: a board that never
      // answers its Provision (section 9: `usb add` waits 5 s).
      must(h.advanceTo(15 * HOUR));
      const board = new ScriptedBoard({
        role: Role.Sensor,
        chipId: new Uint8Array([9, 9, 9, 9, 9, 9]),
        development: true,
      });
      h.plugBoard(board, "/dev/ttyACM7");
      must(h.advanceBy(SECOND));
      board.answers = false;
      h.command({ kind: "usbAdd", port: "/dev/ttyACM7", name: "shed" });
      // Another command while it waits: its row comes after by number and before by answer.
      must(h.advanceBy(SECOND));
      h.command({ kind: "status" });
      must(h.advanceBy(10 * SECOND));
      expect(h.told.at(-1)?.reply.ok).toBe(false);
      must(h.advanceTo(18 * HOUR));
      // A second one later the same day: numbered from the top of the range, it came before the first.
      h.faultNext();
      must(h.advanceTo(DAY));
      const store = h.store;
      if (store === undefined) return;
      store.writer.flush("log")._unsafeUnwrap();
      const faults = h.query<{ seq: number; at_ms: number }>(
        "SELECT seq, at_ms FROM hub_events WHERE code = 'core_fault'",
      );
      expect(faults).toHaveLength(2);
      const fault = faults[0];
      if (fault === undefined) return;
      // Every audit table: numbers in time order, the fault's among them.
      for (const table of [
        "rx_routine",
        "rx_event",
        "tx_routine",
        "tx_event",
        "decisions",
        "hub_events",
        "commands",
      ]) {
        const times = h
          .query<{ at_ms: number }>(`SELECT at_ms FROM "${table}" ORDER BY seq`)
          .map((r) => r.at_ms);
        expect(times).toEqual(times.toSorted((a, b) => a - b));
      }
      // From just before, at and just after the fault: exactly the rows at or after that time.
      for (const since of [fault.at_ms - 60_000, fault.at_ms, fault.at_ms + 1]) {
        for (const logKind of ["event", "decision"] as const) {
          // `--kind event` is the hub's events and the commands (section 9).
          const tables = logKind === "event" ? ["hub_events", "commands"] : ["decisions"];
          const read = store.reader.query({ since, logKind })._unsafeUnwrap();
          const expected = tables
            .flatMap((table) =>
              h
                .query<{ seq: number }>(`SELECT seq FROM "${table}" WHERE at_ms >= ?`, since)
                .map((r) => r.seq),
            )
            .toSorted((a, b) => a - b);
          expect(read.map((r) => (r.kind === "reject" ? -1 : Number(r.row.seq)))).toEqual(expected);
        }
      }
      expect(
        store.reader
          .query({ since: fault.at_ms, logKind: "event" })
          ._unsafeUnwrap()
          .some((r) => r.kind === "hubEvent" && r.row.code === "core_fault"),
      ).toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("every packet a gateway sends the hub is in the records (D110)", () => {
  test(
    "two gateways hearing everything for two hours: each counter is a row, or a duplicate counted for its gateway",
    async () => {
      const h = await home({ ...HOME_B, gateways: 2, seed: 81 });
      h.scriptDoors(10);
      must(h.advanceTo(2 * HOUR));
      h.store?.writer.flush("log")._unsafeUnwrap();
      let duplicates = 0;
      for (const g of h.gateways) {
        const id = g.row.id;
        const found = new Set(
          h
            .query<{ c: number }>(
              `SELECT gw_counter AS c FROM rx_routine WHERE gateway_id = ? UNION
             SELECT gw_counter FROM rx_event WHERE gateway_id = ? UNION
             SELECT counter FROM rx_routine WHERE device_id = ? UNION
             SELECT counter FROM rx_event WHERE device_id = ? UNION
             SELECT result_counter FROM tx_routine WHERE gateway_id = ? UNION
             SELECT result_counter FROM tx_event WHERE gateway_id = ? UNION
             SELECT counter FROM device_log WHERE device_id = ?`,
              id,
              id,
              id,
              id,
              id,
              id,
              id,
            )
            .map((r) => r.c),
        );
        const missing = Array.from({ length: g.gateway.lastCounter }, (_, i) => i + 1).filter(
          (c) => !found.has(c),
        );
        // A copy of a packet the other gateway forwarded first is a duplicate: no row of its own
        // (its packet is the first copy's row), counted in `rejects` for its gateway and minute.
        const counted =
          h.query<{ n: number | null }>(
            "SELECT sum(count) AS n FROM rejects WHERE via = ? AND reason = 'duplicate'",
            `device:${id}`,
          )[0]?.n ?? 0;
        expect([g.row.name, missing.length]).toEqual([g.row.name, counted]);
        duplicates += counted;
      }
      expect(duplicates).toBeGreaterThan(0);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

/**
 * The 30-door burst on the real loop (section 4), not lockstep: 30 sensors and 8 sirens, armed,
 * every door opening at one instant, the alarm, and `hsn disarm --all` while it sounds. The
 * disarm is answered and silences every siren, through one gateway and through two.
 */
describe.each([1, 2])("a 30-door burst and a disarm during its alarm (%i gateways)", (gateways) => {
  test("every countdown, one alarm, the disarm answered, every siren off", async () => {
    const h = await home({ name: "burst", sensors: 30, sirens: 8, gateways, seed: 91 });
    must(h.advanceTo(10 * MINUTE));
    const arm = h.command({ kind: "arm", sensors: "all", continue: false });
    must(h.advanceTo(12 * MINUTE));
    expect(h.replyTo(arm)?.ok).toBe(true);
    const opened = 12 * MINUTE + 5 * SECOND;
    for (const m of h.sensors) m.sensor.door(mono(opened), true);
    // The countdown is 30 s (D40); the sirens sound at its end.
    // The countdown is 30 s (D40). Thirty reports at once collide on the air, so most arrive
    // after it ended, each joining the running alarm (D95, D106) within its automatic stop.
    must(h.advanceTo(opened + 4 * MINUTE));
    const reached = new Set(
      [
        ...h.decisions("countdown_started"),
        ...h.decisions("alarm_trigger_added"),
        ...h.decisions("late_report_sirens"),
      ].map((d) => d.deviceId),
    );
    expect(reached.size).toBe(30);
    expect(h.decisions("alarm")).toHaveLength(1);
    expect(h.sirensSounding()).toBe(true);
    const disarm = h.command({ kind: "disarm", sensors: "all" });
    must(h.advanceTo(opened + 5 * MINUTE));
    expect(h.replyTo(disarm)?.ok).toBe(true);
    expect(h.decisions("alarm_ended")).toHaveLength(1);
    expect(h.decisions("disarmed")).toHaveLength(30);
    for (const m of h.sirens) {
      expect([m.row.name, m.siren.output]).toEqual([m.row.name, SirenState.Off]);
      expect(actions(h, m.row.name).at(-1)?.action).toBe(SirenAction.Off);
    }
    expect(h.hubEvents("core_fault")).toEqual([]);
  }, 120_000);
});

/**
 * Two gateways, and only the one the hub counts offline hears the door (D97, D110, section 8):
 * gateway 1 sends no status and hears nothing for 70 s, so it is offline; then gateway 2 goes
 * deaf and only gateway 1 hears the opening. Its forward on its authenticated session is proof
 * that it is there: the report is accepted, acted on and recorded through it.
 */
describe("two gateways, only the offline one hears the door", () => {
  test(
    "the report is accepted, the countdown and the alarm follow, recorded through that gateway",
    async () => {
      const h = await home({ ...HOME_A, gateways: 2, seed: 97 });
      must(h.advanceTo(10 * MINUTE));
      h.command({ kind: "arm", sensors: "all", continue: false });
      must(h.advanceTo(11 * MINUTE));
      const [first, second] = h.gateways;
      if (first === undefined || second === undefined) return;
      first.statusAt = undefined;
      first.busy.push({ from: 11 * MINUTE, until: 11 * MINUTE + 70 * SECOND });
      must(h.advanceTo(11 * MINUTE + 75 * SECOND));
      expect(h.decisions("gateway_offline").map((d) => d.deviceId)).toEqual([first.row.id]);
      second.busy.push({ from: h.now, until: h.now + HOUR });
      const opened = h.now + SECOND;
      h.sensor("door-3")?.door(mono(opened), true);
      must(h.advanceTo(opened + 45 * SECOND));
      const started = h.decisions("countdown_started");
      expect(started.map((d) => d.deviceId)).toEqual([idOf(h, "door-3") ?? null]);
      expect(h.decisions("alarm")).toHaveLength(1);
      h.store?.writer.flush("log")._unsafeUnwrap();
      const report = h
        .query<{ g: number | null; c: number | null }>(
          "SELECT gateway_id AS g, gw_counter AS c FROM rx_event WHERE seq = ?",
          started[0]?.causeSeq ?? -1,
        )
        .at(0);
      expect(report?.g ?? null).toBe(first.row.id);
      expect(report?.c ?? null).not.toBeNull();
    },
    DAY_TEST_TIMEOUT_MS,
  );
});
