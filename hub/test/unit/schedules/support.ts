/**
 * A hub for the schedules module's tests: the real core with every real module but layout,
 * whose stand-in records the requests schedules send it and answers them as a test says, as alarm
 * answers a schedule's arming (section 11: the reply with `lowBattery` and `heldBack`), over the
 * real calendar. Mode 3 ("Night") and groups 4 and 5 exist, from the boot snapshot. The wall clock, its trust and the monotonic
 * clock are set separately, so a test can step the wall clock, untrust it or let the hub be off.
 */
import { expect } from "bun:test";
import { nodeSha256, Role } from "@hsn/protocol";
import type { AppOp } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import type { ControlReply } from "../../../src/core/model/control.ts";
import type { DecisionKind } from "../../../src/core/model/decisions.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import {
  EMPTY_M2_SNAPSHOT,
  type DurableSnapshot,
  type HubEvent,
} from "../../../src/core/model/events.ts";
import type { CoreDeps, Handler } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type DeviceId,
  deviceId,
  groupId,
  HUB_DEVICE,
  modeId,
  type Seq,
  requestId,
  type ScheduleId,
  scheduleId,
  connId,
} from "../../../src/core/model/ids.ts";
import type { Actor, AnswerTo, Internal, OpOutcome } from "../../../src/core/model/messages.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  ModeFixed,
  type DecisionRow,
  type DeviceRow,
  DeviceState,
  ScheduleAction,
  type ScheduleRow,
} from "../../../src/core/model/rows.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { daysFromCivil } from "../../../src/core/schedules/days.ts";
import { makeCore, MODULES } from "../../../src/core/step.ts";
import { makeCalendar } from "../../../src/shell/calendar/calendar.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot } from "../../world/world.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const ZONE = "Europe/London";

/** A UTC instant, month 1 to 12. */
export function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

/** Wednesday 1 July 2026, 12:00 UTC: 13:00 in London. */
export const START = utc(2026, 7, 1, 12);

export const SENSOR = deviceId(7);
export const OTHER_SENSOR = deviceId(8);

export function sensorRow(id: DeviceId, name: string): DeviceRow {
  return {
    id,
    address: 0x1000 + id,
    role: Role.Sensor,
    name,
    chipId: new Uint8Array(6).fill(id),
    firmware: 0,
    development: true,
    state: DeviceState.Contacted,
    addedMs: 0,
    removedMs: null,
  };
}

/** A `schedules` row: every day at `minutes`, switching to mode 3, unless given. */
export function scheduleRow(
  overrides: Partial<Omit<ScheduleRow, "id">> & { readonly id: number },
): ScheduleRow {
  return {
    name: `entry ${overrides.id}`,
    action: ScheduleAction.SwitchMode,
    modeId: modeId(3),
    groupId: null,
    sensorId: null,
    localTime: 22 * 60,
    days: 0b111_1111,
    date: null,
    missedDueMs: null,
    missedWhy: null,
    missedCount: 0,
    enabled: true,
    createdBy: "tester",
    lastRunMs: null,
    lastRunLocalDate: null,
    revision: 1,
    ...overrides,
    id: scheduleId(overrides.id),
  };
}

/** Days since 1970 of a date, as `last_run_local_date` holds it. */
export function day(year: number, month: number, dayOfMonth: number): number {
  return daysFromCivil({ year, month, day: dayOfMonth });
}

export interface ScheduleRequest {
  readonly op: AppOp;
  readonly actor: Actor;
  readonly record: Seq;
  readonly answerTo: AnswerTo;
}

export interface BootOptions {
  readonly schedules?: readonly ScheduleRow[];
  readonly zone?: string | null;
  /** The last commit mark: its wall time and whether that was trusted. Omitted: a first start. */
  readonly mark?: { readonly wallMs: number; readonly clockOk: boolean };
  readonly devices?: readonly DeviceRow[];
}

