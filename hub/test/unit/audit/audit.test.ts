/**
 * The audit module (hub-design.md section 2, module 13; sections 5, 6 and 10): record sequence
 * numbers that are never handed out twice, records passed on with the warning cap, rejection
 * counts per source, reason and minute, the `restarted` event with its "records may be
 * missing" notice, commit failures, and retention's rounds.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { BootInfo, DurableSnapshot, HubEvent, Input } from "../../../src/core/model/events.ts";
import {
  bootId,
  deviceId,
  HUB_DEVICE,
  linkId,
  recordSeq,
  type Seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { BootRow, DeviceStateRow } from "../../../src/core/model/rows.ts";
import type { PruneOp } from "../../../src/core/model/store.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import { WARNING_WINDOW_MS } from "../../../src/core/audit/cap.ts";
import {
  EMPTY_MINI_STATE,
  emptyTestSnapshot,
  MINI_DEPS as deps,
  type MiniState,
  miniStep,
  type StandIn,
} from "../support/mini-core.ts";

const WALL = Date.UTC(2026, 10, 13);
const SECOND_US = 1_000_000;
const MINUTE_US = 60 * SECOND_US;
const DAY_MS = 86_400_000;
const CAP = deps.rules.persistence.warningsPerHourPerSource;

function at(monoUs: number, trusted = true): Now {
  return { mono: mono(monoUs), wall: WALL + Math.floor(monoUs / 1000), wallTrusted: trusted };
}

function input(now: Now, event: HubEvent): Input {
  return { now, entropy: new Uint8Array(32), event };
}

const boot = (
  snapshot: DurableSnapshot = emptyTestSnapshot(),
  info: BootInfo = { id: bootId(1), previousExit: "clean", cause: undefined },
): HubEvent => ({
  kind: "boot",
  snapshot,
  boot: info,
});

/** A harness: the mini core with a stand-in module that does what each test asks on ticks. */
class Hub {
  state: MiniState = EMPTY_MINI_STATE;
  readonly effects: Effect[] = [];
  onTick: StandIn = () => ok([]);

  step(now: Now, event: HubEvent): readonly Effect[] {
    const standIn: StandIn = (message, ctx) =>
      message.kind === "tick" ? this.onTick(message, ctx) : ok([]);
    const stepped = miniStep(this.state, input(now, event), deps, [standIn])._unsafeUnwrap();
    this.state = stepped.state;
    this.effects.push(...stepped.effects);
    return stepped.effects;
  }
}

const records = (effects: readonly Effect[]) =>
  effects.flatMap((e) =>
    e.kind === "record" ? [{ durability: e.durability, record: e.record }] : [],
  );

function warning(s: Seq, device: number, level = 2): AuditRecord {
  return {
    kind: "deviceLog",
    row: {
      seq: s,
      atMs: WALL,
      clockOk: true,
      deviceId: deviceId(device),
      counter: 1,
      madeMs: WALL,
      level,
      code: 7,
      text: new Uint8Array(),
      repeatOf: null,
    },
  };
}

/** On each tick, takes a sequence number and sends a record of it to audit. */
function recording(make: (s: Seq) => AuditRecord, durability: "now" | "routine" = "now"): StandIn {
  return (_message, ctx) =>
    ctx.records
      .take()
      .map((s): readonly Internal[] => [{ kind: "auditRecord", durability, record: make(s) }]);
}

describe("record sequence numbers (section 2)", () => {
  test("start at the boot's first, and are never handed out twice, even when a module keeps one back", () => {
    const hub = new Hub();
    const taken: Seq[] = [];
    hub.step(at(0), boot());
    hub.onTick = (_m, ctx) => {
      // Takes three numbers and records only one of them now; the others it might use later.
      for (let i = 0; i < 3; i++) taken.push(ctx.records.take()._unsafeUnwrap());
      return ok([]);
    };
    for (let i = 1; i <= 5; i++) hub.step(at(i * SECOND_US), { kind: "tick" });
    expect(new Set(taken).size).toBe(taken.length);
    expect(taken.toSorted((a, b) => a - b)).toEqual(taken);
    expect(taken[0]).toBeGreaterThan(recordSeq(bootId(1), 0) ?? Infinity);
    expect(hub.state.audit.nextRecord).toBeGreaterThan(taken.at(-1) ?? Infinity);
  });

  test("a step that takes none leaves the slice as it was", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    const before = hub.state.audit;
    hub.step(at(SECOND_US), { kind: "tick" });
    expect(hub.state.audit).toBe(before);
  });
});

