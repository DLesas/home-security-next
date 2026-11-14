/**
 * A home for the alarm and siren scenarios (hub-design.md section 11): the World with the real
 * alarm and sirens modules, and small stand-ins for the modules other engineers are writing, each
 * doing only what these scenarios need and keeping its own state in this harness, never in its
 * slice:
 * - clock: the downtime by the wall clock (section 5, rule 1), at boot or when the clock is trusted;
 * - control: `command` inputs into the request messages, and `answer` into `respond`;
 * - intake: frames opened by address, replay windows, `accepted` with arrival and newest flag; a
 *   frame on a radio link counts as forwarded by that link's gateway;
 * - gateways: a radio link is a gateway (`gatewayUp` on open), `radioOut` is sent on its link;
 * - sensors: `sensor_config` written now on `armedChanged`, with the arming from the alarm's view;
 * - audit: `auditRecord` into `record` effects, and every message kept for the tests.
 * Sensors here have keys of their own, opened by the harness; sirens are vector devices, sealed by
 * the World's cipher.
 */
import { expect } from "bun:test";
import { ok } from "neverthrow";
import {
  checkReplayWindow,
  Direction,
  EMPTY_REPLAY_WINDOW,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  type ReplayWindow,
  Role,
  sealPacket,
  SirenAction,
} from "@hsn/protocol";
import { armedSince, armState } from "../../../src/core/alarm/view.ts";
import type { ControlCommand } from "../../../src/core/model/control.ts";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot } from "../../../src/core/model/events.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import {
  bootId,
  type DeviceId,
  deviceId,
  HUB_DEVICE,
  type LinkId,
  requestId,
  seq,
} from "../../../src/core/model/ids.ts";
import type { Internal } from "../../../src/core/model/messages.ts";
import type { DecisionKind } from "../../../src/core/model/decisions.ts";
import {
  ArmState,
  type DecisionRow,
  DeviceState,
  TxOutcome,
} from "../../../src/core/model/rows.ts";
import { DEFAULT_RULES, type HubRules } from "../../../src/core/model/rules.ts";
import type { StateTable } from "../../../src/core/model/store.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { makeCore, type ModuleDefinition, type Modules, MODULES } from "../../../src/core/step.ts";
import { ScriptedSiren } from "../../world/scripted-siren.ts";
import { VectorCipher } from "../../world/vector-cipher.ts";
import { emptySnapshot, World } from "../../world/world.ts";

/** The `commands` record a stand-in control gives every request. */
const STAND_IN_RECORD = seq(0);

export const SECOND = 1_000_000;
export const START_WALL_MS = Date.UTC(2026, 10, 13, 8);

/** The vector devices that play sirens here (both have keys in the World's cipher). */
export const SIREN_DEVICES = [deviceId(5), deviceId(3)] as const;
const FIRST_SENSOR = 100;
const FIRST_GATEWAY = 900;

export interface SensorSpec {
  readonly name: string;
  readonly countdownS?: number;
  readonly arm?: ArmState;
}

export interface SirenSpec {
  readonly name: string;
  /** Which paths it has at the start. */
  readonly wifi?: boolean;
  readonly lora?: boolean;
  readonly maxSoundS?: number;
  readonly sendRate?: number;
}

export interface HomeOptions {
  readonly sensors: readonly SensorSpec[];
  readonly sirens: readonly SirenSpec[];
  readonly rules?: HubRules;
  readonly wallTrusted?: boolean;
  readonly autoStopS?: number;
}

interface SensorKey {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
  counter: number;
  changeCount: number;
}

/** What the stand-ins remember across steps: one per run of the hub. */
interface StandInState {
  readonly windows: Map<DeviceId, ReplayWindow>;
  downtimeKnown: boolean;
  bootMono: Mono;
}

/** One kept message, with when. */
export interface Seen {
  readonly at: Mono;
  readonly message: Internal;
}

