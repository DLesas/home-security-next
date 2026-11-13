/**
 * The clock module (hub-design.md section 2, module 1; section 5, "Raspberry Pi"; D113): the
 * boot record, the last time seen, wall-clock trust and its changes, and how long the hub was
 * off: by the wall clock, by a gateway's uptime, or unknown.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import { downtimeByUptime } from "../../../src/core/clock/downtime.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { BootInfo, DurableSnapshot, HubEvent, Input } from "../../../src/core/model/events.ts";
import { bootId, deviceId, HUB_DEVICE } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { DeviceStateRow } from "../../../src/core/model/rows.ts";
import { mono, type Now } from "../../../src/core/model/time.ts";
import {
  EMPTY_MINI_STATE,
  emptyTestSnapshot as emptySnapshot,
  MINI_DEPS as deps,
  type MiniState,
  miniStep,
} from "../support/mini-core.ts";

const WALL = Date.UTC(2026, 10, 13);
const MINUTE_US = 60_000_000;

function now(monoUs: number, wall: number, trusted = true): Now {
  return { mono: mono(monoUs), wall, wallTrusted: trusted };
}

function input(at: Now, event: HubEvent): Input {
  return { now: at, entropy: new Uint8Array(32), event };
}

function markRow(wallMs: number, clockOk: boolean, lastSeenMono = 900 * MINUTE_US): DeviceStateRow {
  return {
    deviceId: HUB_DEVICE,
    boot: bootId(4),
    lastSeenMono: mono(lastSeenMono),
    lastSeenMs: wallMs,
    clockOk,
    window: null,
    reading: null,
    rssi: null,
    snrQ: null,
    bestGatewayId: null,
    uptimeS: null,
    estimates: null,
  };
}

const BOOT: BootInfo = { id: bootId(5), previousExit: "unknown", cause: undefined };

/** Runs inputs, keeping every message the clock emits and every effect. */
function run(inputs: readonly Input[]): {
  state: MiniState;
  messages: Internal[];
  effects: Effect[];
} {
  const messages: Internal[] = [];
  const effects: Effect[] = [];
  let state = EMPTY_MINI_STATE;
  const watch = (message: Internal) => {
    if (message.kind === "wallTrustChanged" || message.kind === "downtimeKnown")
      messages.push(message);
    return ok([]);
  };
  for (const each of inputs) {
    const stepped = miniStep(state, each, deps, [watch])._unsafeUnwrap();
    state = stepped.state;
    effects.push(...stepped.effects);
  }
  return { state, messages, effects };
}

const boots = (effects: readonly Effect[]) =>
  effects.flatMap((e) =>
    e.kind === "write" && e.op.op === "upsert" && e.op.table === "boots"
      ? [{ durability: e.durability, row: e.op.row }]
      : [],
  );

describe("the boot record", () => {
  test("is written now at the start, with how the last run ended", () => {
    const { effects, state } = run([
      input(now(0, WALL), {
        kind: "boot",
        snapshot: emptySnapshot(),
        boot: { id: bootId(1), previousExit: "crash", cause: "boom" },
      }),
    ]);
    expect(boots(effects)).toEqual([
      {
        durability: "now",
        row: {
          id: bootId(1),
          startedMs: WALL,
          startedTrusted: true,
          previousExit: "crash",
          cause: "boom",
          cleanStopMs: null,
          trustedAtMono: mono(0),
          clockStepMs: null,
        },
      },
    ]);
    expect(state.clock.downtime).toEqual({ kind: "firstStart" });
  });
});

