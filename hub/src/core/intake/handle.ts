/**
 * The intake module's handler (hub-design.md section 2, module 7; section 8, "Accepting a device
 * packet"). It learns the devices whose packets it opens from the boot snapshot and from
 * `deviceAdded` and `deviceRemoved`; for each `devicePacket` it runs the checks of `accept.ts`
 * and either counts a rejection by source and reason (`rejected`, which audit counts per minute,
 * HB15) or emits `accepted` with the packet's `rx` record, its window and reading, and for a log
 * entries packet a `device_log` row per entry. Door, cover, button and Started reports, update
 * queries and statuses are written now; routine packets are not (section 5).
 *
 * After a restore (D141, m3-updates-design section 7) a packet under a key the hub held at the
 * backup is recorded, its `rx` row flagged `oldKey`, and emitted as `oldKeyPacket`, never as
 * `accepted`: its window, readings and decisions are untouched, so no module can act on it. The
 * first packet under the device's new key switches it: its window starts again, the switch is
 * written now with the packet (`key_changed`, before the packet's `accepted`, so the module that
 * owns the key starts its counters again before it answers), and the packet is acted on as any other.
 */
import { ok, Result } from "neverthrow";
import {
  decodeReplayWindow,
  EMPTY_REPLAY_WINDOW,
  type Message,
  MessageType,
  type MessageOf,
} from "@hsn/protocol";
import type { CoreFault } from "../model/errors.ts";
import type { Effect } from "../model/effects.ts";
import { type DurableSnapshot, EMPTY_M3M4_SNAPSHOT } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import type { DeviceId, Seq } from "../model/ids.ts";
import type { Arrival, Internal, RejectSource, HeardCopy as CopyHeard } from "../model/messages.ts";
import { DeviceState, PacketPath, type RxRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import { type Mono, monoAfterMs, msBetween } from "../model/time.ts";
import { safeEncodeMessage } from "../util/protocol-safe.ts";
import { decisionMessage, orFault, recordMessage } from "../sensors/view.ts";
import { slotEstimates } from "../slots/view.ts";
import { checkPacket, type KeyState, unknownTypeOf, type Verdict } from "./accept.ts";
import { durabilityOf, rxTableOf } from "./classes.ts";
import type { HeardCopy, IntakeSlice, KnownDevice, LoggedEntry } from "./state.ts";
import { deviceStateRow } from "./view.ts";

type Out = Internal | Effect;
type Step = Result<Handled<"intake">, CoreFault>;

/** The first bytes of a rejected packet kept as its sample (section 6, `rejects.sample`). */
const SAMPLE_BYTES = 16;
/** Tenths of a second, the unit of a log entry's age (§6). */
const MS_PER_TENTH = 100;
/** Log entries kept per device for marking repeats; more than 15 s ‡ of any real device's. */
const MAX_LOGGED_ENTRIES = 64;

function newDevice(device: DeviceId, address: number, role: number): KnownDevice {
  return {
    device,
    address,
    role,
    window: EMPTY_REPLAY_WINDOW,
    reading: null,
    heardAt: undefined,
    heardMs: undefined,
    heardTrusted: false,
    rssi: null,
    snrQ: null,
    bestGateway: null,
    estimates: null,
    logs: [],
  };
}

/**
 * The devices of the snapshot whose packets intake opens: every one not removed. A gateway's is
 * among them, so its own packet found inside a forwarded one opens and is `wrongPath` (section 8).
 */
function fromSnapshot(snapshot: DurableSnapshot): IntakeSlice["devices"] {
  const states = new Map(snapshot.deviceState.map((row) => [row.deviceId, row]));
  const devices = snapshot.devices
    .filter((row) => row.state !== DeviceState.Removed && row.address !== 0)
    .map((row): KnownDevice => {
      const saved = states.get(row.id);
      const window =
        saved?.window === null || saved === undefined
          ? undefined
          : decodeReplayWindow(saved.window);
      return {
        ...newDevice(row.id, row.address, row.role),
        window: window?.ok === true ? window.value : EMPTY_REPLAY_WINDOW,
        reading: saved?.reading ?? null,
        rssi: saved?.rssi ?? null,
        snrQ: saved?.snrQ ?? null,
        bestGateway: saved?.bestGatewayId ?? null,
        estimates: saved?.estimates ?? null,
      };
    });
  return new Map(devices.map((known) => [known.device, known]));
}

function withDevices(slice: IntakeSlice, devices: IntakeSlice["devices"]): IntakeSlice {
  const byAddress = new Map([...devices.values()].map((known) => [known.address, known.device]));
  return { ...slice, devices, byAddress };
}

/** Where a rejected packet came from: its gateway, or the link when no device is known (section 6). */
function sourceOf(arrival: Arrival): RejectSource {
  return arrival.path === "lora" ? { device: arrival.gateway } : { link: arrival.link };
}

function rejectedMessage(
  arrival: Arrival,
  bytes: Uint8Array,
  reason: Extract<Internal, { kind: "rejected" }>["reason"],
  address: number | undefined,
  copy?: CopyHeard,
): Internal {
  return {
    kind: "rejected",
    source: sourceOf(arrival),
    reason,
    address,
    sample: bytes.slice(0, SAMPLE_BYTES),
    copy,
  };
}

/** The `rx` row of an accepted packet (section 6): its fields, and the gateway's when forwarded. */
function rxRow(
  ctx: Context,
  seq: Seq,
  device: DeviceId,
  type: number,
  counter: number,
  arrival: Arrival,
  body: Uint8Array,
  oldKey = false,
): RxRow {
  const lora = arrival.path === "lora" ? arrival : undefined;
  return {
    seq,
    atMs: ctx.now.wall,
    clockOk: ctx.now.wallTrusted,
    deviceId: device,
    type,
    counter,
    path:
      arrival.path === "lora"
        ? PacketPath.Lora
        : arrival.path === "wifi"
          ? PacketPath.Wifi
          : PacketPath.Usb,
    gatewayId: lora?.gateway ?? null,
    gwUs: lora?.gatewayMicros ?? null,
    gwCounter: lora?.gatewayCounter ?? null,
    rssi: lora?.rssiDbm ?? null,
    snrQ: lora?.snrQuarterDb ?? null,
    rate: lora?.dataRate ?? null,
    body,
    oldKey,
  };
}

/**
 * The gateway's own forwarded packet, as a row of its own, when what it carried made none: its
 * inside was refused (a bad tag, an unknown address, a replay…), a duplicate copy apart. Every packet a gateway
 * sends the hub is then found by gateway and counter (D110): a carried packet's row by
 * `gateway_id` and `gw_counter`, this row by `device_id` and `counter`. Its body is the forwarded
 * packet's plaintext after the type byte, the refused packet inside it as received.
 */
function carrierRecord(
  ctx: Context,
  arrival: Arrival,
  bytes: Uint8Array,
): Result<Internal[], CoreFault> {
  if (arrival.path !== "lora") return ok([]);
  const forwarded: Message = {
    type: MessageType.ForwardedPacket,
    receivedAtMicros: arrival.gatewayMicros,
    rssiDbm: arrival.rssiDbm,
    snrQuarterDb: arrival.snrQuarterDb,
    dataRate: arrival.dataRate,
    siteChannel: arrival.siteChannel,
    packet: bytes,
  };
  return orFault(ctx, safeEncodeMessage(forwarded)).andThen((plaintext) =>
    ctx.records.take().map((seq): Internal[] => [
      recordMessage("routine", {
        kind: "rx",
        table: "routine",
        row: {
          seq,
          atMs: ctx.now.wall,
          clockOk: ctx.now.wallTrusted,
          deviceId: arrival.gateway,
          type: MessageType.ForwardedPacket,
          counter: arrival.gatewayCounter,
          path: arrival.gatewayLink === "usb" ? PacketPath.Usb : PacketPath.Wifi,
          gatewayId: null,
          gwUs: arrival.gatewayMicros,
          gwCounter: null,
          rssi: arrival.rssiDbm,
          snrQ: arrival.snrQuarterDb,
          rate: arrival.dataRate,
          body: plaintext.slice(1),
          oldKey: false,
        },
      }),
    ]),
  );
}

/** When the packet ended on the hub's clock: the gateway's mapped time, or now on a link. */
function endedAt(ctx: Context, arrival: Arrival): Mono {
  return arrival.path === "lora" ? arrival.endedAt : ctx.now.mono;
}

/** A siren's authentic copy, kept 15 minutes ‡ for its best gateway (section 8). */
function withCopy(
  ctx: Context,
  slice: IntakeSlice,
  known: KnownDevice,
  arrival: Arrival,
): IntakeSlice {
  if (known.role !== 2 || arrival.path !== "lora") return slice;
  const since = monoAfterMs(ctx.now.mono, -ctx.deps.rules.sirens.bestGatewayWindowMs);
  const copies: readonly HeardCopy[] = [
    ...(slice.copies.get(known.device) ?? []).filter((copy) => copy.at >= since),
    { gateway: arrival.gateway, snrQuarterDb: arrival.snrQuarterDb, at: ctx.now.mono },
  ];
  return { ...slice, copies: new Map(slice.copies).set(known.device, copies) };
}

/**
 * The device's `device_state` row written with `durability`: intake's columns, with a sensor's
 * estimates as slots holds them (from before this packet; section 2, the slots note).
 */
function stateWrite(
  view: Context["view"],
  device: DeviceId,
  durability: Durability,
): readonly Out[] {
  const row = deviceStateRow(view, device, slotEstimates(view, device));
  return row === undefined
    ? []
    : [{ kind: "write", durability, op: { table: "device_state", op: "upsert", row } }];
}

/**
 * The `device_log` rows of a log entries packet (section 6), each marked `repeat_of` an earlier
 * packet's counter when an entry with the same level, code and text was made within 15 s ‡ of
 * it (section 8, FD 8). Warnings and worse are written now (section 5; audit applies the cap).
 */
function logRecords(
  ctx: Context,
  known: KnownDevice,
  counter: number,
  ended: Mono,
  entries: MessageOf<typeof MessageType.LogEntries>["entries"],
): Result<{ readonly logs: readonly LoggedEntry[]; readonly out: readonly Out[] }, CoreFault> {
  const within = ctx.deps.rules.intake.logRepeatWithinMs;
  const encoder = new TextEncoder();
  let logs = known.logs;
  const out: Out[] = [];
  for (const entry of entries) {
    const madeAt = monoAfterMs(ended, -entry.ageTenths * MS_PER_TENTH);
    const earlier = logs.find(
      (old) =>
        old.counter !== counter &&
        old.level === entry.level &&
        old.code === entry.code &&
        old.text === entry.text &&
        Math.abs(msBetween(old.madeAt, madeAt)) <= within,
    );
    const seq = ctx.records.take();
    if (seq.isErr()) return seq.map(() => ({ logs, out }));
    out.push(
      recordMessage(entry.level >= WARNING_LEVEL ? "now" : "routine", {
        kind: "deviceLog",
        row: {
          seq: seq.value,
          atMs: ctx.now.wall,
          clockOk: ctx.now.wallTrusted,
          deviceId: known.device,
          counter,
          madeMs: Math.round(ctx.now.wall + msBetween(ctx.now.mono, madeAt)),
          level: entry.level,
          code: entry.code,
          text: encoder.encode(entry.text),
          repeatOf: earlier?.counter ?? null,
        },
      }),
    );
    logs = [
      ...logs.filter((old) => msBetween(old.madeAt, madeAt) <= within),
      { counter, level: entry.level, code: entry.code, text: entry.text, madeAt },
    ].slice(-MAX_LOGGED_ENTRIES);
  }
  return ok({ logs, out });
}

/** A log entry's level from warning up is written now (§6 levels; section 5). */
const WARNING_LEVEL = 2;

/** True for the sensor status types, whose body is the device's reading (section 6). */
function isStatus(message: Message): boolean {
  return (
    message.type === MessageType.Heartbeat ||
    message.type === MessageType.DoorChanged ||
    message.type === MessageType.CoverChanged ||
    message.type === MessageType.Button ||
    message.type === MessageType.SirenReport
  );
}

/** Applies an accepted packet: window, readings when newest, its records and messages. */
function onAccepted(
  slice: IntakeSlice,
  verdict: Extract<Verdict, { kind: "accepted" }>,
  arrival: Arrival,
  ctx: Context,
): Step {
  const known = slice.devices.get(verdict.device);
  if (known === undefined) return ok({ slice, out: [] });
  const { message, counter, newest, switched } = verdict;
  return orFault(ctx, safeEncodeMessage(message)).andThen((plaintext) =>
    ctx.records.take().andThen((seq) => {
      // The switch to a new key is written now, with its cleared window (D141).
      const durability = switched ? "now" : durabilityOf(message);
      const ended = endedAt(ctx, arrival);
      const body = plaintext.slice(1);
      const lora = arrival.path === "lora" ? arrival : undefined;
      // Readings follow the newest packet only (section 8).
      const readings: Partial<KnownDevice> = newest
        ? {
            reading: isStatus(message) ? body : known.reading,
            heardAt: ctx.now.mono,
            heardMs: ctx.now.wall,
            heardTrusted: ctx.now.wallTrusted,
            rssi: lora?.rssiDbm ?? known.rssi,
            snrQ: lora?.snrQuarterDb ?? known.snrQ,
            bestGateway: lora?.gateway ?? known.bestGateway,
          }
        : {};
      const logged =
        message.type === MessageType.LogEntries
          ? logRecords(ctx, known, counter, ended, message.entries)
          : ok({ logs: known.logs, out: [] });
      return logged.andThen(({ logs, out: logOut }) => {
        const updated: KnownDevice = { ...known, ...readings, window: verdict.window, logs };
        const withDevice = withCopy(
          ctx,
          withDevices(slice, new Map(slice.devices).set(known.device, updated)),
          updated,
          arrival,
        );
        const next = switched ? switchedSlice(withDevice, known.device) : withDevice;
        const view = { ...ctx.view, intake: next };
        const started =
          message.type === MessageType.Started
            ? decisionMessage(
                ctx,
                {
                  kind: "device_started",
                  device: known.device,
                  cause: seq,
                  // FW5: the reset cause; the last fatal error is in the Started body of the
                  // `rx` row the decision names as its cause, as the protocol encodes it.
                  value: message.resetCause,
                },
                "now",
              ).map((m): readonly Out[] => [m])
            : ok<readonly Out[], CoreFault>([]);
        const keyChanged = switched
          ? decisionMessage(
              ctx,
              { kind: "key_changed", device: known.device, cause: seq, value: null },
              "now",
            ).map((m): readonly Out[] => [m])
          : ok<readonly Out[], CoreFault>([]);
        return Result.combine([started, keyChanged]).map(
          ([startedOut, keyOut]): Handled<"intake"> => ({
            slice: next,
            out: [
              recordMessage(durability, {
                kind: "rx",
                table: rxTableOf(message),
                row: rxRow(ctx, seq, known.device, message.type, counter, arrival, body),
              }),
              ...keyOut,
              {
                kind: "accepted",
                device: known.device,
                role: known.role,
                counter,
                message,
                arrival,
                record: seq,
                newest,
                ...(verdict.startedImage === undefined
                  ? {}
                  : { startedImage: verdict.startedImage }),
              },
              ...stateWrite(view, known.device, durability),
              ...logOut,
              ...startedOut,
            ],
          }),
        );
      });
    }),
  );
}

/** The device switched to its new key in this run: its key change is over (D141). */
function switchedSlice(slice: IntakeSlice, device: DeviceId): IntakeSlice {
  const rekey = new Map(slice.rekey);
  rekey.delete(device);
  return { ...slice, rekey, switched: new Set(slice.switched).add(device) };
}

/**
 * A packet under a key the hub held at the backup (D141): recorded, its `rx` row flagged `oldKey`
 * and routine (its window is untouched, so a replay of it is the same packet again, drawing at most
 * one Key change every 10 s ‡), and given to the module that owns the device's key as
 * `oldKeyPacket`. Which key it opened under is kept for that module: for a row both of whose keys
 * were held at the backup, it is the key the device holds, and the row is then `Required`.
 */
function onOldKey(
  slice: IntakeSlice,
  verdict: Extract<Verdict, { kind: "oldKey" }>,
  arrival: Arrival,
  ctx: Context,
): Step {
  const known = slice.devices.get(verdict.device);
  if (known === undefined) return ok({ slice, out: [] });
  const { message, counter, keyUsed } = verdict;
  return orFault(ctx, safeEncodeMessage(message)).andThen((plaintext) =>
    ctx.records.take().map((seq): Handled<"intake"> => {
      const rekey = new Map(slice.rekey).set(known.device, { bothHeld: false, lastKey: keyUsed });
      const row = rxRow(
        ctx,
        seq,
        known.device,
        message.type,
        counter,
        arrival,
        plaintext.slice(1),
        true,
      );
      return {
        slice: { ...slice, rekey },
        out: [
          recordMessage("routine", { kind: "rx", table: rxTableOf(message), row }),
          {
            kind: "oldKeyPacket",
            device: known.device,
            role: known.role,
            counter,
            message,
            arrival,
            record: seq,
          },
        ],
      };
    }),
  );
}

/**
 * An authentic packet that does not decode: its counter is entered in the window, its rejection
 * counted, and for an unknown type its record kept with its raw body, the plaintext after the
 * type byte (section 8; §5, §11).
 */
function onAuthenticInvalid(
  slice: IntakeSlice,
  verdict: Extract<Verdict, { kind: "authenticInvalid" }>,
  arrival: Arrival,
  bytes: Uint8Array,
  ctx: Context,
): Step {
  const known = slice.devices.get(verdict.device);
  if (known === undefined) return ok({ slice, out: [] });
  const next = withDevices(
    slice,
    new Map(slice.devices).set(known.device, { ...known, window: verdict.window }),
  );
  const counted = rejectedMessage(arrival, bytes, verdict.error.code, verdict.address);
  const type = unknownTypeOf(verdict.error);
  const view = { ...ctx.view, intake: next };
  if (type === undefined) {
    return carrierRecord(ctx, arrival, bytes).map((carrier) => ({
      slice: next,
      out: [counted, ...carrier, ...stateWrite(view, known.device, "routine")],
    }));
  }
  return ctx.records.take().map((seq) => ({
    slice: next,
    out: [
      counted,
      recordMessage("routine", {
        kind: "rx",
        table: "event",
        row: rxRow(
          ctx,
          seq,
          known.device,
          type,
          verdict.counter,
          arrival,
          verdict.plaintext.slice(1),
        ),
      }),
      ...stateWrite(view, known.device, "routine"),
    ],
  }));
}

/** Where the device is in a key change after a restore (`accept.ts`, `KeyState`). */
function keyStateOf(slice: IntakeSlice, device: DeviceId): KeyState {
  if (slice.switched.has(device)) return "switched";
  const rekey = slice.rekey.get(device);
  if (rekey === undefined) return "none";
  return rekey.bothHeld ? "bothHeld" : "required";
}

/** The key changes after a restore not finished at the last commit (D141). */
function rekeyOf(snapshot: DurableSnapshot): IntakeSlice["rekey"] {
  const m3m4 = snapshot.m3m4 ?? EMPTY_M3M4_SNAPSHOT;
  const both = new Set(m3m4.rekeyBothHeld ?? []);
  return new Map(
    m3m4.rekey.map((device) => [device, { bothHeld: both.has(device), lastKey: undefined }]),
  );
}

function onPacket(slice: IntakeSlice, bytes: Uint8Array, arrival: Arrival, ctx: Context): Step {
  const known = {
    deviceAt: (address: number) => slice.byAddress.get(address),
    windowOf: (device: DeviceId) => slice.devices.get(device)?.window ?? EMPTY_REPLAY_WINDOW,
    keyStateOf: (device: DeviceId) => keyStateOf(slice, device),
  };
  return orFault(ctx, checkPacket(known, ctx.deps.cipher, bytes, arrival)).andThen(
    (verdict): Step => {
      switch (verdict.kind) {
        case "rejected": {
          // A copy heard by a second gateway is a duplicate, counted for that gateway, that still
          // counts for a siren's best gateway (section 8): the message carries the copy's gateway
          // and signal, and intake keeps it for the device's own best gateway.
          const device =
            verdict.address === undefined ? undefined : slice.byAddress.get(verdict.address);
          const copier = device === undefined ? undefined : slice.devices.get(device);
          const duplicate = verdict.reason === "duplicate" && copier !== undefined;
          const copy: CopyHeard | undefined =
            duplicate && arrival.path === "lora"
              ? {
                  device: copier.device,
                  gateway: arrival.gateway,
                  snrQuarterDb: arrival.snrQuarterDb,
                  rssiDbm: arrival.rssiDbm,
                  at: ctx.now.mono,
                }
              : undefined;
          // A duplicate makes no row: its packet is the first copy's row, and the copy is counted
          // in `rejects` for its gateway and minute (section 6); a row each would double the
          // records of a home whose gateways all hear every sensor.
          const carried =
            verdict.reason === "duplicate" ? ok([]) : carrierRecord(ctx, arrival, bytes);
          return carried.map((carrier) => ({
            slice: duplicate ? withCopy(ctx, slice, copier, arrival) : slice,
            out: [
              rejectedMessage(arrival, bytes, verdict.reason, verdict.address, copy),
              ...carrier,
            ],
          }));
        }
        case "authenticInvalid":
          return onAuthenticInvalid(slice, verdict, arrival, bytes, ctx);
        case "accepted":
          return onAccepted(slice, verdict, arrival, ctx);
        case "oldKey":
          return onOldKey(slice, verdict, arrival, ctx);
      }
    },
  );
}

/** The intake module's handler. */
export const handleIntake: Handler<"intake"> = (slice, message, ctx) => {
  switch (message.kind) {
    case "boot":
      return ok({
        slice: withDevices(
          {
            ...slice,
            boot: message.boot.id,
            copies: new Map(),
            rekey: rekeyOf(message.snapshot),
            switched: new Set(),
          },
          fromSnapshot(message.snapshot),
        ),
        out: [],
      });
    case "deviceAdded":
      return ok({
        slice: withDevices(
          slice,
          new Map(slice.devices).set(
            message.device,
            newDevice(message.device, message.address, message.role),
          ),
        ),
        out: [],
      });
    case "deviceRemoved": {
      const devices = new Map(slice.devices);
      devices.delete(message.device);
      const rekey = new Map(slice.rekey);
      rekey.delete(message.device);
      const switched = new Set(slice.switched);
      switched.delete(message.device);
      return ok({ slice: { ...withDevices(slice, devices), rekey, switched }, out: [] });
    }
    case "devicePacket":
      return onPacket(slice, message.bytes, message.arrival, ctx);
    default:
      return ok({ slice, out: [] });
  }
};
