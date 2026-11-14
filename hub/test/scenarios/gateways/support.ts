/**
 * Support for the gateway scenarios (hub-design.md section 11, "Scenario tests"): the World
 * with the real dispatcher, the real `links` and `gateways` modules, and test doubles for the
 * rest, so these scenarios test the gateway rules and not the other modules, whose owners are
 * mid-edit. The doubles: an audit module that keeps every message it sees (it runs last, so it
 * sees them all), and a sensors module that answers every forwarded heartbeat the way the real
 * one does, with a `radioOut` at the reply moment on the delivering gateway's clock.
 */
import { ok } from "neverthrow";
import { MessageType, NO_BINDING, TransmitPriority } from "@hsn/protocol";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import { type DeviceId, sendRef } from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { ModuleName } from "../../../src/core/model/modules.ts";
import type { HubRules } from "../../../src/core/model/rules.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { makeCore, type ModuleDefinition, type Modules, MODULES } from "../../../src/core/step.ts";
import { ScriptedGateway } from "../../world/scripted-gateway.ts";
import { SeededBytes } from "../../world/entropy.ts";
import { type ScriptedDevice, World } from "../../world/world.ts";
import {
  configRow,
  deviceOf,
  deviceRow,
  GATEWAY_ADDRESS,
  keyOf,
  SECOND_GATEWAY_ADDRESS,
  SENSOR_ADDRESS,
  snapshotWith,
  toHub,
} from "../../unit/gateways/harness.ts";

export const SECOND = 1_000_000;
export const G1 = deviceOf(GATEWAY_ADDRESS);
export const G2 = deviceOf(SECOND_GATEWAY_ADDRESS);
export const SENSOR = deviceOf(SENSOR_ADDRESS);

/** Modules the scenarios leave out: they take every message and change nothing. */
const ignore =
  <K extends ModuleName>(): Handler<K> =>
  (slice) =>
    ok({ slice, out: [] });

export interface GatewayWorld {
  readonly world: World;
  /** Every internal message of every step, in order. */
  readonly seen: Internal[];
}

/** The reply a heartbeat gets: the moment after its end on the gateway's clock (§8, 1 s †). */
const REPLY_MOMENT_MICROS = SECOND;
/** The gateway clock wraps at 2³² µs (§6). */
const WRAP = 2 ** 32;

export interface WorldOptions {
  readonly rules?: HubRules;
  /** Answer each sensor packet's first copy with a heartbeat reply (the sensors double). */
  readonly reply?: boolean;
}

export function gatewayWorld(options: WorldOptions = {}): GatewayWorld {
  const seen: Internal[] = [];
  const answered = new Set<number>();
  let counter = 1;
  const audit: Handler<"audit"> = (slice, message) => {
    seen.push(message);
    return ok({
      slice,
      out:
        message.kind === "auditRecord"
          ? [{ kind: "record", durability: message.durability, record: message.record }]
          : [],
    });
  };
  const sensors: Handler<"sensors"> = (slice, message) => {
    // The sensor key's resume point, as pairing writes it, so the send gate lets replies go.
    if (message.kind === "boot") {
      return ok({
        slice,
        out: [
          {
            kind: "write",
            durability: "now",
            op: {
              table: "send_counters",
              op: "upsert",
              row: { deviceId: SENSOR, resumePoint: 1024 },
            },
          },
        ],
      });
    }
    if (
      options.reply !== true ||
      message.kind !== "devicePacket" ||
      message.arrival.path !== "lora"
    ) {
      return ok({ slice, out: [] });
    }
    const inner = new DataView(message.bytes.buffer, message.bytes.byteOffset).getUint32(5, true);
    if (answered.has(inner)) return ok({ slice, out: [] });
    answered.add(inner);
    const used = counter++;
    return ok({
      slice,
      out: [
        {
          kind: "radioOut",
          ref: sendRef(used),
          device: SENSOR,
          packet: new Uint8Array(32).fill(0x18),
          counter: used,
          gateway: message.arrival.gateway,
          timing: {
            kind: "at",
            gateway: message.arrival.gateway,
            gatewayMicros: (message.arrival.gatewayMicros + REPLY_MOMENT_MICROS) % WRAP,
          },
          dataRate: 5,
          powerDbm: 22,
          priority: TransmitPriority.Normal,
          purpose: "heartbeatReply",
        },
      ],
    });
  };
  const keep = <K extends ModuleName>(name: K): ModuleDefinition<K> => MODULES[name];
  const stub = <K extends ModuleName>(name: K): ModuleDefinition<K> => ({
    ...MODULES[name],
    handle: ignore<K>(),
    deadlines: () => [],
  });
  const modules: Modules = {
    clock: stub("clock"),
    registry: stub("registry"),
    links: keep("links"),
    setup: stub("setup"),
    control: stub("control"),
    people: stub("people"),
    layout: stub("layout"),
    app: stub("app"),
    schedules: stub("schedules"),
    gateways: keep("gateways"),
    intake: stub("intake"),
    alarm: stub("alarm"),
    site: stub("site"),
    sensors: { ...stub("sensors"), handle: sensors },
    slots: stub("slots"),
    sirens: stub("sirens"),
    health: stub("health"),
    notify: stub("notify"),
    upkeep: stub("upkeep"),
    audit: { ...stub("audit"), handle: audit },
  };
  const world = new World({
    core: makeCore(modules),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
  });
  return { world, seen };
}