export class Hub {
  readonly deps: CoreDeps;
  readonly core;
  state: HubState;
  /** Monotonic microseconds. */
  monoUs = 5_000_000;
  wall: number;
  trusted = true;
  /** The requests schedules sent layout, in order. */
  readonly requests: ScheduleRequest[] = [];
  /** How layout's stand-in answers a schedule's request. */
  responder: (op: AppOp) => OpOutcome = (op) => ({
    ok: true,
    body:
      op.op === "disarm"
        ? { disarmed: [], heldBack: [], alarmEnded: false }
        : { armed: [], disarmed: [], waiting: [], lowBattery: [] },
  });
  /** How the stand-in addresses its answer: as asked, unless a test says otherwise. */
  answerTo: (asked: AnswerTo) => AnswerTo = (asked) => asked;
  /** Each step's effects. */
  readonly steps: (readonly Effect[])[] = [];
  #request = 1;

  constructor(wall = START) {
    this.wall = wall;
    const stand: Handler<"layout"> = (slice, message, ctx) => {
      if (
        message.kind === "opRequest" &&
        message.owner === "layout" &&
        message.actor.kind === "schedule"
      ) {
        this.requests.push({
          op: message.op,
          actor: message.actor,
          record: message.record,
          answerTo: message.answerTo,
        });
        const answer: Internal = {
          kind: "opAnswer",
          answerTo: this.answerTo(message.answerTo),
          outcome: this.responder(message.op),
        };
        return ok({ slice, out: [answer] });
      }
      return MODULES.layout.handle(slice, message, ctx);
    };
    this.core = makeCore({ ...MODULES, layout: { ...MODULES.layout, handle: stand } });
    this.deps = {
      cipher: VectorCipher.fromVectors(),
      rules: DEFAULT_RULES,
      calendar: makeCalendar()._unsafeUnwrap(),
      sha256: nodeSha256,
      deepFreeze: true,
      checkDeadlines: true,
    };
    this.state = this.core.emptyState();
  }

  get now(): { readonly mono: Mono; readonly wall: number; readonly wallTrusted: boolean } {
    return { mono: mono(this.monoUs), wall: this.wall, wallTrusted: this.trusted };
  }

  input(event: HubEvent): readonly Effect[] {
    const result = this.core.step(
      this.state,
      { now: this.now, entropy: new Uint8Array(32), event },
      this.deps,
    );
    expect(result.isOk() ? "ok" : result.error.message).toBe("ok");
    if (result.isErr()) return [];
    this.state = result.value.state;
    this.steps.push(result.value.effects);
    return result.value.effects;
  }

  boot(options: BootOptions = {}, id = 2): readonly Effect[] {
    const mark = options.mark;
    const snapshot: DurableSnapshot = {
      ...emptySnapshot(),
      devices: [
        sensorRow(SENSOR, "front"),
        sensorRow(OTHER_SENSOR, "back"),
        ...(options.devices ?? []),
      ],
      deviceState:
        mark === undefined
          ? []
          : [
              {
                deviceId: HUB_DEVICE,
                boot: bootId(id - 1),
                lastSeenMono: mono(1_000_000),
                lastSeenMs: mark.wallMs,
                clockOk: mark.clockOk,
                window: null,
                reading: null,
                rssi: null,
                snrQ: null,
                bestGatewayId: null,
                uptimeS: null,
                estimates: null,
              },
            ],
      m2: {
        ...EMPTY_M2_SNAPSHOT,
        modes: [
          { id: modeId(1), name: "Away", fixed: ModeFixed.Away, revision: 0 },
          { id: modeId(2), name: "Disarmed", fixed: ModeFixed.Disarmed, revision: 0 },
          { id: modeId(3), name: "Night", fixed: ModeFixed.No, revision: 0 },
        ],
        groups: [
          { id: groupId(4), name: "Ground", allSirens: true, revision: 0 },
          { id: groupId(5), name: "Garage", allSirens: true, revision: 0 },
        ],
        schedules: options.schedules ?? [],
        scheduleState: { timeZone: options.zone === undefined ? ZONE : options.zone },
      },
    };
    return this.input({
      kind: "boot",
      snapshot,
      boot: { id: bootId(id), previousExit: "clean", cause: undefined },
    });
  }

  /** Both clocks move on by `ms`, then a tick. */
  advance(ms: number): readonly Effect[] {
    this.monoUs += ms * 1000;
    this.wall += ms;
    return this.tick();
  }

