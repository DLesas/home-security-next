/**
 * Stand-ins for the modules E2's work meets but does not own, so intake, sensors, slots and site
 * can run in the real `step` today (hub-design.md section 11). Each does the least its owner's
 * module will do for these tests, and nothing more:
 *
 * - gateways: a forwarded packet on a link becomes a `devicePacket`, a `radioOut` a transmit
 *   request, a transmit result a `radioResult`. The link carries the gateway messages' plaintext
 *   (type byte and body, `encodeMessage`), since sessions are E1's; the gateway's clock is the
 *   hub's own, so the clock mapping is the identity.
 * - alarm: arming and disarming by command, a countdown for an armed sensor's door opening from
 *   the opening (D106), its end, and `countdownCancelled` on a disarm. Its countdowns are its
 *   timers, as `TimerKey` makes them.
 * - audit: keeps the next record sequence number; control: turns the commands these tests use
 *   into their messages and the answers into `respond` effects.
 */
import { ok } from "neverthrow";
import {
  decodeMessage,
  encodeMessage,
  MessageType,
  type MessageOf,
  TransmitWhen,
} from "@hsn/protocol";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import {
  type DeviceId,
  deviceId,
  type LinkId,
  linkId,
  type SendRef,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { ModuleName } from "../../../src/core/model/modules.ts";
import { ArmState } from "../../../src/core/model/rows.ts";
import { type Mono, mono, MICROS_PER_MILLISECOND } from "../../../src/core/model/time.ts";
import type { TimerOf } from "../../../src/core/model/timers.ts";
import type { Countdown } from "../../../src/core/alarm/state.ts";
import { allSensors, sensorEntry } from "../../../src/core/sensors/view.ts";
import {
  type Core,
  makeCore,
  type ModuleDefinition,
  type Modules,
  MODULES,
} from "../../../src/core/step.ts";

/** The `commands` record a stand-in control gives every request. */
const STAND_IN_RECORD = seq(0);

/** The gateway of these tests, on the first link a test opens; another link is another gateway. */
export const GATEWAY: DeviceId = deviceId(90);

/** The gateway whose forwarded packets come on `link`: 90 on link 1, 91 on link 2, and so on. */
export function gatewayOn(link: LinkId): DeviceId {
  return deviceId(GATEWAY + link - 1);
}

/** The header byte of a packet to the hub (§3), which no gateway message's plaintext starts with. */
const DEVICE_HEADER = 0x10;
/** The gateway's microsecond clock is 32 bits on the wire (§6). */
export const GATEWAY_CLOCK_WRAP = 2 ** 32;

/** The hub time whose low 32 bits are `micros`, nearest `now` (the identity clock mapping). */
export function unwrapNear(micros: number, now: Mono): Mono {
  const half = GATEWAY_CLOCK_WRAP / 2;
  const base = now - (now % GATEWAY_CLOCK_WRAP);
  let at = base + micros;
  if (at - now > half) at -= GATEWAY_CLOCK_WRAP;
  if (now - at > half) at += GATEWAY_CLOCK_WRAP;
  return mono(at);
}

/** What the stand-ins let a test see and steer. */
export interface StandIns {
  readonly core: Core;
  /** Sensors the alarm stand-in holds armed. */
  readonly armed: Set<DeviceId>;
  /** Every `radioOut` the core made, in order. */
  readonly radioOuts: Extract<Internal, { kind: "radioOut" }>[];
  /** Every internal message, for assertions on what modules said to each other. */
  readonly messages: Internal[];
  /** Devices `usbAdd` adds: by name, the id, address and role to give. */
  readonly toAdd: Map<
    string,
    { readonly device: DeviceId; readonly address: number; readonly role: number }
  >;
}

type ForwardedPacket = MessageOf<typeof MessageType.ForwardedPacket>;

/** The stand-in modules, over the real ones for everything else. */
export function standIns(
  replace: { readonly [K in ModuleName]?: Handler<K> } = {},
  /** Called when a site move switches: the gateway listens on the new settings at once (§7). */
  onSwitch: (channel: number | undefined, rate: number | undefined) => void = () => undefined,
  /** The downtime the clock stand-in says it learnt, at the first tick after the boot (D113). */
  downtimeMs?: number,
): StandIns {
  const armed = new Set<DeviceId>();
  const radioOuts: Extract<Internal, { kind: "radioOut" }>[] = [];
  const messages: Internal[] = [];
  const toAdd = new Map<
    string,
    { readonly device: DeviceId; readonly address: number; readonly role: number }
  >();
  const requests = new Map<number, { readonly ref: SendRef; readonly device: DeviceId }>();
  let nextRequest = 1;

  const gateways: Handler<"gateways"> = (slice, message, ctx) => {
    messages.push(message);
    if (message.kind === "frame") {
      // A device packet's own header (version 1, to the hub: 0x10) on a link: a siren's Wi-Fi.
      if (message.bytes[0] === DEVICE_HEADER) {
        return ok({
          slice,
          out: [
            {
              kind: "devicePacket",
              bytes: message.bytes,
              arrival: { path: "wifi", link: message.link },
            },
          ],
        });
      }
      const decoded = decodeMessage(message.bytes);
      if (!decoded.ok) return ok({ slice, out: [] });
      const m = decoded.value;
      if (m.type === MessageType.ForwardedPacket) {
        const fp: ForwardedPacket = m;
        return ok({
          slice,
          out: [
            {
              kind: "devicePacket",
              bytes: fp.packet,
              arrival: {
                path: "lora",
                gateway: gatewayOn(message.link),
                link: message.link,
                gatewayCounter: 0,
                gatewayMicros: fp.receivedAtMicros,
                endedAt: unwrapNear(fp.receivedAtMicros, ctx.now.mono),
                rssiDbm: fp.rssiDbm,
                snrQuarterDb: fp.snrQuarterDb,
                dataRate: fp.dataRate,
                siteChannel: fp.siteChannel,
              },
            },
          ],
        });
      }
      if (m.type === MessageType.TransmitResult) {
        const request = requests.get(m.requestCounter);
        if (request === undefined) return ok({ slice, out: [] });
        requests.delete(m.requestCounter);
        return ok({
          slice,
          out: [
            {
              kind: "radioResult",
              ref: request.ref,
              device: request.device,
              gateway: GATEWAY,
              requestCounter: undefined,
              outcome: m.result <= 4 ? (m.result as 0 | 1 | 2 | 3 | 4) : 4,
              sentGatewayMicros: m.sentAtMicros,
            },
          ],
        });
      }
      return ok({ slice, out: [] });
    }
    if (message.kind === "siteMove" && message.stage === "switched")
      onSwitch(message.channel, message.rate);
    if (message.kind === "radioOut") {
      radioOuts.push(message);
      const gatewayLink = linkId((message.gateway ?? GATEWAY) - GATEWAY + 1);
      const counter = nextRequest++;
      requests.set(counter, { ref: message.ref, device: message.device });
      const timing = message.timing;
      const request = encodeMessage({
        type: MessageType.TransmitRequest,
        when: timing.kind === "at" ? TransmitWhen.AtTime : TransmitWhen.AsSoonAsPossible,
        gatewayTimeMicros:
          timing.kind === "at"
            ? timing.gatewayMicros
            : timing.latest === undefined
              ? 0
              : Math.max(1, timing.latest % GATEWAY_CLOCK_WRAP),
        dataRate: message.dataRate,
        powerDbm: message.powerDbm,
        priority: message.priority,
        packet: message.packet,
      });
      // The request counter travels in the first bytes the far end echoes in its result.
      const tagged = new Uint8Array([
        ...request,
        counter & 0xff,
        (counter >> 8) & 0xff,
        (counter >> 16) & 0xff,
        counter >>> 24,
      ]);
      const send: Effect = {
        kind: "send",
        link: gatewayLink,
        bytes: tagged,
        ref: message.ref,
        counters: [{ device: message.device, counter: message.counter }],
      };
      return ok({ slice, out: [send] });
    }
    return ok({ slice, out: [] });
  };

  /**
   * The alarm stand-in keeps the alarm slice's countdowns and timers in the alarm module's own
   * shape (alarm/state.ts), so the alarm view's selectors that sensors and site read answer from it.
   */
  const alarm: Handler<"alarm"> = (slice, message, ctx) => {
    const withCountdowns = (countdowns: Map<DeviceId, Countdown>, alarmRunning = slice.alarm) => ({
      ...slice,
      countdowns,
      alarm: alarmRunning,
      timers: [...countdowns].map(([sensor, c]): TimerOf<"alarm"> => ({
        at: c.deadline,
        key: { module: "alarm", kind: "countdownEnd", sensor },
      })),
    });
    switch (message.kind) {
      case "armRequest":
      case "disarmRequest": {
        const targets =
          message.sensors === "all" ? allSensors(ctx.view).map((s) => s.device) : message.sensors;
        const arm = message.kind === "armRequest" ? ArmState.Armed : ArmState.Disarmed;
        const out: Internal[] = [];
        const countdowns = new Map(slice.countdowns);
        for (const sensor of targets) {
          if (arm === ArmState.Armed) armed.add(sensor);
          else armed.delete(sensor);
          out.push({ kind: "armedChanged", sensor, arm, cause: undefined });
          const running = countdowns.get(sensor);
          if (arm === ArmState.Disarmed && running !== undefined) {
            out.push({
              kind: "countdownCancelled",
              sensor,
              newestCounter: running.newestCounter,
              replyGateway: running.replyGateway,
              replyRate: running.replyRate,
              cause: running.cause,
            });
            countdowns.delete(sensor);
          }
        }
        return ok({ slice: withCountdowns(countdowns), out });
      }
      case "accepted": {
        const m = message.message;
        if (m.type !== MessageType.DoorChanged || !m.flags.doorOpen || !armed.has(message.device)) {
          return ok({ slice, out: [] });
        }
        if (message.arrival.path !== "lora") return ok({ slice, out: [] });
        const config = sensorEntry(ctx.view, message.device)?.config;
        const running = slice.countdowns.get(message.device);
        const countdowns = new Map(slice.countdowns);
        if (running !== undefined) {
          // The countdown's newest report: the disarmed notice's binding (§4).
          countdowns.set(message.device, { ...running, newestCounter: message.counter });
          return ok({ slice: withCountdowns(countdowns), out: [] });
        }
        if (config === undefined) return ok({ slice, out: [] });
        const openedAt = mono(message.arrival.endedAt - m.eventAgeSeconds * 1_000_000);
        const deadline = mono(openedAt + config.countdownS * 1_000_000);
        if (deadline <= ctx.now.mono) return ok({ slice, out: [] });
        countdowns.set(message.device, {
          openedAt,
          deadline,
          newestCounter: message.counter,
          replyGateway: message.arrival.gateway,
          replyRate: message.arrival.dataRate,
          cause: message.record,
          restored: false,
        });
        return ok({ slice: withCountdowns(countdowns), out: [] });
      }
      case "timer": {
        if (message.key.module !== "alarm" || message.key.kind !== "countdownEnd")
          return ok({ slice, out: [] });
        const countdowns = new Map(slice.countdowns);
        countdowns.delete(message.key.sensor);
        return ok({ slice: withCountdowns(countdowns), out: [] });
      }
      default:
        return ok({ slice, out: [] });
    }
  };

  /** Links stand-in: the frames go to the gateways stand-in, which is given every message. */
  const links: Handler<"links"> = (slice) => ok({ slice, out: [] });
  /** Registry, setup and sirens are not needed by these tests; they do nothing here. */
  const registry: Handler<"registry"> = (slice) => ok({ slice, out: [] });
  const setup: Handler<"setup"> = (slice) => ok({ slice, out: [] });
  const sirens: Handler<"sirens"> = (slice) => ok({ slice, out: [] });
  /** Clock stand-in: says how long the hub was down at the first tick, when a test gives it. */
  let downtimeSaid = false;
  const clock: Handler<"clock"> = (slice, message) => {
    if (message.kind !== "tick" || downtimeMs === undefined || downtimeSaid)
      return ok({ slice, out: [] });
    downtimeSaid = true;
    return ok({ slice, out: [{ kind: "downtimeKnown", downtimeMs, source: "wallClock" }] });
  };

  const audit: Handler<"audit"> = (slice, message) => {
    if (message.kind !== "auditRecord") return ok({ slice, out: [] });
    const recorded = message.record.kind === "reject" ? undefined : message.record.row.seq;
    const nextRecord =
      recorded !== undefined && recorded >= slice.nextRecord ? seq(recorded + 1) : slice.nextRecord;
    return ok({
      slice: { ...slice, nextRecord },
      out: [{ kind: "record", durability: message.durability, record: message.record }],
    });
  };

  const control: Handler<"control"> = (slice, message, ctx) => {
    if (message.kind === "answer")
      return ok({
        slice,
        out: [{ kind: "respond", request: message.request, reply: message.reply }],
      });
    if (message.kind !== "command") return ok({ slice, out: [] });
    const { command, request, actor } = message;
    const record = STAND_IN_RECORD;
    const named = (name: string): DeviceId | undefined =>
      allSensors(ctx.view).find((s) => s.name === name)?.device;
    const out: (Internal | Effect)[] = [];
    switch (command.kind) {
      case "siteChange":
        out.push({
          kind: "siteChangeRequested",
          request,
          actor,
          record,
          action: { kind: "start", channel: command.channel, rate: command.rate },
        });
        break;
      case "siteChangeStatus":
        out.push({
          kind: "siteChangeRequested",
          request,
          actor,
          record,
          action: { kind: "status" },
        });
        break;
      case "siteChangeCancel":
        out.push({
          kind: "siteChangeRequested",
          request,
          actor,
          record,
          action: { kind: "cancel" },
        });
        break;
      case "siteChangeForce":
        out.push({
          kind: "siteChangeRequested",
          request,
          actor,
          record,
          action: { kind: "force", yes: command.yes },
        });
        break;
      case "sensorSet": {
        const sensor = named(command.name);
        if (sensor === undefined) break;
        const change = {
          ...(command.countdown === undefined ? {} : { countdown: command.countdown }),
          ...(command.heartbeat === undefined ? {} : { heartbeat: command.heartbeat }),
          ...(command.linkCheck === undefined ? {} : { linkCheck: command.linkCheck }),
          ...(command.replyRate === undefined ? {} : { replyRate: command.replyRate }),
          ...(command.correction === undefined ? {} : { correction: command.correction }),
        };
        out.push({ kind: "sensorSettingsRequest", request, actor, record, sensor, change });
        break;
      }
      case "arm":
      case "disarm": {
        const sensors =
          command.sensors === "all" ? "all" : command.sensors.flatMap((n) => named(n) ?? []);
        out.push(
          command.kind === "arm"
            ? {
                kind: "armRequest",
                request,
                actor,
                record,
                sensors,
                continueOpen: command.continue,
              }
            : { kind: "disarmRequest", request, actor, record, sensors },
        );
        break;
      }
      case "usbAdd": {
        const added = toAdd.get(command.name);
        if (added === undefined) break;
        out.push(
          {
            kind: "deviceAdded",
            device: added.device,
            role: added.role,
            address: added.address,
            name: command.name,
          },
          // Setup writes the first resume point with the device's other rows (section 9).
          {
            kind: "write",
            durability: "now",
            op: {
              table: "send_counters",
              op: "upsert",
              row: { deviceId: added.device, resumePoint: 1024 },
            },
          },
        );
        break;
      }
      default:
        break;
    }
    return ok({ slice, out });
  };

  const handlers: { readonly [K in ModuleName]?: Handler<K> } = {
    clock,
    registry,
    setup,
    sirens,
    links,
    gateways,
    alarm,
    audit,
    control,
    ...replace,
  };
  const pick = <K extends ModuleName>(name: K): ModuleDefinition<K> => {
    const handle = handlers[name];
    return handle === undefined ? MODULES[name] : { ...MODULES[name], handle };
  };
  const modules: Modules = {
    clock: pick("clock"),
    registry: pick("registry"),
    links: pick("links"),
    setup: pick("setup"),
    control: pick("control"),
    gateways: pick("gateways"),
    intake: pick("intake"),
    alarm: pick("alarm"),
    site: pick("site"),
    sensors: pick("sensors"),
    slots: pick("slots"),
    sirens: pick("sirens"),
    audit: pick("audit"),
  };
  return { core: makeCore(modules), armed, radioOuts, messages, toAdd };
}

/** The forwarded packet's plaintext a gateway would send for a radio packet ending at `endedAt`. */
export function forwardedFrame(
  packet: Uint8Array,
  radio: {
    readonly endedAt: Mono;
    readonly dataRate: number;
    readonly siteChannel: number;
    readonly snrQuarterDb?: number;
    readonly rssiDbm?: number;
  },
): Uint8Array {
  return encodeMessage({
    type: MessageType.ForwardedPacket,
    receivedAtMicros: radio.endedAt % GATEWAY_CLOCK_WRAP,
    rssiDbm: radio.rssiDbm ?? -95,
    snrQuarterDb: radio.snrQuarterDb ?? 32,
    dataRate: radio.dataRate,
    siteChannel: radio.siteChannel,
    packet,
  });
}

/** A transmit request's plaintext and the request counter the stand-in tagged it with. */
export function readRequest(
  bytes: Uint8Array,
):
  | { readonly request: MessageOf<typeof MessageType.TransmitRequest>; readonly counter: number }
  | undefined {
  const counterAt = bytes.length - 4;
  const decoded = decodeMessage(bytes.subarray(0, counterAt));
  if (!decoded.ok || decoded.value.type !== MessageType.TransmitRequest) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset + counterAt, 4);
  return { request: decoded.value, counter: view.getUint32(0, true) };
}

/** A transmit result's plaintext. */
export function resultFrame(
  requestCounter: number,
  result: number,
  sentAtMicros: number,
): Uint8Array {
  return encodeMessage({
    type: MessageType.TransmitResult,
    requestCounter,
    result,
    sentAtMicros: sentAtMicros % GATEWAY_CLOCK_WRAP,
  });
}

/** Microseconds in a millisecond, re-exported for the tests' arithmetic. */
export const US_PER_MS = MICROS_PER_MILLISECOND;
