/**
 * The clock module's handler (hub-design.md section 2, module 1; section 5, "Raspberry Pi";
 * D113). It runs first for every message, so every later handler sees this input's time.
 *
 * - On `boot`: it writes this run's boot record now, keeps the last commit mark, and works out
 *   the downtime; known by the wall clock, it says so at once (`downtimeKnown`).
 * - On every input: a monotonic time smaller than the last is a `CoreFault` (section 3). The wall
 *   time records carry never decreases. The wall clock is trusted when the system says so and it
 *   reads no earlier than the last commit mark; when that changes it says so
 *   (`wallTrustChanged`), and on becoming trusted it writes the step between the two readings
 *   into the boot record, and the downtime, if it was not known, becomes known by the wall clock.
 * - Way 2 (section 5): while the downtime is unknown, a gateway whose status was saved with the
 *   mark and that has reported since the start (`gateways/view.ts`) gives it by its uptime. The
 *   clock runs first in a step, so it sees the status the step before took.
 */
import { Role } from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import type { Effect } from "../model/effects.ts";
import { type CoreFault, coreFault } from "../model/errors.ts";
import type { BootInfo, DurableSnapshot } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import { HUB_DEVICE } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { BootRow, DeviceStateRow } from "../model/rows.ts";
import { msBetween, type Now } from "../model/time.ts";
import { gatewayStatusThisBoot } from "../gateways/view.ts";
import { downtimeByUptime, downtimeByWallClock, startWallMs } from "./downtime.ts";
import { trustedNow } from "./trust.ts";
import type { ClockSlice, Downtime, UptimeWitness } from "./state.ts";

const ORIGIN = "core/clock";

type Out = (Internal | Effect)[];

function writeBoot(row: BootRow): Effect {
  return { kind: "write", durability: "now", op: { table: "boots", op: "upsert", row } };
}

function downtimeKnown(downtime: Downtime): Internal[] {
  return downtime.kind === "known"
    ? [{ kind: "downtimeKnown", downtimeMs: downtime.ms, source: downtime.source }]
    : [];
}

/** Gateways whose last status was saved in the run the mark closed (section 5, way 2). */
function witnessesOf(snapshot: DurableSnapshot, mark: DeviceStateRow): readonly UptimeWitness[] {
  const gateways = new Set(
    snapshot.devices.filter((d) => d.role === Role.Gateway).map((d) => d.id),
  );
  return snapshot.deviceState.flatMap((row) =>
    gateways.has(row.deviceId) && row.uptimeS !== null && row.boot === mark.boot
      ? [{ gateway: row.deviceId, uptimeS: row.uptimeS, statusMono: row.lastSeenMono }]
      : [],
  );
}

function onBoot(snapshot: DurableSnapshot, boot: BootInfo, now: Now): Handled<"clock"> {
  const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
  const trusted = trustedNow(now, mark);
  const row: BootRow = {
    id: boot.id,
    startedMs: now.wall,
    startedTrusted: trusted,
    previousExit: boot.previousExit,
    cause: boot.cause ?? null,
    cleanStopMs: null,
    trustedAtMono: trusted ? now.mono : null,
    clockStepMs: null,
  };
  const byWall = mark !== undefined && trusted ? downtimeByWallClock(mark, now.wall) : undefined;
  const downtime: Downtime =
    mark === undefined
      ? { kind: "firstStart" }
      : byWall === undefined
        ? { kind: "unknown" }
        : { kind: "known", ms: byWall, source: "wallClock" };
  const slice: ClockSlice = {
    timers: [],
    boot: row,
    started: now,
    last: now,
    recordWallMs: Math.max(now.wall, mark?.lastSeenMs ?? 0),
    trusted,
    mark,
    downtime,
    witnesses: mark === undefined ? [] : witnessesOf(snapshot, mark),
  };
  return { slice, out: [writeBoot(row), ...downtimeKnown(downtime)] };
}

/** The wall clock's step when it became trusted: what it reads against what it would have read. */
function stepMs(last: Now, now: Now): number {
  return Math.round(now.wall - (last.wall + msBetween(last.mono, now.mono)));
}

function onInput(slice: ClockSlice, now: Now, ctx: Context): Result<Handled<"clock">, CoreFault> {
  const { last, boot, started } = slice;
  if (boot === undefined || started === undefined || last === undefined)
    return ok({ slice, out: [] });
  if (now.mono < last.mono) {
    return err(
      coreFault(ctx.event, ORIGIN, "the monotonic clock went back", {
        last: last.mono,
        now: now.mono,
      }),
    );
  }
  // The same time as the last input changes nothing: the slice stays the same object, so a
  // step that does nothing is seen to do nothing.
  if (now.mono === last.mono && now.wall === last.wall && now.wallTrusted === last.wallTrusted) {
    return ok({ slice, out: [] });
  }
  const trusted = trustedNow(now, slice.mark);
  const recordWallMs = Math.max(slice.recordWallMs, now.wall);
  const out: Out = [];
  let next: ClockSlice = { ...slice, last: now, recordWallMs, trusted };
  if (trusted !== slice.trusted) {
    const step = trusted ? stepMs(last, now) : undefined;
    out.push({ kind: "wallTrustChanged", trusted, stepMs: step });
    if (trusted && boot.trustedAtMono === null) {
      const row: BootRow = { ...boot, trustedAtMono: now.mono, clockStepMs: step ?? null };
      next = { ...next, boot: row };
      out.push(writeBoot(row));
    }
    if (trusted && slice.downtime.kind === "unknown" && slice.mark !== undefined) {
      const ms = downtimeByWallClock(slice.mark, startWallMs(started, now));
      if (ms !== undefined) {
        const downtime: Downtime = { kind: "known", ms, source: "wallClock" };
        next = { ...next, downtime };
        out.push(...downtimeKnown(downtime));
      }
    }
  }
  if (next.downtime.kind === "unknown" && slice.mark !== undefined) {
    const byUptime = uptimeDowntime(slice, slice.mark, started, ctx);
    if (byUptime !== undefined) {
      const downtime: Downtime = { kind: "known", ms: byUptime, source: "gatewayUptime" };
      next = { ...next, downtime };
      out.push(...downtimeKnown(downtime));
    }
  }
  return ok({ slice: next, out });
}

/** Way 2: the first witness gateway that has reported since the start gives the downtime. */
function uptimeDowntime(
  slice: ClockSlice,
  mark: DeviceStateRow,
  started: Now,
  ctx: Context,
): number | undefined {
  for (const witness of slice.witnesses) {
    const status = gatewayStatusThisBoot(ctx.view, witness.gateway);
    if (status === undefined || status.atMono < started.mono) continue;
    const ms = downtimeByUptime(witness, mark, started.mono, status);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

export const handleClock: Handler<"clock"> = (slice, message, ctx) => {
  if (message.kind === "boot") return ok(onBoot(message.snapshot, message.boot, ctx.now));
  return onInput(slice, ctx.now, ctx);
};