describe("how long the hub was off (section 5, D113)", () => {
  const snapshotWith = (
    mark: DeviceStateRow,
    extra: Partial<DurableSnapshot> = {},
  ): DurableSnapshot => ({ ...emptySnapshot(), deviceState: [mark], ...extra });

  test("by the wall clock, at once, when the last commit mark and the clock now are both trusted", () => {
    const { state, messages } = run([
      input(now(0, WALL + 90_000), {
        kind: "boot",
        snapshot: snapshotWith(markRow(WALL, true)),
        boot: BOOT,
      }),
    ]);
    expect(state.clock.downtime).toEqual({ kind: "known", ms: 90_000, source: "wallClock" });
    expect(messages).toEqual([{ kind: "downtimeKnown", downtimeMs: 90_000, source: "wallClock" }]);
  });

  test("unknown on an untrusted clock, then known the moment it is set, counted back to the start", () => {
    const snapshot = snapshotWith(markRow(WALL, true));
    const { state, messages, effects } = run([
      input(now(0, 1_000, false), { kind: "boot", snapshot, boot: BOOT }),
      input(now(MINUTE_US, 61_000, false), { kind: "tick" }),
      // The network sets the clock two minutes after the start: the start was at WALL + 300 s.
      input(now(2 * MINUTE_US, WALL + 420_000, true), { kind: "tick" }),
    ]);
    expect(state.clock.downtime).toEqual({ kind: "known", ms: 300_000, source: "wallClock" });
    expect(messages).toEqual([
      { kind: "wallTrustChanged", trusted: true, stepMs: WALL + 420_000 - 121_000 },
      { kind: "downtimeKnown", downtimeMs: 300_000, source: "wallClock" },
    ]);
    expect(boots(effects).map((b) => [b.row.trustedAtMono, b.row.clockStepMs])).toEqual([
      [null, null],
      [mono(2 * MINUTE_US), WALL + 420_000 - 121_000],
    ]);
  });

  test("never by the wall clock when the last commit mark's was not trusted", () => {
    const { state, messages } = run([
      input(now(0, WALL, false), {
        kind: "boot",
        snapshot: snapshotWith(markRow(WALL - 5_000, false)),
        boot: BOOT,
      }),
      input(now(MINUTE_US, WALL + 60_000, true), { kind: "tick" }),
    ]);
    expect(state.clock.downtime).toEqual({ kind: "unknown" });
    expect(messages.map((m) => m.kind)).toEqual(["wallTrustChanged"]);
  });

  test("by a gateway's uptime: its new status less its last, less the time from that to the commit and from the start", () => {
    const witness = { gateway: deviceId(2), uptimeS: 10_000, statusMono: mono(890 * MINUTE_US) };
    const mark = markRow(WALL, false, 900 * MINUTE_US);
    // Off for 7 minutes: the old status was 10 min before the commit, the new one 30 s after the start.
    const uptime = 10_000 + 10 * 60 + 7 * 60 + 30;
    expect(
      downtimeByUptime(witness, mark, mono(0), { uptimeS: uptime, atMono: mono(30_000_000) }),
    ).toBe(7 * 60_000);
    expect(
      downtimeByUptime(witness, mark, mono(0), { uptimeS: 50, atMono: mono(30_000_000) }),
    ).toBeUndefined();
  });

  test("keeps as witnesses the gateways whose last status was saved in the run the mark closed", () => {
    const gatewayState = (id: number, boot: number): DeviceStateRow => ({
      ...markRow(WALL, true),
      deviceId: deviceId(id),
      boot: bootId(boot),
      uptimeS: 500,
      lastSeenMono: mono(5),
    });
    const device = (id: number, role: number) => ({
      id: deviceId(id),
      address: id,
      role,
      name: `d${id}`,
      chipId: new Uint8Array(),
      firmware: 0,
      development: false,
      state: 2 as const,
      addedMs: 0,
      removedMs: null,
    });
    const snapshot = snapshotWith(markRow(WALL, true), {
      devices: [device(2, 3), device(6, 3), device(3, 1)],
      deviceState: [
        markRow(WALL, true),
        gatewayState(2, 4),
        gatewayState(6, 3),
        gatewayState(3, 4),
      ],
    });
    const { state } = run([input(now(0, WALL, false), { kind: "boot", snapshot, boot: BOOT })]);
    expect(state.clock.witnesses).toEqual([
      { gateway: deviceId(2), uptimeS: 500, statusMono: mono(5) },
    ]);
  });
});

describe("the wall clock (section 5)", () => {
  test("is not trusted while it reads earlier than a trusted last commit mark", () => {
    const { state } = run([
      input(now(0, WALL - 1, true), {
        kind: "boot",
        snapshot: { ...emptySnapshot(), deviceState: [markRow(WALL, true)] },
        boot: BOOT,
      }),
    ]);
    expect(state.clock.trusted).toBe(false);
    expect(state.clock.downtime).toEqual({ kind: "unknown" });
  });

  test("records keep their time when it steps back, and its trust changes are said", () => {
    const { state, messages } = run([
      input(now(0, WALL), { kind: "boot", snapshot: emptySnapshot(), boot: BOOT }),
      input(now(MINUTE_US, WALL - 3_600_000, false), { kind: "tick" }),
    ]);
    expect(state.clock.recordWallMs).toBe(WALL);
    expect(messages).toEqual([{ kind: "wallTrustChanged", trusted: false, stepMs: undefined }]);
  });

  test("an input at the same time leaves the slice as it was, so an idle step is seen as idle", () => {
    const booted = miniStep(
      EMPTY_MINI_STATE,
      input(now(MINUTE_US, WALL), { kind: "boot", snapshot: emptySnapshot(), boot: BOOT }),
      deps,
    )._unsafeUnwrap();
    const again = miniStep(
      booted.state,
      input(now(MINUTE_US, WALL), { kind: "tick" }),
      deps,
    )._unsafeUnwrap();
    expect(again.state.clock).toBe(booted.state.clock);
    expect(again.state.audit).toBe(booted.state.audit);
  });

  test("a monotonic time that goes back is a fault", () => {
    const booted = miniStep(
      EMPTY_MINI_STATE,
      input(now(MINUTE_US, WALL), { kind: "boot", snapshot: emptySnapshot(), boot: BOOT }),
      deps,
    )._unsafeUnwrap();
    const fault = miniStep(booted.state, input(now(MINUTE_US - 1, WALL), { kind: "tick" }), deps);
    expect(fault._unsafeUnwrapErr()).toMatchObject({
      kind: "internal",
      origin: "core/clock",
      event: "tick",
    });
  });
});
