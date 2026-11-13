/**
 * A gateway's `device_state` row (hub-design.md sections 5 and 6). Its `window` holds the
 * highest counter accepted from the gateway (see the SPEC-QUESTION on `DurableSnapshot`), which
 * is written now whenever a hello is accepted; its reading (the last status body), uptime and
 * noise baseline are routine. Every write is the whole row (section 2).
 */
import { decodeReplayWindow, encodeReplayWindow } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { DeviceStateRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { mono } from "../model/time.ts";
import { ESTIMATES_FORMAT } from "./constants.ts";
import { decodeBaseline, encodeBaseline } from "./noise.ts";
import type { GatewayEntry, GatewaysSlice } from "./state.ts";

/** The `write` of the gateway's whole `device_state` row, or none before the boot event. */
export function deviceStateWrite(
  slice: GatewaysSlice,
  entry: GatewayEntry,
  durability: Durability,
): readonly Effect[] {
  if (slice.boot === undefined) return [];
  const baseline = entry.noise.baseline;
  const row: DeviceStateRow = {
    deviceId: entry.device,
    boot: slice.boot,
    lastSeenMono: entry.lastHeardAt ?? mono(0),
    lastSeenMs: entry.lastHeardMs ?? 0,
    clockOk: entry.lastHeardTrusted,
    window: encodeReplayWindow({ highest: entry.highestAccepted, seenBelow: 0n }),
    reading: entry.status?.body ?? null,
    rssi: null,
    snrQ: null,
    bestGatewayId: null,
    uptimeS: entry.status?.uptimeSeconds ?? entry.uptimeS ?? null,
    estimates:
      baseline === undefined
        ? null
        : Uint8Array.from([ESTIMATES_FORMAT, ...encodeBaseline(baseline)]),
  };
  return [{ kind: "write", durability, op: { table: "device_state", op: "upsert", row } }];
}

/** What a stored row gives back at boot: the highest counter, the uptime and the baseline. */
export function restoredState(row: DeviceStateRow | undefined): {
  readonly highestAccepted: number;
  readonly uptimeS: number | undefined;
  readonly baseline: number | undefined;
} {
  const stored = row?.window ?? null;
  const window = stored === null ? undefined : decodeReplayWindow(stored);
  const estimates = row?.estimates ?? null;
  const baseline =
    estimates !== null && estimates[0] === ESTIMATES_FORMAT
      ? decodeBaseline(estimates.subarray(1))
      : undefined;
  return {
    highestAccepted: window?.ok === true ? window.value.highest : 0,
    uptimeS: row?.uptimeS ?? undefined,
    baseline,
  };
}