describe("the cap on warnings written now (section 5)", () => {
  test("60 ‡ an hour per source are now; the rest routine, with one warning that the cap was reached", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    hub.onTick = recording((s) => warning(s, 3));
    const out = [];
    for (let i = 1; i <= 3600; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    const logs = out.filter((r) => r.record.kind === "deviceLog");
    expect(logs.filter((r) => r.durability === "now")).toHaveLength(CAP);
    expect(logs.filter((r) => r.durability === "routine")).toHaveLength(3600 - CAP);
    const notices = out.filter((r) => r.record.kind === "hubEvent");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      durability: "now",
      record: { row: { level: "warning", code: "warning_cap_reached" } },
    });
    // The next hour, from the first warning, the source has its 60 again.
    const next = records(hub.step(at(WARNING_WINDOW_MS * 1000 + SECOND_US), { kind: "tick" }));
    expect(next.map((r) => r.durability)).toEqual(["now"]);
  });

  test("each source has its own 60", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    let device = 0;
    hub.onTick = recording((s) => warning(s, 3 + (device++ % 2)));
    const out = [];
    for (let i = 1; i <= 2 * CAP; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    expect(out.every((r) => r.durability === "now" && r.record.kind === "deviceLog")).toBe(true);
  });

  test("an event report written now for its own sake is never capped, nor a record below warning", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    hub.onTick = recording((s) => ({
      kind: "rx",
      table: "event",
      row: {
        seq: s,
        atMs: WALL,
        clockOk: true,
        deviceId: deviceId(3),
        type: 2,
        counter: 1,
        path: 0,
        gatewayId: null,
        gwUs: null,
        gwCounter: null,
        rssi: null,
        snrQ: null,
        rate: null,
        body: new Uint8Array(),
      },
    }));
    const out = [];
    for (let i = 1; i <= 200; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    expect(out.filter((r) => r.durability === "now")).toHaveLength(200);
    hub.onTick = recording((s) => warning(s, 3, 1));
    out.length = 0;
    for (let i = 201; i <= 400; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    expect(out.filter((r) => r.durability === "now")).toHaveLength(200);
  });

  test("warnings that come routine stay routine and use none of the 60", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    hub.onTick = recording((s) => warning(s, 3), "routine");
    const routine = [];
    for (let i = 1; i <= 2 * CAP; i++)
      routine.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    expect(routine.every((r) => r.durability === "routine" && r.record.kind === "deviceLog")).toBe(
      true,
    );
    hub.onTick = recording((s) => warning(s, 3));
    const now = [];
    for (let i = 1; i <= CAP; i++)
      now.push(...records(hub.step(at((2 * CAP + i) * SECOND_US), { kind: "tick" })));
    expect(now.map((r) => r.durability)).toEqual(Array.from({ length: CAP }, () => "now"));
  });

  test("warning decisions count against their device, other decisions not at all", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    let kind: "sensor_silent" | "countdown_started" = "sensor_silent";
    hub.onTick = recording((s) => ({
      kind: "decision",
      row: {
        seq: s,
        atMs: WALL,
        clockOk: true,
        kind,
        deviceId: deviceId(3),
        causeSeq: null,
        value: null,
        detail: null,
      },
    }));
    const out = [];
    for (let i = 1; i <= CAP + 1; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    expect(
      out.filter((r) => r.record.kind === "decision" && r.durability === "routine"),
    ).toHaveLength(1);
    kind = "countdown_started";
    expect(
      records(hub.step(at((CAP + 2) * SECOND_US), { kind: "tick" })).map((r) => r.durability),
    ).toEqual(["now"]);
  });
});

