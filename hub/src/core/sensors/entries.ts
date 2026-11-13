/**
 * A sensor's entry in the sensors slice (hub-design.md sections 5, 6 and 8): restored from the
 * boot snapshot, made for a new sensor with its first version, written now whenever its settings
 * row changes, and its silence timer (D107, with the site move's grace, D115).
 */
import { ok, type Result } from "neverthrow";
import {
  decodeMessage,
  MessageType,
  newSendCounter,
  ResumeStep,
  type SendCounter,
} from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { DeviceId } from "../model/ids.ts";
import { ArmState, DeviceState, NEXT_SETTING_STAYS, type SensorConfigRow } from "../model/rows.ts";
import type { Mono } from "../model/time.ts";
import type { TimerOf } from "../model/timers.ts";
import { safeResumeSendCounter } from "../util/protocol-safe.ts";
import {
  announcingMove,
  isLeftBehind,
  latestMove,
  silenceHeldUntil,
  siteRate,
  siteRow,
  switchedMove,
} from "../site/view.ts";
import {
  DEFAULT_CORRECTION_UNITS,
  DEFAULT_HEARTBEAT_UNITS,
  DEFAULT_LINK_CHECK_EVERY,
} from "./defaults.ts";
import { effectiveIntervalMs } from "./radio.ts";
import { clearTimer, orFault, setTimer } from "./records.ts";
import { applyChange, type ConfigChange, encodeHistory } from "./settings.ts";
import { dayOf, lossOverDays, missedHeartbeats, silentAt } from "./silence.ts";
import type { LossDay, SensorEntry, SensorsSlice, StatusSeen } from "./state.ts";

/** A protocol `Role`: sensor (§6). */
export const ROLE_SENSOR = 1;

/** The sensor's `sensor_config` row, written now with every change (section 5). */
export function configWrite(config: SensorConfigRow): Effect {
  return {
    kind: "write",
    durability: "now",
    op: { table: "sensor_config", op: "upsert", row: config },
  };
}

/** The slice with `entry` in it. */
export function withEntry(slice: SensorsSlice, entry: SensorEntry): SensorsSlice {
  return { ...slice, sensors: new Map(slice.sensors).set(entry.device, entry) };
}

/** What a saved status body said (section 6, `device_state.reading`), or undefined. */
export function statusOfReading(reading: Uint8Array | null): StatusSeen | undefined {
  if (reading === null) return undefined;
  const decoded = decodeMessage(new Uint8Array([MessageType.Heartbeat, ...reading]));
  if (!decoded.ok || decoded.value.type !== MessageType.Heartbeat) return undefined;
  const status = decoded.value;
  return { version: status.settingsVersion, listeningAtSendRate: status.flags.listeningAtSendRate };
}

/**
 * A new sensor's first version (section 9: its settings with version 1): the site's countdown,
 * the protocol's heartbeat and link check, the site's rate for sending and replies (section 8:
 * with fewer than 10 samples, the sending rate), no correction. Paired while a move is announced,
 * it gets a version announcing it like every other sensor; after the switch, the new settings
 * with nothing to follow (section 8, "Pairing during a move").
 */
export function firstConfig(ctx: Context, device: DeviceId): SensorConfigRow {
  const rate = siteRate(ctx.view, ctx.deps.rules);
  const move = announcingMove(ctx.view);
  const switched = switchedMove(ctx.view);
  return {
    deviceId: device,
    arm: ArmState.Disarmed,
    armedBoot: null,
    armedMono: null,
    countdownS: siteRow(ctx.view).countdownDefaultS,
    heartbeatUnits: DEFAULT_HEARTBEAT_UNITS,
    linkCheckEvery: DEFAULT_LINK_CHECK_EVERY,
    sendRate: rate,
    replyRate: rate,
    replyRateFixed: false,
    correctionUnits: DEFAULT_CORRECTION_UNITS,
    correctionFixed: false,
    nextChannel: move?.channel ?? NEXT_SETTING_STAYS,
    nextRate: move?.rate ?? NEXT_SETTING_STAYS,
    moveConfirmed: 0,
    moveFollowed: switched?.id ?? 0,
    version: 1,
    versionHistory: encodeHistory([{ version: 1, replyRate: rate, move: move?.id ?? 0 }]),
  };
}

/** A sensor's entry as it starts: nothing heard yet, silence counted from `heardAt`. */
export function newEntry(
  ctx: Context,
  device: DeviceId,
  address: number,
  name: string,
  config: SensorConfigRow,
  counter: SendCounter,
): SensorEntry {
  return {
    device,
    address,
    name,
    config,
    counter,
    announcing: undefined,
    status: undefined,
    lastCounter: 0,
    snr: [],
    fasterFrom: undefined,
    heardAt: ctx.now.mono,
    heardRate: undefined,
    missed: ctx.deps.rules.silence.sensorDefaultMissed,
    silent: false,
    loss: new Map(),
    slotFrom: undefined,
  };
}