  /** Both clocks move on to the wall time `wallMs`, then a tick. */
  advanceTo(wallMs: number): readonly Effect[] {
    return this.advance(wallMs - this.wall);
  }

  /** Time passes until the core's next wake, if it is no later than `untilWall`; its effects. */
  runUntil(untilWall: number): readonly Effect[] {
    const all: Effect[] = [];
    for (let i = 0; i < 10_000; i++) {
      const wake = this.core.nextDeadline(this.state);
      const wakeWall = wake === undefined ? undefined : this.wall + (wake - this.monoUs) / 1000;
      if (wakeWall === undefined || wakeWall > untilWall) break;
      all.push(...this.advance(Math.max(0, wakeWall - this.wall)));
    }
    all.push(...this.advanceTo(untilWall));
    return all;
  }

  tick(): readonly Effect[] {
    return this.input({ kind: "tick" });
  }

  op(operation: AppOp): ControlReply {
    const effects = this.input({
      kind: "command",
      conn: connId(0),
      request: requestId(this.#request++),
      actor: "tester",
      command: { kind: "op", operation },
    });
    const replies = effects.flatMap((e) => (e.kind === "respond" ? [e.reply] : []));
    expect(replies.length).toBe(1);
    return replies[0] ?? { ok: false, error: { code: "failed", message: "no reply" } };
  }

  get all(): readonly Effect[] {
    return this.steps.flat();
  }
}

/** The body of a successful op reply. */
export function body(reply: ControlReply): unknown {
  expect(reply.ok).toBe(true);
  return reply.ok && reply.result.kind === "op" ? reply.result.body : undefined;
}

/** The app error of a refused op reply. */
export function appError(reply: ControlReply): unknown {
  expect(reply.ok).toBe(false);
  return reply.ok ? undefined : reply.error.app;
}

export function decisions(effects: readonly Effect[], kind?: DecisionKind): readonly DecisionRow[] {
  return effects.flatMap((e) =>
    e.kind === "record" &&
    e.record.kind === "decision" &&
    (kind === undefined || e.record.row.kind === kind)
      ? [e.record.row]
      : [],
  );
}

export function scheduleWrites(
  effects: readonly Effect[],
): readonly { durability: string; op: StoreOp }[] {
  return effects.flatMap((e) =>
    e.kind === "write" && (e.op.table === "schedules" || e.op.table === "schedule_state")
      ? [{ durability: e.durability, op: e.op }]
      : [],
  );
}

/** A `schedule_missed` detail read back: why, count, first, last. */
export function missedOf(row: DecisionRow): {
  readonly why: number;
  readonly count: number;
  readonly firstMs: number;
  readonly lastMs: number;
} {
  const detail = row.detail ?? new Uint8Array(21);
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  const u64 = (at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 2 ** 32;
  return {
    why: view.getUint8(0),
    count: view.getUint32(1, true),
    firstMs: u64(5),
    lastMs: u64(13),
  };
}

/** A `schedule_ran` detail read back. */
export function ranOf(row: DecisionRow): {
  readonly action: number;
  readonly outcome: number;
  readonly armed: readonly number[];
  readonly disarmed: readonly number[];
  readonly waiting: readonly number[];
  readonly low: readonly number[];
  readonly error: string;
} {
  const detail = row.detail ?? new Uint8Array(10);
  const view = new DataView(detail.buffer, detail.byteOffset, detail.byteLength);
  let at = 2;
  const list = (): number[] => {
    const n = view.getUint16(at, true);
    at += 2;
    const items: number[] = [];
    for (let i = 0; i < n; i++) {
      items.push(view.getUint32(at, true));
      at += 4;
    }
    return items;
  };
  const armed = list();
  const disarmed = list();
  const waiting = list();
  const low = list();
  return {
    action: view.getUint8(0),
    outcome: view.getUint8(1),
    armed,
    disarmed,
    waiting,
    low,
    error: new TextDecoder().decode(detail.subarray(at)),
  };
}

export function u32s(bytes: Uint8Array | null): readonly number[] {
  if (bytes === null) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

export function idOf(n: number): ScheduleId {
  return scheduleId(n);
}