describe("rejection counts (HB15)", () => {
  test("one row per source and reason per minute, a full count each time; a new minute starts again", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    hub.step(at(SECOND_US), {
      kind: "linkOpened",
      link: linkId(4),
      linkKind: "network",
      label: "10.0.0.7",
    });
    hub.onTick = () =>
      ok([
        {
          kind: "rejected",
          source: { device: deviceId(2) },
          reason: "badTag",
          address: 0x5e000001,
          sample: new Uint8Array(20).fill(9),
          copy: undefined,
        },
        {
          kind: "rejected",
          source: { link: linkId(4) },
          reason: "textFrame",
          address: undefined,
          sample: new Uint8Array(2),
          copy: undefined,
        },
      ]);
    const out = [];
    for (let i = 2; i <= 4; i++)
      out.push(...records(hub.step(at(i * SECOND_US), { kind: "tick" })));
    const rows = out.map((r) => (r.record.kind === "reject" ? r.record.row : undefined));
    expect(out.every((r) => r.durability === "routine")).toBe(true);
    expect(rows.map((r) => [r?.via, r?.reason, r?.count])).toEqual([
      ["device:2", "badTag", 1],
      ["link:10.0.0.7", "textFrame", 1],
      ["device:2", "badTag", 2],
      ["link:10.0.0.7", "textFrame", 2],
      ["device:2", "badTag", 3],
      ["link:10.0.0.7", "textFrame", 3],
    ]);
    expect(rows[0]?.sample).toHaveLength(16);
    expect(rows[0]?.minute).toBe(Math.floor(WALL / 60_000));
    const later = records(hub.step(at(MINUTE_US + 2 * SECOND_US), { kind: "tick" }));
    expect(later.map((r) => (r.record.kind === "reject" ? r.record.row.count : 0))).toEqual([1, 1]);
  });
});

describe("the restart's record (section 10, HB34)", () => {
  const mark: DeviceStateRow = {
    deviceId: HUB_DEVICE,
    boot: bootId(3),
    lastSeenMono: mono(5),
    lastSeenMs: WALL - 60_000,
    clockOk: true,
    window: null,
    reading: null,
    rssi: null,
    snrQ: null,
    bestGatewayId: null,
    uptimeS: null,
    estimates: null,
  };
  const previous: BootRow = {
    id: bootId(3),
    startedMs: WALL - DAY_MS,
    startedTrusted: true,
    previousExit: "clean",
    cause: null,
    cleanStopMs: null,
    trustedAtMono: null,
    clockStepMs: null,
  };
  const snapshot: DurableSnapshot = {
    ...emptyTestSnapshot(),
    previousBoot: previous,
    deviceState: [mark],
  };
  const restart = (info: BootInfo) => records(new Hub().step(at(0), boot(snapshot, info)));

  test("after a crash or a stop that was not clean, says records after the last commit may be missing, now", () => {
    for (const [previousExit, cause] of [
      ["crash", "boom"],
      ["unknown", undefined],
    ] as const) {
      const [event] = restart({ id: bootId(4), previousExit, cause });
      expect(event?.durability).toBe("now");
      expect(event?.record).toMatchObject({
        kind: "hubEvent",
        row: { level: "warning", code: "restarted", seq: recordSeq(bootId(4), 0) },
      });
      const row = event?.record.kind === "hubEvent" ? event.record.row : undefined;
      expect(row?.message).toContain(`records after ${WALL - 60_000} ms may be missing`);
      expect(JSON.parse(row?.detail ?? "{}")).toEqual({
        previousExit,
        cause: cause ?? null,
        missingAfterMs: WALL - 60_000,
        missingAfterTrusted: true,
      });
    }
  });

  test("after a clean stop or at a first start, an info record and no notice", () => {
    const [clean] = restart({ id: bootId(4), previousExit: "clean", cause: undefined });
    expect(clean).toMatchObject({
      durability: "routine",
      record: { row: { level: "info", code: "restarted" } },
    });
    const [first] = records(new Hub().step(at(0), boot()));
    expect(first).toMatchObject({
      durability: "routine",
      record: { row: { code: "first_start" } },
    });
  });
});

describe("commit failures (sections 5 and 10)", () => {
  test("a failure is a critical event written now; a recovery an info one", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    const failed = records(
      hub.step(at(SECOND_US), {
        kind: "commit",
        outcome: { kind: "failed", message: "disk full" },
      }),
    );
    expect(failed).toMatchObject([
      {
        durability: "now",
        record: {
          row: { level: "critical", origin: "shell/storage/writer", code: "commit_failed" },
        },
      },
    ]);
    const recovered = records(
      hub.step(at(2 * SECOND_US), { kind: "commit", outcome: { kind: "recovered" } }),
    );
    expect(recovered).toMatchObject([
      { durability: "routine", record: { row: { level: "info", code: "commit_recovered" } } },
    ]);
  });
});

