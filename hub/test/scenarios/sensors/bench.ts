/**
 * A bench for E2's tests over the frozen `World` (hub/test/world/world.ts): the real `step` with
 * the stand-ins of `stand-ins.ts`, a cipher holding as many sensor keys as a test needs, a boot
 * snapshot made from sensor rows, and a gateway link whose far end records the transmit requests
 * and answers them when told.
 * The World is given this bench's cipher, which holds a key for every sensor of the test.
 */
import { expect } from "bun:test";
import type { Result } from "neverthrow";
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  ResumeStep,
} from "@hsn/protocol";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import type { DecisionKind } from "../../../src/core/model/decisions.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import {
  type DeviceId,
  deviceId,
  type LinkId,
  requestId,
  connId,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import {
  ArmState,
  DeviceState,
  MoveStage,
  NEXT_SETTING_STAYS,
  type SensorConfigRow,
  type SiteRow,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { defaultSiteRow } from "../../../src/core/site/handle.ts";
import { encodeHistory } from "../../../src/core/sensors/settings.ts";
import type { Commit } from "../../world/recording-writer.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot, type ScriptedDevice, World } from "../../world/world.ts";
import { forwardedFrame, readRequest, resultFrame, type StandIns, standIns } from "./stand-ins.ts";

export const SECOND = 1_000_000;

/** A sensor of the bench. */
export interface BenchSensor {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
  readonly name: string;
}

/** `count` sensors with distinct addresses and keys, devices 3 onwards. */
export function benchSensors(count: number, firstDevice = 3): readonly BenchSensor[] {
  return Array.from({ length: count }, (_, i) => ({
    device: deviceId(firstDevice + i),
    address: 0x5e000001 + i,
    key: new Uint8Array(16).map((_, j) => (0x30 + i * 7 + j * 13) & 0xff),
    name: `sensor-${i + 1}`,
  }));
}

/** A sensor's settings row with the defaults of a new sensor at `rate`, changed by `over`. */
export function sensorRow(
  device: DeviceId,
  rate: number,
  over: Partial<SensorConfigRow> = {},
): SensorConfigRow {
  const version = over.version ?? 1;
  const replyRate = over.replyRate ?? rate;
  return {
    deviceId: device,
    arm: ArmState.Disarmed,
    armedBoot: null,
    armedMono: null,
    countdownS: 30,
    heartbeatUnits: 12,
    linkCheckEvery: 5,
    sendRate: rate,
    replyRate,
    replyRateFixed: false,
    correctionUnits: 0,
    correctionFixed: false,
    nextChannel: NEXT_SETTING_STAYS,
    nextRate: NEXT_SETTING_STAYS,
    moveConfirmed: 0,
    moveFollowed: 0,
    version,
    versionHistory: encodeHistory([{ version, replyRate, move: 0 }]),
    ...over,
  };
}

/** The site row on channel 1 (868.3 MHz) at `rate`, changed by `over`. */
export function siteRowAt(
  rate: number,
  over: Partial<SiteRow> = {},
  rules: HubRules = DEFAULT_RULES,
): SiteRow {
  return { ...defaultSiteRow(rules), channel: 1, rateMask: 1 << rate, ...over };
}

/** A snapshot holding `sensors`, each paired and with its row, at site rate `rate`. */
export function sensorSnapshot(
  sensors: readonly BenchSensor[],
  rate: number,
  options: {
    readonly configs?: readonly SensorConfigRow[];
    readonly site?: SiteRow;
    readonly resumePoint?: number;
    readonly extra?: Partial<DurableSnapshot>;
  } = {},
): DurableSnapshot {
  const configs = new Map((options.configs ?? []).map((c) => [c.deviceId, c]));
  return {
    ...emptySnapshot(),
    devices: sensors.map((s) => ({
      id: s.device,
      address: s.address,
      role: 1,
      name: s.name,
      chipId: new Uint8Array(6),
      firmware: 0x010000,
      development: true,
      state: DeviceState.Contacted,
      addedMs: 0,
      removedMs: null,
    })),
    sendCounters: sensors.map((s) => ({
      deviceId: s.device,
      resumePoint: options.resumePoint ?? ResumeStep.Hub,
    })),
    site: options.site ?? siteRowAt(rate),
    sensorConfig: sensors.map((s) => configs.get(s.device) ?? sensorRow(s.device, rate)),
    ...options.extra,
  };
}

/** A transmit request as the far end of the gateway link got it. */
export interface Request {
  readonly at: Mono;
  readonly counter: number;
  readonly request: NonNullable<ReturnType<typeof readRequest>>["request"];
}

/** The far end of the gateway link: it keeps every transmit request and answers when told. */
export class RecordingGateway implements ScriptedDevice {
  readonly requests: Request[] = [];
  #pending: Uint8Array[] = [];
  nextWake(): Mono | undefined {
    return undefined;
  }
  wake(): readonly Uint8Array[] {
    return [];
  }
  receive(bytes: Uint8Array, now: Mono): readonly Uint8Array[] {
    const read = readRequest(bytes);
    if (read !== undefined) this.requests.push({ at: now, ...read });
    const pending = this.#pending;
    this.#pending = [];
    return pending;
  }
  /** The result frame for a request, to deliver. */
  result(request: Request, result: number, sentAtMicros = 0): Uint8Array {
    return resultFrame(request.counter, result, sentAtMicros);
  }
}

/** The bench: a World over the stand-ins, with this bench's cipher. */
export class Bench {
  readonly stand: StandIns;
  readonly world: World;
  readonly cipher: VectorCipher;
  readonly sensors: readonly BenchSensor[];
  readonly link: LinkId;
  readonly gateway: ScriptedDevice;

  constructor(
    sensors: readonly BenchSensor[],
    options: {
      readonly rules?: HubRules;
      readonly gateway?: ScriptedDevice;
      readonly stand?: StandIns;
      readonly seed?: number;
    } = {},
  ) {
    this.sensors = sensors;
    this.cipher = new VectorCipher(
      sensors.map((s) => ({ device: s.device, address: s.address, key: s.key })),
    );
    this.stand = options.stand ?? standIns();
    const worldOptions = {
      core: this.stand.core,
      cipher: this.cipher,
      ...(options.rules === undefined ? {} : { rules: options.rules }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    };
    this.world = new World(worldOptions);
    this.gateway = options.gateway ?? new RecordingGateway();
    this.link = this.world.openLink("network", "gw", this.gateway);
  }

  get rules(): HubRules {
    return this.world.deps.rules;
  }

  boot(snapshot: DurableSnapshot, id = 1): void {
    must(this.world.boot(snapshot, id));
  }

  /** Seals a packet from sensor `index` (0-based) with `counter`. */
  seal(index: number, message: Message, counter: number): Uint8Array {
    const sensor = this.sensors[index];
    expect(sensor).toBeDefined();
    if (sensor === undefined) return new Uint8Array();
    const sealed = this.cipher.seal(sensor.device, message, {
      direction: Direction.ToHub,
      address: sensor.address,
      counter,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    });
    expect(sealed.isOk()).toBe(true);
    return sealed.unwrapOr(new Uint8Array());
  }

  /** Advances to `endedAt` + `delayMs` and delivers `packet` forwarded as ending at `endedAt`. */
  hear(
    packet: Uint8Array,
    endedAt: Mono,
    rate: number,
    options: {
      readonly delayMs?: number;
      readonly channel?: number;
      readonly snrQuarterDb?: number;
    } = {},
  ): void {
    const at = mono(endedAt + (options.delayMs ?? 30) * 1000);
    if (at > this.world.now.mono) must(this.world.advanceTo(at));
    const radio = {
      endedAt,
      dataRate: rate,
      siteChannel: options.channel ?? 1,
      ...(options.snrQuarterDb === undefined ? {} : { snrQuarterDb: options.snrQuarterDb }),
    };
    must(this.world.deliver(this.link, forwardedFrame(packet, radio)));
  }

  /** Delivers a frame on the gateway link now. */
  deliver(bytes: Uint8Array): void {
    must(this.world.deliver(this.link, bytes));
  }

  command(command: ControlCommand, request = 1): void {
    must(
      this.world.input({
        kind: "command",
        conn: connId(0),
        request: requestId(request),
        actor: "test",
        command,
      }),
    );
  }

  /** Effects of a kind. */
  effects<K extends Effect["kind"]>(kind: K): Extract<Effect, { kind: K }>[] {
    return this.world.effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
  }

  records(): AuditRecord[] {
    return this.effects("record").map((e) => e.record);
  }

  decisions(kind?: DecisionKind): Extract<AuditRecord, { kind: "decision" }>["row"][] {
    return this.records()
      .flatMap((r) => (r.kind === "decision" ? [r.row] : []))
      .filter((row) => kind === undefined || row.kind === kind);
  }

  messages<K extends Internal["kind"]>(kind: K): Extract<Internal, { kind: K }>[] {
    return this.stand.messages.filter((m): m is Extract<Internal, { kind: K }> => m.kind === kind);
  }

  /** The replies sent so far, opened as the sensor would, bound to `answered`. */
  openReply(index: number, packet: Uint8Array, answered: number): Message | undefined {
    const sensor = this.sensors[index];
    if (sensor === undefined) return undefined;
    return openFromHub(sensor.key, packet, answered);
  }
}

/** Opens a packet from the hub as a sensor does: bound to one of its counters (§4). */
export function openFromHub(
  key: Uint8Array,
  packet: Uint8Array,
  answered: number,
): Message | undefined {
  const opened = openPacket(packet, {
    key,
    expectedDirection: Direction.FromHub,
    binding: counterBinding(answered),
    maxLength: MaxPacketLength.Radio,
  });
  return opened.ok ? opened.value.message : undefined;
}

/** A heartbeat body (§6) with the given fields over a quiet default. */
export function heartbeat(
  over: Partial<Extract<Message, { type: typeof MessageType.Heartbeat }>> = {},
): Message {
  return {
    type: MessageType.Heartbeat,
    settingsVersion: 1,
    flags: {
      doorOpen: false,
      coverOpen: false,
      usbPower: false,
      charging: false,
      replyWanted: false,
      localAlarmSounded: false,
      buzzing: false,
      listeningAtSendRate: false,
    },
    batteryCode: 120,
    temperatureCelsius: 21,
    doorChangeCount: 0,
    eventAgeSeconds: 0,
    ...over,
  };
}

/** A sensor status flags object with `set` true. */
export function flags(
  set: Partial<Extract<Message, { type: typeof MessageType.Heartbeat }>["flags"]> = {},
): Extract<Message, { type: typeof MessageType.Heartbeat }>["flags"] {
  return {
    doorOpen: false,
    coverOpen: false,
    usbPower: false,
    charging: false,
    replyWanted: false,
    localAlarmSounded: false,
    buzzing: false,
    listeningAtSendRate: false,
    ...set,
  };
}

/** Fails the test on a stalled world or a fault, showing it. */
export function must(result: Result<unknown, unknown>): void {
  expect(result.isErr() ? result.error : undefined).toBeUndefined();
}

export { MoveStage };

/**
 * What the database holds after `commits`, over `base`: each committed upsert or delete applied
 * to its table by its key (section 5: only what was committed survives a crash). The tables of
 * E2's modules and those a restart of them reads.
 */
export function snapshotFrom(base: DurableSnapshot, commits: readonly Commit[]): DurableSnapshot {
  let snapshot = base;
  const upsert = <T>(rows: readonly T[], row: T, same: (a: T, b: T) => boolean): readonly T[] => [
    ...rows.filter((r) => !same(r, row)),
    row,
  ];
  for (const commit of commits) {
    for (const item of commit.items) {
      if (item.kind !== "write" || item.op.op !== "upsert") continue;
      const op = item.op;
      switch (op.table) {
        case "send_counters":
          snapshot = {
            ...snapshot,
            sendCounters: upsert(
              snapshot.sendCounters,
              op.row,
              (a, b) => a.deviceId === b.deviceId,
            ),
          };
          break;
        case "sensor_config":
          snapshot = {
            ...snapshot,
            sensorConfig: upsert(
              snapshot.sensorConfig,
              op.row,
              (a, b) => a.deviceId === b.deviceId,
            ),
          };
          break;
        case "device_state":
          snapshot = {
            ...snapshot,
            deviceState: upsert(snapshot.deviceState, op.row, (a, b) => a.deviceId === b.deviceId),
          };
          break;
        case "loss_daily":
          snapshot = {
            ...snapshot,
            lossDaily: upsert(
              snapshot.lossDaily,
              op.row,
              (a, b) => a.deviceId === b.deviceId && a.day === b.day,
            ),
          };
          break;
        case "site":
          snapshot = { ...snapshot, site: op.row };
          break;
        default:
          break;
      }
    }
  }
  return snapshot;
}