/**
 * The sensors of the snapshot: their rows, the hub's counter from its resume point (section 4;
 * with no row, from one step, whose first use writes the next before it is sent), their newest
 * reading and loss days, and n from the last 7 days (D107).
 */
export function restoreEntries(
  ctx: Context,
  snapshot: DurableSnapshot,
): Result<SensorsSlice["sensors"], CoreFault> {
  const devices = new Map(
    snapshot.devices
      .filter((d) => d.role === ROLE_SENSOR && d.state !== DeviceState.Removed)
      .map((d) => [d.id, d]),
  );
  const counters = new Map(snapshot.sendCounters.map((row) => [row.deviceId, row.resumePoint]));
  const readings = new Map(snapshot.deviceState.map((row) => [row.deviceId, row.reading]));
  const today = dayOf(ctx.now.wall);
  const entries = new Map<DeviceId, SensorEntry>();
  for (const config of snapshot.sensorConfig) {
    const device = devices.get(config.deviceId);
    if (device === undefined) continue;
    const counter = orFault(
      ctx,
      safeResumeSendCounter(ResumeStep.Hub, counters.get(device.id) ?? ResumeStep.Hub),
    );
    if (counter.isErr()) return counter.map(() => entries);
    const rows = snapshot.lossDaily.filter((row) => row.deviceId === device.id);
    const loss = new Map<number, LossDay>(
      rows.map((row) => [row.day, { received: row.received, expected: row.expected }]),
    );
    const interval = effectiveIntervalMs(config.heartbeatUnits, config.sendRate);
    const missed = missedHeartbeats(
      ctx.deps.rules,
      lossOverDays(ctx.deps.rules, rows, today),
      interval,
      snapshot.sensorConfig.length,
    );
    entries.set(device.id, {
      ...newEntry(ctx, device.id, device.address, device.name, config, counter.value),
      status: statusOfReading(readings.get(device.id) ?? null),
      loss,
      missed,
    });
  }
  return ok(entries);
}

/** The hub's counter to a newly paired sensor: from 1, its first resume point written by setup (section 9). */
export function pairedCounter(): SendCounter {
  return newSendCounter(ResumeStep.Hub);
}

/** The interval a sensor really keeps now: at the rate its newest packet came at, else its own (§7). */
export function realIntervalMs(entry: SensorEntry): number {
  return effectiveIntervalMs(entry.config.heartbeatUnits, entry.heardRate ?? entry.config.sendRate);
}

/**
 * The sensor's silence timer (D107): n × I + 30 s ‡ after it was last heard, or after the hub's
 * start, held back after a switch until the grace of section 8 ends; none once silent, or for a
 * sensor a forced move left behind, which raises that alert instead.
 */
export function withSilenceTimer(
  ctx: Context,
  timers: readonly TimerOf<"sensors">[],
  entry: SensorEntry,
): readonly TimerOf<"sensors">[] {
  const key = { module: "sensors", kind: "silence", sensor: entry.device } as const;
  if (entry.silent || isLeftBehind(ctx.view, entry.device)) return clearTimer(timers, key);
  const rules = ctx.deps.rules;
  const normal = silentAt(rules, entry.heardAt, entry.missed, realIntervalMs(entry));
  const held = silenceHeldUntil(ctx.view, rules, entry.device, (rate) =>
    effectiveIntervalMs(entry.config.heartbeatUnits, rate),
  );
  const at: Mono = held !== undefined && held > normal ? held : normal;
  return setTimer(timers, key, at);
}

/** True when `change` sets a column to something other than what `config` holds. */
export function differs(config: SensorConfigRow, change: ConfigChange): boolean {
  return (Object.keys(change) as (keyof ConfigChange)[]).some(
    (column) => change[column] !== config[column],
  );
}

/**
 * `config` with `change` applied, the version bumped when a carried setting changed (D72). The
 * new version is kept with the move it announces: the latest move while its next settings are in
 * the row, 0 otherwise (section 6, `version_history`).
 */
export function changeConfig(
  ctx: Context,
  config: SensorConfigRow,
  change: ConfigChange,
): { readonly config: SensorConfigRow; readonly changed: boolean } {
  if (!differs(config, change)) return { config, changed: false };
  const next = { ...config, ...change };
  const announces = next.nextChannel !== NEXT_SETTING_STAYS || next.nextRate !== NEXT_SETTING_STAYS;
  const move = announces ? (latestMove(ctx.view)?.id ?? 0) : 0;
  return { config: applyChange(config, change, move).config, changed: true };
}