export class Home {
  world: World;
  readonly options: HomeOptions;
  readonly sensors = new Map<string, SensorKey>();
  readonly sirens = new Map<
    string,
    { readonly device: DeviceId; readonly scripted: ScriptedSiren }
  >();
  /** Each siren's Wi-Fi link and radio link in the current run. */
  readonly wifiLinks = new Map<string, LinkId>();
  readonly radioLinks = new Map<string, LinkId>();
  readonly gatewayOf = new Map<LinkId, DeviceId>();
  /** The radio link door reports arrive on: the first siren's, or one of its own. */
  sensorRadio: LinkId;
  seen: Seen[] = [];
  readonly cipher: VectorCipher;
  readonly names = new Map<string, DeviceId>();
  #state: StandInState;
  #snapshot: DurableSnapshot;
  #nextRequest = 1;
  /** Sirens whose Wi-Fi comes back on the restarted hub. */
  readonly #reconnect = new Map<ScriptedSiren, boolean>();
  #boot = 1;

  constructor(options: HomeOptions) {
    this.options = options;
    const vectors = VectorCipher.fromVectors();
    const sensorDevices = options.sensors.map((spec, i) => {
      const key = new Uint8Array(16).map((_, j) => (i * 31 + j * 7 + 1) & 0xff);
      const entry: SensorKey = {
        device: deviceId(FIRST_SENSOR + i),
        address: 0x5e000001 + i,
        key,
        counter: 64,
        changeCount: 0,
      };
      this.sensors.set(spec.name, entry);
      this.names.set(spec.name, entry.device);
      return { device: entry.device, address: entry.address, key };
    });
    this.cipher = new VectorCipher([...vectors.devices, ...sensorDevices]);
    options.sirens.forEach((spec, i) => {
      const device = SIREN_DEVICES[i];
      const vector =
        device === undefined ? undefined : vectors.devices.find((d) => d.device === device);
      if (device === undefined || vector === undefined) return;
      this.names.set(spec.name, device);
      this.sirens.set(spec.name, {
        device,
        scripted: new ScriptedSiren({
          key: vector.key,
          address: vector.address,
          wifiUp: spec.wifi ?? true,
          phase: 0.5 + i * 0.1,
          settings: {
            version: 1,
            maxSoundS: spec.maxSoundS ?? 300,
            sendRate: spec.sendRate ?? 5,
            commandRate: spec.sendRate ?? 5,
          },
        }),
      });
    });
    this.#snapshot = this.#firstSnapshot();
    this.#state = this.#freshState();
    this.world = this.#newWorld(START_WALL_MS, options.wallTrusted ?? true);
    must(this.world.boot(this.#snapshot, this.#boot));
    this.sensorRadio = this.#openLinks();
  }

  get now(): Mono {
    return this.world.now.mono;
  }

  sirenDevice(name: string): DeviceId {
    return this.#siren(name).device;
  }

  scripted(name: string): ScriptedSiren {
    return this.#siren(name).scripted;
  }

  #siren(name: string): { readonly device: DeviceId; readonly scripted: ScriptedSiren } {
    const siren = this.sirens.get(name);
    expect(siren).toBeDefined();
    return (
      siren ?? {
        device: deviceId(0),
        scripted: new ScriptedSiren({ key: new Uint8Array(16), address: 1 }),
      }
    );
  }

  /** A device's id by its name. */
  sensor(name: string): DeviceId {
    const id = this.names.get(name);
    expect(id).toBeDefined();
    return id ?? deviceId(0);
  }

  #freshState(): StandInState {
    return { windows: new Map(), downtimeKnown: false, bootMono: mono(0) };
  }

  #firstSnapshot(): DurableSnapshot {
    const sensors = [...this.sensors].map(([name, s], i) => ({
      name,
      s,
      spec: this.options.sensors[i],
    }));
    const sirens = [...this.sirens].map(([name, s], i) => ({
      name,
      s,
      spec: this.options.sirens[i],
    }));
    const autoStopS = this.options.autoStopS ?? 300;
    return {
      ...emptySnapshot(),
      devices: [
        ...sensors.map(({ name, s }) => device(s.device, s.address, Role.Sensor, name)),
        ...sirens.map(({ name, s }) =>
          device(s.device, this.#vectorAddress(s.device), Role.Siren, name),
        ),
      ],
      sensorConfig: sensors.map(({ s, spec }) =>
        sensorConfig(s.device, spec?.arm ?? ArmState.Disarmed, spec?.countdownS ?? 30),
      ),
      sirenConfig: sirens.map(({ s, spec }) => ({
        deviceId: s.device,
        version: 1,
        wifiIntervalS: 30,
        loraCheckUnits: 20,
        maxSoundS: spec?.maxSoundS ?? 300,
        sendRate: spec?.sendRate ?? 5,
        commandRate: spec?.sendRate ?? 5,
        siteChannel: 1,
        versionHistory: new Uint8Array(),
      })),
      sendCounters: sirens.map(({ s }) => ({ deviceId: s.device, resumePoint: 1024 })),
      site: {
        channel: 1,
        rateMask: 1 << 5,
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
        autoStopS,
        replyPowerDbm: 22,
        sirenPowerDbm: 22,
        retentionRoutineDays: 30,
        retentionEventDays: 365,
      },
    };
  }