describe("retention (section 6)", () => {
  const prunes = (effects: readonly Effect[]): PruneOp[] =>
    effects.flatMap((e) =>
      e.kind === "write" && e.op.op === "prune" && e.durability === "routine" ? [e.op] : [],
    );
  const every = deps.rules.retention.everyMs * 1000;

  test("runs every 10 minutes ‡ and never on an untrusted clock", () => {
    const hub = new Hub();
    hub.step(at(0, false), boot());
    expect(hub.state.audit.timers.map((t) => t.at)).toEqual([mono(every)]);
    expect(prunes(hub.step(at(every, false), { kind: "tick" }))).toEqual([]);
    expect(hub.state.audit.timers.map((t) => t.at)).toEqual([mono(2 * every)]);
    expect(prunes(hub.step(at(2 * every), { kind: "tick" })).map((p) => p.table)).toEqual([
      "rejects",
      "loss_daily",
      "rx_routine",
      "tx_routine",
      "device_log",
      "hub_events",
      "notification_reads",
      "rx_event",
      "tx_event",
      "decisions",
      "commands",
      "notifications",
      "device_log",
      "hub_events",
    ]);
  });

  test("deletes in small batches the rows older than each table's retention, by time", () => {
    const hub = new Hub();
    hub.step(at(0), boot());
    const ops = prunes(hub.step(at(every), { kind: "tick" }));
    const limit = deps.rules.retention.rowsPerRound;
    const now = WALL + every / 1000;
    const routine = now - 30 * DAY_MS;
    const event = now - 365 * DAY_MS;
    expect(ops).toEqual([
      { table: "rejects", op: "prune", beforeMs: routine, limit },
      { table: "loss_daily", op: "prune", beforeDay: Math.floor(routine / DAY_MS), limit },
      { table: "rx_routine", op: "prune", beforeMs: routine, limit },
      { table: "tx_routine", op: "prune", beforeMs: routine, limit },
      { table: "device_log", op: "prune", beforeMs: routine, limit, levels: [0, 1] },
      { table: "hub_events", op: "prune", beforeMs: routine, limit, levels: ["debug"] },
      // M2 (m2-design.md section 4): reads 30 days, notifications 1 year.
      { table: "notification_reads", op: "prune", beforeMs: routine, limit },
      { table: "rx_event", op: "prune", beforeMs: event, limit },
      { table: "tx_event", op: "prune", beforeMs: event, limit },
      { table: "decisions", op: "prune", beforeMs: event, limit },
      { table: "commands", op: "prune", beforeMs: event, limit },
      { table: "notifications", op: "prune", beforeMs: event, limit },
      {
        table: "device_log",
        op: "prune",
        beforeMs: event,
        limit,
        levels: Array.from({ length: 256 }, (_, level) => level),
      },
      {
        table: "hub_events",
        op: "prune",
        beforeMs: event,
        limit,
        levels: ["debug", "info", "warning", "critical"],
      },
    ]);
  });

  test("keeps to the retention set at the site", () => {
    const site = {
      channel: 1,
      rateMask: 32,
      moveId: 0,
      moveStage: 0,
      moveChannel: null,
      moveRate: null,
      moveActor: null,
      moveRequestedMs: null,
      moveForced: false,
      moveSwitchedBoot: null,
      moveSwitchedMono: null,
      wifiName: new Uint8Array(),
      wifiPassword: new Uint8Array(),
      countdownDefaultS: 30,
      autoStopS: 300,
      replyPowerDbm: 22,
      sirenPowerDbm: 22,
      retentionRoutineDays: 1,
      retentionEventDays: 2,
    } as const;
    const hub = new Hub();
    hub.step(at(0), boot({ ...emptyTestSnapshot(), site }));
    expect(hub.state.audit.retention).toEqual({ routineDays: 1, eventDays: 2 });
    const ops = prunes(hub.step(at(every), { kind: "tick" }));
    const now = WALL + every / 1000;
    const decisions = ops.find((p) => p.table === "decisions");
    const routine = ops.find((p) => p.table === "rx_routine");
    const before = (op: (typeof ops)[number] | undefined) =>
      op !== undefined && "beforeMs" in op ? op.beforeMs : undefined;
    expect(before(decisions)).toBe(now - 2 * DAY_MS);
    expect(before(routine)).toBe(now - DAY_MS);
    // `loss_daily` by day, at the routine retention (section 6, "Retention").
    const loss = ops.find((p) => p.table === "loss_daily");
    expect(loss !== undefined && "beforeDay" in loss ? loss.beforeDay : undefined).toBe(
      Math.floor((now - DAY_MS) / DAY_MS),
    );
  });
});