/** Both vector gateways and the sensor paired. */
export function twoGatewaySnapshot(): DurableSnapshot {
  return snapshotWith({
    devices: [
      deviceRow(GATEWAY_ADDRESS, 3),
      deviceRow(SECOND_GATEWAY_ADDRESS, 3),
      deviceRow(SENSOR_ADDRESS, 1),
    ],
    gatewayConfig: [configRow(GATEWAY_ADDRESS), configRow(SECOND_GATEWAY_ADDRESS)],
    sendCounters: [
      { deviceId: G1, resumePoint: 1024 },
      { deviceId: G2, resumePoint: 1024 },
    ],
  });
}

/** A scripted gateway with a vector device's key, new randoms from a seed. */
export function scriptedGateway(
  address: number,
  options: {
    readonly seed?: number;
    readonly clockOffsetMicros?: number;
    readonly drift?: number;
    readonly radioPlaces?: number;
  } = {},
): ScriptedGateway {
  const random = new SeededBytes(options.seed ?? address);
  return new ScriptedGateway({
    key: keyOf(address),
    address,
    nextRandom: () => random.bytes(8),
    settingsVersion: 0,
    ...(options.clockOffsetMicros === undefined
      ? {}
      : { clockOffsetMicros: options.clockOffsetMicros }),
    ...(options.drift === undefined ? {} : { drift: options.drift }),
    ...(options.radioPlaces === undefined ? {} : { radioPlaces: options.radioPlaces }),
  });
}

/**
 * The gateway, connected as usual, which then drops every packet from the hub: its transmit
 * requests are never sent and never get a result.
 */
export function silentOnRequests(gateway: ScriptedGateway): ScriptedDevice {
  return {
    nextWake: () => gateway.nextWake(),
    wake: (now) => gateway.wake(now),
    receive: (bytes, now) => (gateway.settings === undefined ? gateway.receive(bytes, now) : []),
  };
}

/** The vectors' heartbeat with its own counter, as the sensor sends it. */
export function heartbeat(counter: number): Uint8Array {
  return toHub(
    SENSOR_ADDRESS,
    {
      type: MessageType.Heartbeat,
      settingsVersion: 7,
      flags: {
        doorOpen: false,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: true,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: false,
      },
      batteryCode: 100,
      temperatureCelsius: 20,
      doorChangeCount: 0,
      eventAgeSeconds: 0,
    },
    counter,
    NO_BINDING,
  );
}

/** Messages of one kind among those seen. */
export function seenOf<K extends Internal["kind"]>(
  seen: readonly Internal[],
  kind: K,
): Extract<Internal, { readonly kind: K }>[] {
  return seen.filter((m): m is Extract<Internal, { readonly kind: K }> => m.kind === kind);
}

/** The decision kinds recorded so far, with their gateway. */
export function decisions(
  seen: readonly Internal[],
): readonly (readonly [string, DeviceId | null])[] {
  return seenOf(seen, "auditRecord").flatMap((m) =>
    m.record.kind === "decision" ? [[m.record.row.kind, m.record.row.deviceId] as const] : [],
  );
}

export { mono };
export type { Mono };