  #vectorAddress(id: DeviceId): number {
    return this.cipher.devices.find((d) => d.device === id)?.address ?? 0;
  }

  #newWorld(wallAtStartMs: number, wallTrusted: boolean): World {
    return new World({
      core: makeCore(this.#modules()),
      rules: this.options.rules ?? DEFAULT_RULES,
      wallAtStartMs,
      wallTrusted,
    });
  }

  /** Opens each siren's links, and the radio link door reports come on. */
  #openLinks(): LinkId {
    let index = 0;
    let first: LinkId | undefined;
    for (const [name, { scripted }] of this.sirens) {
      const spec = this.options.sirens[index];
      if (spec?.lora ?? true) {
        const radio = this.openRadio(name, scripted);
        first ??= radio;
      }
      if (this.#reconnect.get(scripted) === true) {
        this.wifiUp(name);
      } else if (scripted.wifiUp) {
        this.wifiLinks.set(name, this.world.openLink("network", `wifi:${name}`, scripted.wifi));
      }
      index++;
    }
    return first ?? this.openRadio("sensors", undefined);
  }

  /** A radio link: a gateway that hears a siren (if given) and the sensors. */
  openRadio(name: string, scripted: ScriptedSiren | undefined): LinkId {
    const gateway = deviceId(FIRST_GATEWAY + this.gatewayOf.size);
    const label = `radio:${name}`;
    // The gateway must be known before linkOpened reaches the stand-ins.
    const link = this.#predictLink();
    this.gatewayOf.set(link, gateway);
    const opened = this.world.openLink("network", label, scripted?.lora);
    this.radioLinks.set(name, opened);
    return opened;
  }

  /** The id the World gives its next link: one more than the highest so far. */
  #predictLink(): LinkId {
    return (Math.max(0, ...[...this.world.links.keys()]) + 1) as LinkId;
  }

  /** Wi-Fi of a siren goes down: the siren notices, and the hub's socket closes. */
  wifiDown(name: string): void {
    this.scripted(name).setWifi(false, this.now);
    const link = this.wifiLinks.get(name);
    if (link !== undefined) this.world.closeLink(link);
    this.wifiLinks.delete(name);
    this.#pumpRadio(name);
  }

  wifiUp(name: string): void {
    const siren = this.scripted(name);
    this.wifiLinks.set(name, this.world.openLink("network", `wifi:${name}`, siren.wifi));
    siren.setWifi(true, this.now);
    this.#flushWifi(name);
  }

  /** The siren's radio link closes: its gateway goes, so LoRa is lost both ways. */
  radioDown(name: string): void {
    const link = this.radioLinks.get(name);
    if (link !== undefined) this.world.closeLink(link);
    this.radioLinks.delete(name);
  }

  /** Delivers what a siren has waiting on its radio face at once. */
  #pumpRadio(name: string): void {
    const link = this.radioLinks.get(name);
    const siren = this.scripted(name);
    if (link === undefined) return;
    for (const bytes of siren.lora.wake(this.now)) must(this.world.deliver(link, bytes));
  }

  #flushWifi(name: string): void {
    const link = this.wifiLinks.get(name);
    if (link === undefined) return;
    for (const bytes of this.scripted(name).wifi.wake(this.now))
      must(this.world.deliver(link, bytes));
  }

  /** A door changed report from `sensor`, heard on its radio link, `ageS` seconds after the change. */
  door(
    sensor: string,
    open: boolean,
    options: { readonly ageS?: number; readonly newEvent?: boolean } = {},
  ): void {
    const key = this.#sensorKey(sensor);
    if (options.newEvent ?? true) key.changeCount = (key.changeCount + 1) % 256;
    this.#sensorPacket(key, MessageType.DoorChanged, open, options.ageS ?? 0, key.changeCount);
  }

  /** A heartbeat from `sensor`, showing a door state and change count. */
  heartbeat(sensor: string, open: boolean, changeCount?: number): void {
    const key = this.#sensorKey(sensor);
    this.#sensorPacket(key, MessageType.Heartbeat, open, 0, changeCount ?? key.changeCount);
  }

  /** A cover changed report: tamper, never a siren (D9). */
  cover(sensor: string, open: boolean, doorOpen = false): void {
    const key = this.#sensorKey(sensor);
    this.#sensorPacket(key, MessageType.CoverChanged, open, 0, key.changeCount, doorOpen);
  }

  #sensorKey(name: string): SensorKey {
    const key = this.sensors.get(name);
    expect(key).toBeDefined();
    return (
      key ?? {
        device: deviceId(0),
        address: 1,
        key: new Uint8Array(16),
        counter: 1,
        changeCount: 0,
      }
    );
  }

  #sensorPacket(
    key: SensorKey,
    type:
      | typeof MessageType.DoorChanged
      | typeof MessageType.Heartbeat
      | typeof MessageType.CoverChanged,
    open: boolean,
    ageS: number,
    changeCount: number,
    doorOpen = open,
  ): void {
    key.counter += 1;
    const packet = sealPacket(
      {
        type,
        settingsVersion: 1,
        flags: {
          doorOpen: type === MessageType.CoverChanged ? doorOpen : open,
          coverOpen: type === MessageType.CoverChanged && open,
          usbPower: false,
          charging: false,
          replyWanted: type === MessageType.DoorChanged,
          localAlarmSounded: false,
          buzzing: false,
          listeningAtSendRate: false,
        },
        batteryCode: 150,
        temperatureCelsius: 20,
        doorChangeCount: changeCount,
        eventAgeSeconds: ageS,
      },
      {
        key: key.key,
        direction: Direction.ToHub,
        address: key.address,
        counter: key.counter,
        binding: NO_BINDING,
        maxLength: MaxPacketLength.Radio,
      },
    );
    must(this.world.deliver(this.sensorRadio, packet));
  }

  /** A control command, as the CLI sends it; returns the reply. */
  command(command: ControlCommand, actor = "anna"): unknown {
    const request = requestId(this.#nextRequest++);
    must(this.world.input({ kind: "command", request, actor, command }));
    return this.world.replies.find((r) => r.request === request)?.reply;
  }

  advance(ms: number): void {
    must(this.world.advanceByMs(ms));
  }

  advanceTo(at: number): void {
    must(this.world.advanceTo(mono(at)));
  }

  /** Every decision recorded, in order. */
  decisions(kind?: DecisionKind): readonly (DecisionRow & { readonly durability: string })[] {
    return this.world.effects.flatMap((effect) =>
      effect.kind === "record" &&
      effect.record.kind === "decision" &&
      (kind === undefined || effect.record.row.kind === kind)
        ? [{ ...effect.record.row, durability: effect.durability }]
        : [],
    );
  }

  /** The messages of one kind the modules exchanged. */
  messagesOf<K extends Internal["kind"]>(
    kind: K,
  ): readonly (Seen & { readonly message: Extract<Internal, { kind: K }> })[] {
    return this.seen.filter(
      (s): s is Seen & { readonly message: Extract<Internal, { kind: K }> } =>
        s.message.kind === kind,
    );
  }

  /** The commands the hub sent a siren on any path, decoded by what the siren heard and acted on. */
  sends(predicate: (effect: Extract<Effect, { kind: "send" }>) => boolean = () => true) {
    return this.world.effects.filter(
      (e): e is Extract<Effect, { kind: "send" }> => e.kind === "send" && predicate(e),
    );
  }

  /**
   * The hub stops now and starts again after `downtimeMs`, on a new World from what was
   * committed, the last commit mark made now (the writer commits every second while a countdown
   * or alarm runs, section 5). Sirens carry on on their own clocks.
   */
  restart(downtimeMs: number, wallTrusted: boolean): void {
    const old = this.world;
    const now = old.now;
    const snapshot = this.#committedSnapshot(now.mono, now.wall, now.wallTrusted);
    for (const { scripted } of this.sirens.values()) {
      // Its socket to the old hub is gone; it reconnects to the new one (§7, siren reports).
      const reconnect = scripted.wifiUp;
      scripted.setWifi(false, now.mono);
      scripted.carryOver(now.mono, downtimeMs * 1000);
      scripted.acted.length = 0;
      scripted.reports.length = 0;
      scripted.heard.length = 0;
      this.#reconnect.set(scripted, reconnect);
    }
    this.#boot += 1;
    this.#snapshot = snapshot;
    this.#state = this.#freshState();
    this.wifiLinks.clear();
    this.radioLinks.clear();
    this.gatewayOf.clear();
    this.seen = [];
    this.world = this.#newWorld(now.wall + downtimeMs, wallTrusted);
    must(this.world.boot(snapshot, this.#boot));
    this.sensorRadio = this.#openLinks();
  }

  /** The wall clock becomes trusted now, reading `wallMs` (section 5): a Pi set by the network. */
  trustWall(wallMs: number): void {
    this.world.setWall(wallMs, true);
    // The next input carries the trusted time; the shell's trust check makes one (section 5).
    must(this.world.input({ kind: "tick" }));
  }

  #committedSnapshot(markMono: Mono, markWall: number, trusted: boolean): DurableSnapshot {
    const tables = new Map<string, Map<string, unknown>>();
    const base = this.#snapshot;
    const seed = (table: StateTable, rows: readonly object[]) => {
      tables.set(table, new Map(rows.map((row) => [rowKey(table, row), row])));
    };
    seed("countdowns", base.countdowns);
    seed("alarm", base.alarm === undefined ? [] : [base.alarm]);
    seed("alarm_triggers", base.alarmTriggers);
    seed("alarm_sirens", base.alarmSirens);
    seed("sensor_config", base.sensorConfig);
    seed("siren_config", base.sirenConfig);
    seed("send_counters", base.sendCounters);
    for (const commit of this.world.writer.commits) {
      for (const item of commit.items) {
        if (item.kind !== "write") continue;
        const { op } = item;
        if (op.op === "prune") continue;
        const table = tables.get(op.table);
        if (table === undefined) continue;
        if (op.op === "upsert") table.set(rowKey(op.table, op.row), op.row);
        else table.delete(op.key === undefined ? "" : String(Object.values(op.key)[0]));
      }
    }
    const rows = <T>(table: StateTable): T[] => [...(tables.get(table)?.values() ?? [])] as T[];
    return {
      ...base,
      countdowns: rows("countdowns"),
      alarm: rows<DurableSnapshot["alarm"]>("alarm")[0],
      alarmTriggers: rows("alarm_triggers"),
      alarmSirens: rows("alarm_sirens"),
      sensorConfig: rows("sensor_config"),
      sirenConfig: rows("siren_config"),
      sendCounters: rows("send_counters"),
      deviceState: [
        {
          deviceId: HUB_DEVICE,
          boot: bootId(this.#boot),
          lastSeenMono: markMono,
          lastSeenMs: markWall,
          clockOk: trusted,
          window: null,
          reading: null,
          rssi: null,
          snrQ: null,
          bestGatewayId: null,
          uptimeS: null,
          estimates: null,
        },
      ],
    };
  }

  #modules(): Modules {
    const pick = <K extends keyof Modules>(name: K, handle?: Handler<K>): ModuleDefinition<K> =>
      handle === undefined ? MODULES[name] : { ...MODULES[name], handle };
    const clock: Handler<"clock"> = (slice, message, ctx) => {
      const state = this.#state;
      if (message.kind === "boot") state.bootMono = ctx.now.mono;
      const mark = this.#snapshot.deviceState.find((r) => r.deviceId === HUB_DEVICE);
      const known =
        !state.downtimeKnown && mark !== undefined && mark.clockOk && ctx.now.wallTrusted;
      if (
        !known ||
        (message.kind !== "boot" && message.kind !== "tick" && message.kind !== "frame")
      ) {
        return ok({ slice, out: [] });
      }
      state.downtimeKnown = true;
      const sinceBoot = (ctx.now.mono - state.bootMono) / 1000;
      const downtimeMs = ctx.now.wall - mark.lastSeenMs - sinceBoot;
      return ok({ slice, out: [{ kind: "downtimeKnown", downtimeMs, source: "wallClock" }] });
    };
    const control: Handler<"control"> = (slice, message) => {
      if (message.kind === "answer") {
        return ok({
          slice,
          out: [{ kind: "respond", request: message.request, reply: message.reply }],
        });
      }
      if (message.kind !== "command") return ok({ slice, out: [] });
      const { command, request, actor } = message;
      const record = STAND_IN_RECORD;
      const ids = (target: "all" | readonly string[]) =>
        target === "all" ? ("all" as const) : target.map((name) => this.sensor(name));
      switch (command.kind) {
        case "arm":
          return ok({
            slice,
            out: [
              {
                kind: "armRequest",
                request,
                actor,
                record,
                sensors: ids(command.sensors),
                continueOpen: command.continue,
              },
            ],
          });
        case "disarm":
          return ok({
            slice,
            out: [{ kind: "disarmRequest", request, actor, record, sensors: ids(command.sensors) }],
          });
        case "sirenTest":
          return ok({
            slice,
            out: [
              {
                kind: "sirenTestRequest",
                request,
                actor,
                record,
                siren: this.sensor(command.name),
                seconds: command.seconds,
              },
            ],
          });
        case "sirenSet":
          return ok({
            slice,
            out: [
              {
                kind: "sirenSettingsRequest",
                request,
                actor,
                record,
                siren: this.sensor(command.name),
                maxSoundS: command.max,
              },
            ],
          });
        default:
          return ok({ slice, out: [] });
      }
    };
    const intake: Handler<"intake"> = (slice, message, ctx) => {
      if (message.kind !== "frame") return ok({ slice, out: [] });
      const address =
        message.bytes.length >= 5
          ? new DataView(message.bytes.buffer, message.bytes.byteOffset).getUint32(1, true)
          : 0;
      const found = this.cipher.deviceFor(address);
      if (found === undefined) return ok({ slice, out: [] });
      const key = found.key;
      const opened = openPacket(message.bytes, {
        key,
        expectedDirection: Direction.ToHub,
        binding: NO_BINDING,
        maxLength: MaxPacketLength.Link,
      });
      if (!opened.ok) return ok({ slice, out: [] });
      const window = this.#state.windows.get(found.device) ?? EMPTY_REPLAY_WINDOW;
      const counter = opened.value.header.counter;
      const check = checkReplayWindow(window, counter);
      if (!check.accepted) return ok({ slice, out: [] });
      this.#state.windows.set(found.device, check.state);
      const gateway = this.gatewayOf.get(message.link);
      const role = [...this.sirens.values()].some((s) => s.device === found.device)
        ? Role.Siren
        : Role.Sensor;
      return ctx.records.take().map((record) => ({
        slice,
        out: [
          {
            kind: "accepted",
            device: found.device,
            role,
            counter,
            message: opened.value.message,
            arrival:
              gateway === undefined
                ? { path: "wifi", link: message.link }
                : {
                    path: "lora",
                    gateway,
                    link: message.link,
                    gatewayCounter: 0,
                    gatewayLink: "network",
                    gatewayMicros: ctx.now.mono,
                    endedAt: ctx.now.mono,
                    rssiDbm: -90,
                    snrQuarterDb: 20,
                    dataRate: 5,
                    siteChannel: 1,
                  },
            record,
            newest: counter > window.highest,
          },
        ],
      }));
    };
    const gateways: Handler<"gateways"> = (slice, message) => {
      if (message.kind === "linkOpened") {
        const gateway = this.gatewayOf.get(message.link);
        return ok({
          slice,
          out: gateway === undefined ? [] : [{ kind: "gatewayUp", gateway, link: message.link }],
        });
      }
      if (message.kind === "linkClosed") {
        const gateway = this.gatewayOf.get(message.link);
        return ok({ slice, out: gateway === undefined ? [] : [{ kind: "gatewayDown", gateway }] });
      }
      if (message.kind !== "radioOut" || message.gateway === undefined)
        return ok({ slice, out: [] });
      const link = [...this.gatewayOf].find(([, g]) => g === message.gateway)?.[0];
      const open = link !== undefined && this.world.links.get(link)?.open === true;
      return ok({
        slice,
        out: [
          ...(open
            ? [
                {
                  kind: "send" as const,
                  link,
                  bytes: message.packet,
                  ref: message.ref,
                  counters: [{ device: message.device, counter: message.counter }],
                },
              ]
            : []),
          {
            kind: "radioResult",
            ref: message.ref,
            device: message.device,
            gateway: message.gateway,
            requestCounter: undefined,
            resultCounter: undefined,
            outcome: open ? TxOutcome.Sent : TxOutcome.NoResult,
            sentGatewayMicros: open ? 0 : undefined,
          },
        ],
      });
    };
    const sensors: Handler<"sensors"> = (slice, message, ctx) => {
      if (message.kind !== "armedChanged") return ok({ slice, out: [] });
      const since = armedSince(ctx.view, message.sensor);
      const row = {
        ...sensorConfig(
          message.sensor,
          armState(ctx.view, message.sensor) ?? ArmState.Disarmed,
          30,
        ),
        armedBoot: since?.boot ?? null,
        armedMono: since?.mono ?? null,
      };
      return ok({
        slice,
        out: [
          { kind: "write", durability: "now", op: { table: "sensor_config", op: "upsert", row } },
        ],
      });
    };
    const audit: Handler<"audit"> = (slice, message, ctx) => {
      this.seen.push({ at: ctx.now.mono, message });
      return ok({
        slice,
        out:
          message.kind === "auditRecord"
            ? [{ kind: "record", durability: message.durability, record: message.record }]
            : [],
      });
    };
    return {
      clock: pick("clock", clock),
      registry: pick("registry"),
      links: pick("links"),
      setup: pick("setup"),
      control: pick("control", control),
      gateways: pick("gateways", gateways),
      intake: pick("intake", intake),
      alarm: pick("alarm"),
      site: pick("site"),
      sensors: pick("sensors", sensors),
      slots: pick("slots"),
      sirens: pick("sirens"),
      audit: pick("audit", audit),
    };
  }
}

/** The world handled the input without a fault. */
export function must(result: { isOk(): boolean }): void {
  expect(result.isOk()).toBe(true);
}

function device(id: DeviceId, address: number, role: number, name: string) {
  return {
    id,
    address,
    role,
    name,
    chipId: new Uint8Array(6),
    firmware: 0x010000,
    development: true,
    state: DeviceState.Contacted,
    addedMs: START_WALL_MS,
    removedMs: null,
  };
}

export function sensorConfig(id: DeviceId, arm: ArmState, countdownS: number) {
  return {
    deviceId: id,
    arm,
    armedBoot: arm === ArmState.Disarmed ? null : bootId(1),
    armedMono: arm === ArmState.Disarmed ? null : mono(-3_600 * SECOND),
    countdownS,
    heartbeatUnits: 12,
    linkCheckEvery: 5,
    sendRate: 5,
    replyRate: 5,
    replyRateFixed: false,
    correctionUnits: 0,
    correctionFixed: false,
    nextChannel: 0xff,
    nextRate: 0xff,
    moveConfirmed: 0,
    moveFollowed: 0,
    version: 1,
    versionHistory: new Uint8Array(),
  };
}

function rowKey(table: StateTable, row: object): string {
  if (table === "alarm") return "";
  const value =
    "sensorId" in row
      ? row.sensorId
      : "sirenId" in row
        ? row.sirenId
        : "deviceId" in row
          ? row.deviceId
          : "";
  return String(value);
}

/** The siren command a sealed packet carries, opened with the siren's key, for the tests. */
export function openCommand(home: Home, sirenName: string, bytes: Uint8Array): Message | undefined {
  const device = home.sirenDevice(sirenName);
  const key = home.cipher.devices.find((d) => d.device === device)?.key;
  if (key === undefined) return undefined;
  const opened = openPacket(bytes, {
    key,
    expectedDirection: Direction.FromHub,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Link,
  });
  return opened.ok ? opened.value.message : undefined;
}

/** The siren command in a sealed packet, as action and seconds, or undefined for anything else. */
export function commandOf(
  home: Home,
  sirenName: string,
  bytes: Uint8Array,
): { readonly action: number; readonly seconds: number } | undefined {
  const message = openCommand(home, sirenName, bytes);
  return message?.type === MessageType.SirenCommand
    ? { action: message.action, seconds: message.soundSeconds }
    : undefined;
}

/** The commands a scripted siren acted on, "report now" left out, as action and seconds. */
export function actedCommands(home: Home, sirenName: string) {
  return home
    .scripted(sirenName)
    .acted.flatMap((a) =>
      a.message.type === MessageType.SirenCommand && a.message.action !== SirenAction.ReportNow
        ? [{ action: a.message.action, seconds: a.message.soundSeconds, at: a.at, path: a.path }]
        : [],
    );
}
