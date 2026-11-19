/**
 * A whole hub on a real store for the key change after a restore (D141, docs/m3-updates-design.md
 * section 7) and its restarts: the real core in the real loop (`shell/loop.ts`), over the real
 * writer, reader and `KeyStore` (`shell/storage/`), the real cipher (`shell/cipher/`), and the real
 * backup and restore (`shell/backup/`); on the far ends, devices written here on `@hsn/protocol`
 * that keep their keys as the firmware does and take a Key change (section 7, "Each device"):
 *
 * - `Sensor`: answers bound to one of its recent counters; on a Key change, the new key and its
 *   counters from one step (64);
 * - `Siren`: takes a packet only above the last counter it took; on a Key change, the new key, its
 *   counters from 1,024 and the last taken from nothing;
 * - `Gateway`: a hello, the welcome bound to its random, then its session; on a Key change in place
 *   of the welcome, the new key, its counters from 1,024, and a new hello; forwards what it hears
 *   and transmits what it is asked to, at once.
 *
 * Every packet a device sent is kept, so a test can replay it, as someone who recorded the air or
 * the home network would. A power cut keeps exactly the database's files as they are at that
 * moment (`synchronous = FULL`); the hub then starts again from them, the devices carrying on.
 */
import { expect } from "bun:test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  nodeSha256,
  openPacket,
  ResumeStep,
  sealPacket,
  sessionBinding,
  SirenReportReason,
  SirenState,
  toHex,
  welcomeBinding,
} from "@hsn/protocol";
import type { AuditRecord } from "../../../../src/core/model/audit.ts";
import type { ControlCommand, ControlReply } from "../../../../src/core/model/control.ts";
import type { DecisionKind } from "../../../../src/core/model/decisions.ts";
import type { HubEvent } from "../../../../src/core/model/events.ts";
import {
  connId,
  type DeviceId,
  deviceId,
  jobId,
  type LinkId,
  linkId,
  type RequestId,
  requestId,
} from "../../../../src/core/model/ids.ts";
import { DEFAULT_RULES, type HubRules } from "../../../../src/core/model/rules.ts";
import {
  type DeviceRow,
  DeviceState,
  type GatewayConfigRow,
  type SirenConfigRow,
} from "../../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../../src/core/model/store.ts";
import { type Mono, mono, type Now } from "../../../../src/core/model/time.ts";
import { type Core, makeCore, MODULES } from "../../../../src/core/step.ts";
import type { Clock } from "../../../../src/ports/clock.ts";
import type { StagedEffect } from "../../../../src/ports/writer.ts";
import { ensureHubKeys } from "../../../../src/shell/advertise/hub-keys.ts";
import { readHubKeysRow } from "../../../../src/shell/app/app-keys.ts";
import { runToEnd } from "../../../../src/shell/backup/jobs.ts";
import { RestorePieces, swapRestored } from "../../../../src/shell/backup/restore.ts";
import { UNBUILT_CALENDAR } from "../../../../src/shell/calendar/unbuilt.ts";
import { KeyStoreCipher } from "../../../../src/shell/cipher/device-cipher.ts";
import { HubLoop, type LoopWriter } from "../../../../src/shell/loop.ts";
import { MemoryKeyStore } from "../../../../src/shell/storage/keys.ts";
import { DATABASE_FILE, type OpenedStore, openStore } from "../../../../src/shell/storage/store.ts";
import { tempDir } from "../../../unit/storage/fixtures.ts";
import { SeededBytes } from "../../../world/entropy.ts";
import { heartbeat, sensorRow, siteRowAt } from "../bench.ts";

export const SECOND = 1_000_000;
export const MINUTE = 60 * SECOND;
const WALL_AT_START_MS = Date.UTC(2026, 10, 18);
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "..", "drizzle");
/** The phone's backup key (M2 9): made for the test. */
export const BACKUP_KEY = new Uint8Array(32).fill(0x5b);
const RATE = 5;
const CHANNEL = 1;

/** A device key made for the test. */
export function testKey(seed: number): Uint8Array {
  return new Uint8Array(16).map((_, j) => (seed * 41 + j * 17 + 3) & 0xff);
}

function sealFrom(
  key: Uint8Array,
  address: number,
  counter: number,
  message: Message,
  binding: Uint8Array,
  maxLength: MaxPacketLength,
): Uint8Array {
  return sealPacket(message, {
    key,
    direction: Direction.ToHub,
    address,
    counter,
    binding,
    maxLength,
  });
}

function openFrom(
  key: Uint8Array,
  bytes: Uint8Array,
  binding: Uint8Array,
  maxLength: MaxPacketLength,
): { readonly message: Message; readonly counter: number } | undefined {
  const opened = openPacket(bytes, {
    key,
    expectedDirection: Direction.FromHub,
    binding,
    maxLength,
  });
  return opened.ok
    ? { message: opened.value.message, counter: opened.value.header.counter }
    : undefined;
}

/** What every device keeps: its key, its next counter, what it sent and what it took. */
abstract class Device {
  key: Uint8Array;
  counter: number;
  readonly address: number;
  readonly id: DeviceId;
  readonly name: string;
  /** Every packet it sent, in order, for replays. */
  readonly sent: Uint8Array[] = [];
  /** Every packet from the hub it opened. */
  readonly took: Message[] = [];
  /** Each opened packet's key and counter, with its bytes: no pair may come with two contents. */
  readonly nonces: { readonly key: string; readonly counter: number; readonly bytes: string }[] =
    [];
  /** Every key it was given, in order (pairing's first). */
  readonly keys: Uint8Array[] = [];
  readonly step: number;

  constructor(id: DeviceId, address: number, name: string, key: Uint8Array, step: number) {
    this.id = id;
    this.address = address;
    this.name = name;
    this.key = key;
    this.step = step;
    this.counter = step;
    this.keys.push(key);
  }

  /** Section 7, "Each device": the new key, its counters from one step. */
  protected changeKey(newKey: Uint8Array): void {
    this.key = newKey.slice();
    this.keys.push(this.key);
    this.counter = this.step;
  }

  /** How many Key changes it took. */
  get keyChanges(): number {
    return this.keys.length - 1;
  }
}

export class Sensor extends Device {
  /** The counters of its current exchange, newest first: the hub may answer any (§4, up to 16). */
  #recent: number[] = [];

  constructor(id: DeviceId, address: number, name: string, key: Uint8Array) {
    super(id, address, name, key, ResumeStep.Sensor);
  }

  /** A packet of a new exchange, sealed now: answers to earlier ones are no longer taken. */
  packet(message: Message): Uint8Array {
    this.#recent = [];
    return this.retry(message);
  }

  /** Another try of the current exchange (§7, "No reply from the hub"), with a new counter. */
  retry(message: Message): Uint8Array {
    const counter = this.counter++;
    this.#recent = [counter, ...this.#recent].slice(0, 16);
    const bytes = sealFrom(
      this.key,
      this.address,
      counter,
      message,
      NO_BINDING,
      MaxPacketLength.Radio,
    );
    this.sent.push(bytes);
    return bytes;
  }

  /** A packet from the hub on the air: taken when it answers one of its counters. */
  receive(bytes: Uint8Array): Message | undefined {
    for (const counter of this.#recent) {
      const opened = openFrom(this.key, bytes, counterBinding(counter), MaxPacketLength.Radio);
      if (opened === undefined) continue;
      this.took.push(opened.message);
      this.nonces.push({ key: toHex(this.key), counter: opened.counter, bytes: toHex(bytes) });
      if (opened.message.type === MessageType.KeyChange) {
        this.changeKey(opened.message.newKey);
        this.#recent = [];
      }
      return opened.message;
    }
    return undefined;
  }
}

export class Siren extends Device {
  #lastTaken = 0;

  constructor(id: DeviceId, address: number, name: string, key: Uint8Array) {
    super(id, address, name, key, ResumeStep.SirenOrGateway);
  }

  /**
   * A report (§6): off, the version it holds, `reason`, naming the last command it acted on (the
   * last taken, unless `acted` says otherwise).
   */
  report(reason: number = SirenReportReason.Regular, version = 1, acted?: number): Uint8Array {
    const message: Message = {
      type: MessageType.SirenReport,
      settingsVersion: version,
      state: SirenState.Off,
      soundingSecondsLeft: 0,
      lastCommandCounterLow: (acted ?? this.#lastTaken) & 0xffff,
      flags: {
        onMains: true,
        cellFitted: false,
        charging: false,
        coverOpen: false,
        wifiConnected: true,
      },
      cellBatteryCode: 0,
      temperatureCelsius: 20,
      reason,
    };
    const bytes = sealFrom(
      this.key,
      this.address,
      this.counter++,
      message,
      NO_BINDING,
      MaxPacketLength.Radio,
    );
    this.sent.push(bytes);
    return bytes;
  }

  /** A packet from the hub on either path: taken only above the last counter taken (§4). */
  receive(bytes: Uint8Array): Message | undefined {
    const opened = openFrom(this.key, bytes, NO_BINDING, MaxPacketLength.Radio);
    if (opened === undefined || opened.counter <= this.#lastTaken) return undefined;
    this.#lastTaken = opened.counter;
    this.took.push(opened.message);
    if (opened.message.type === MessageType.KeyChange) {
      this.changeKey(opened.message.newKey);
      this.#lastTaken = 0;
    }
    return opened.message;
  }
}

export class Gateway extends Device {
  #random = new Uint8Array(8);
  #randoms = 0;
  #session: Uint8Array | undefined;
  #lastHub = 0;
  /** The device packets the hub asked it to transmit, in order. */
  readonly transmitted: Uint8Array[] = [];

  constructor(id: DeviceId, address: number, name: string, key: Uint8Array) {
    super(id, address, name, key, ResumeStep.SirenOrGateway);
  }

  get session(): Uint8Array | undefined {
    return this.#session;
  }

  #seal(message: Message, binding: Uint8Array): Uint8Array {
    const bytes = sealFrom(
      this.key,
      this.address,
      this.counter++,
      message,
      binding,
      MaxPacketLength.Link,
    );
    this.sent.push(bytes);
    return bytes;
  }

  hello(): Uint8Array {
    this.#randoms += 1;
    this.#random = new Uint8Array(8).fill(this.#randoms).map((b, i) => (b * 31 + i) & 0xff);
    this.#session = undefined;
    this.#lastHub = 0;
    return this.#seal(
      {
        type: MessageType.Hello,
        gatewayRandom: this.#random,
        firmwareVersion: { major: 1, minor: 0, patch: 0 },
        settingsVersion: 0,
      },
      NO_BINDING,
    );
  }

  /** A status on its session (§6): what proves a session it was welcomed into. */
  status(): Uint8Array | undefined {
    if (this.#session === undefined) return undefined;
    return this.#seal(
      {
        type: MessageType.GatewayStatus,
        settingsVersion: 1,
        uptimeSeconds: 100,
        airtimeHundredthsPercent: 0,
        noiseMedianDbm: -110,
        noiseHighestDbm: -100,
        normalNoiseDbm: -110,
        packetsReceived: 0,
        packetsCrcFailed: 0,
        wifiRssiDbm: -50,
        flags: { usbConnected: false, cellFitted: false, onMains: true },
      },
      this.#session,
    );
  }

  /** A device packet heard on the air, forwarded on its session. */
  forward(packet: Uint8Array, receivedAtMicros: number): Uint8Array | undefined {
    if (this.#session === undefined) return undefined;
    return this.#seal(
      {
        type: MessageType.ForwardedPacket,
        receivedAtMicros: receivedAtMicros % 2 ** 32,
        rssiDbm: -90,
        snrQuarterDb: 30,
        dataRate: RATE,
        siteChannel: CHANNEL,
        packet,
      },
      this.#session,
    );
  }

  /** A frame from the hub; what it sends back at once. */
  receive(bytes: Uint8Array): readonly Uint8Array[] {
    const binding = this.#session ?? welcomeBinding(this.#random);
    const opened = openFrom(this.key, bytes, binding, MaxPacketLength.Link);
    if (opened === undefined || opened.counter <= this.#lastHub) return [];
    this.#lastHub = opened.counter;
    const message = opened.message;
    this.took.push(message);
    switch (message.type) {
      case MessageType.Welcome:
        this.#session = sessionBinding(this.#random, message.hubRandom);
        return [];
      case MessageType.KeyChange:
        // In place of the welcome (§6): the new key, then a new hello under it.
        this.changeKey(message.newKey);
        return [this.hello()];
      case MessageType.GatewaySettings: {
        const status = this.status();
        return status === undefined ? [] : [status];
      }
      case MessageType.TransmitRequest: {
        this.transmitted.push(message.packet);
        const session = this.#session;
        if (session === undefined) return [];
        return [
          this.#seal(
            {
              type: MessageType.TransmitResult,
              requestCounter: opened.counter,
              result: 0,
              sentAtMicros: 0,
            },
            session,
          ),
        ];
      }
      default:
        return [];
    }
  }
}

/** Where a power cut falls in a turn (hub-design.md section 4's table). */
export type CutPoint = "beforeCommit" | "afterCommit" | "afterSends";

class TestClock implements Clock {
  trueUs = 0;
  bootAtUs = 0;
  now(): Now {
    return {
      mono: mono(this.trueUs - this.bootAtUs),
      wall: WALL_AT_START_MS + Math.floor(this.trueUs / 1000),
      wallTrusted: true,
    };
  }
}

/** The devices of the test home: one gateway, two sensors, one siren on Wi-Fi. */
export interface Members {
  readonly gateway: Gateway;
  readonly sensors: readonly Sensor[];
  readonly siren: Siren;
}

function deviceRow(id: DeviceId, address: number, role: number, name: string): DeviceRow {
  return {
    id,
    address,
    role,
    name,
    chipId: new Uint8Array([role, 0, 0, 0, 0, id]),
    firmware: 0x010000,
    development: false,
    state: DeviceState.Contacted,
    addedMs: WALL_AT_START_MS - 86_400_000,
    removedMs: null,
  };
}

/** A send that left the hub, on which link, in which run. */
export interface LeftHub {
  readonly link: LinkId;
  readonly bytes: Uint8Array;
  readonly run: number;
}

export class RekeyHub {
  readonly rules: HubRules;
  readonly clock = new TestClock();
  readonly members: Members;
  /** Every record the loop staged, over every run. */
  readonly records: AuditRecord[] = [];
  readonly told: { readonly request: RequestId; readonly reply: ControlReply }[] = [];
  readonly left: LeftHub[] = [];
  /** Every fault and fatal error the loop reported, as text. */
  readonly reports: string[] = [];
  /** Every item staged with the writer, with its durability, over every run. */
  readonly stagedLog: StagedEffect[] = [];
  /** The transfer grants and revocations the shell was given, in order. */
  readonly grants: { readonly link: LinkId; readonly granted: boolean }[] = [];
  run = 0;
  readonly #random: SeededBytes;
  readonly #dirs: { path: string }[] = [];
  #dir: string;
  #store: OpenedStore | undefined;
  #loop: HubLoop | undefined;
  readonly #core: Core;
  #nextLink = 1;
  #nextRequest = 1;
  #gatewayLink: LinkId | undefined;
  #sirenLink: LinkId | undefined;
  #cut:
    | { readonly point: CutPoint; readonly when: (items: readonly StagedEffect[]) => boolean }
    | undefined;
  #cutCopy: string | undefined;
  #dead = false;
  #staged: StagedEffect[] = [];

  private constructor(rules: HubRules, core: Core) {
    this.rules = rules;
    this.#core = core;
    this.#random = new SeededBytes(11);
    const temp = tempDir("rekey");
    this.#dirs.push(temp);
    this.#dir = temp.path;
    this.members = {
      gateway: new Gateway(deviceId(2), 0x6a000001, "gw", testKey(2)),
      sensors: [
        new Sensor(deviceId(3), 0x5e000001, "front", testKey(3)),
        new Sensor(deviceId(4), 0x5e000002, "back", testKey(4)),
      ],
      siren: new Siren(deviceId(5), 0x51000001, "hall", testKey(5)),
    };
  }

  /** A home paired the day before, its hub started; `seed` adds rows before the first start. */
  static async create(
    options: {
      readonly rules?: HubRules;
      readonly core?: Core;
      readonly seed?: (members: Members) => readonly StoreOp[];
    } = {},
  ): Promise<RekeyHub> {
    const hub = new RekeyHub(options.rules ?? DEFAULT_RULES, options.core ?? makeCore(MODULES));
    const store = hub.#open()._unsafeUnwrap();
    const ops = [...hub.#seedOps(), ...(options.seed?.(hub.members) ?? [])];
    store.writer.stage(ops.map((op): StagedEffect => ({ kind: "write", durability: "now", op })));
    store.writer.flush("now")._unsafeUnwrap();
    (await ensureHubKeys(store.snapshot.hubKeys, store.writer))._unsafeUnwrap();
    // An app key, as the first start of M2 makes one: a backup is sealed for the hub's identity.
    const keys = readHubKeysRow(store.db)._unsafeUnwrap();
    if (keys !== undefined) {
      store.writer.stage([
        {
          kind: "write",
          durability: "now",
          op: {
            table: "hub_keys",
            op: "upsert",
            row: {
              ...keys,
              appStaticPrivate: new Uint8Array(32).fill(0x21),
              appStaticPublic: new Uint8Array(32).fill(0x22),
            },
          },
        },
      ]);
      store.writer.flush("now")._unsafeUnwrap();
    }
    store.writer.stop()._unsafeUnwrap();
    store.db.close(true);
    hub.start();
    return hub;
  }

  get store(): OpenedStore {
    return this.#store ?? expect.unreachable("the hub is not running");
  }

  get loop(): HubLoop {
    return this.#loop ?? expect.unreachable("the hub is not running");
  }

  get gatewayLink(): LinkId | undefined {
    return this.#gatewayLink;
  }

  get sirenLink(): LinkId | undefined {
    return this.#sirenLink;
  }

  /** Opens a network link whose far end is `device`, as a sensor joining Wi-Fi for its update. */
  openDeviceLink(device: Sensor): LinkId {
    const link = this.#openLink();
    this.#linkDevices.set(link, device);
    this.drain();
    return link;
  }

  /** A frame from a device on its own network link. */
  linkFrame(link: LinkId, bytes: Uint8Array): void {
    this.#frame(link, bytes);
    this.drain();
  }

  readonly #linkDevices = new Map<LinkId, Sensor>();

  get dataDir(): string {
    return this.#dir;
  }

  #seedOps(): readonly StoreOp[] {
    const { gateway, sensors, siren } = this.members;
    const devices = [
      { d: gateway, role: 3 },
      ...sensors.map((d) => ({ d, role: 1 })),
      { d: siren, role: 2 },
    ];
    const ops: StoreOp[] = [{ table: "site", op: "upsert", row: siteRowAt(RATE, {}, this.rules) }];
    for (const { d, role } of devices) {
      ops.push(
        { table: "devices", op: "upsert", row: deviceRow(d.id, d.address, role, d.name) },
        {
          table: "device_keys",
          op: "upsert",
          row: { deviceId: d.id, key: d.key, nextKey: null, rekey: 0 },
        },
        {
          table: "send_counters",
          op: "upsert",
          row: { deviceId: d.id, resumePoint: ResumeStep.Hub },
        },
      );
    }
    for (const s of sensors) {
      ops.push({ table: "sensor_config", op: "upsert", row: sensorRow(s.id, RATE) });
    }
    const sirenConfig: SirenConfigRow = {
      deviceId: siren.id,
      version: 1,
      wifiIntervalS: 30,
      loraCheckUnits: 20,
      maxSoundS: 300,
      sendRate: RATE,
      commandRate: RATE,
      siteChannel: CHANNEL,
      versionHistory: new Uint8Array(),
    };
    const gatewayConfig: GatewayConfigRow = {
      deviceId: gateway.id,
      version: 1,
      statusIntervalS: 30,
      interferenceDb: 10,
      interferenceS: 30,
      defaultPowerDbm: 22,
      sirenPowerDbm: 22,
    };
    ops.push(
      { table: "siren_config", op: "upsert", row: sirenConfig },
      { table: "gateway_config", op: "upsert", row: gatewayConfig },
    );
    return ops;
  }

  #open(): ReturnType<typeof openStore> {
    return openStore({
      dataDir: this.#dir,
      migrationsFolder: MIGRATIONS,
      clock: this.clock,
      rules: this.rules,
      platform: process.platform,
      onCommitted: (ops) => this.#keys?.applyCommitted(ops),
    });
  }

  #keys: MemoryKeyStore | undefined;

  /**
   * Starts the hub from its disk (hub-design.md section 7, "Hub restart"); the links open, and the
   * gateway says hello unless `gateway` is false (it is off: out of the hub's reach).
   */
  start(gateway = true): void {
    this.clock.bootAtUs = this.clock.trueUs;
    this.#dead = false;
    this.#cut = undefined;
    const store = this.#open()._unsafeUnwrap();
    this.#store = store;
    this.#keys = MemoryKeyStore.load(store.db)._unsafeUnwrap();
    this.#loop = new HubLoop(
      this.#core,
      {
        cipher: new KeyStoreCipher(this.#keys),
        rules: this.rules,
        calendar: UNBUILT_CALENDAR,
        sha256: nodeSha256,
      },
      {
        clock: this.clock,
        random: { bytes: (length) => ok(this.#random.bytes(length)) },
        links: {
          listen: () => undefined,
          send: (link, bytes) => {
            this.#send(link, bytes);
            return ok(undefined);
          },
          close: (link) => {
            this.#loop?.enqueue({ kind: "linkClosed", link, reason: "closedByHub" });
            return ok(undefined);
          },
        },
        control: {
          respond: (request, reply) => {
            if (!this.#dead) this.told.push({ request, reply });
          },
          publish: (record) => {
            if (!this.#dead) this.records.push(record);
          },
        },
        writer: this.#writer(store.writer),
        advertiser: { advertise: () => ok(undefined), stop: () => ok(undefined) },
        wakeAt: () => undefined,
        soon: () => undefined,
        transfers: {
          grant: (link) => this.grants.push({ link, granted: true }),
          revoke: (link) => this.grants.push({ link, granted: false }),
        },
        report: (error) => this.reports.push(`${error.origin}: ${error.message}`),
        fatal: (error) => this.reports.push(`fatal ${error.origin}: ${error.message}`),
      },
    );
    this.#loop.enqueue({ kind: "boot", snapshot: store.snapshot, boot: store.boot });
    this.drain();
    this.#sirenLink = this.#openLink();
    this.#gatewayLink = undefined;
    if (gateway) {
      this.#gatewayLink = this.#openLink();
      this.#frame(this.#gatewayLink, this.members.gateway.hello());
    }
    this.drain();
  }

  #openLink(): LinkId {
    const link = linkId(this.#nextLink++);
    this.#loop?.enqueue({ kind: "linkOpened", link, linkKind: "network", label: `ws:${link}` });
    return link;
  }

  #frame(link: LinkId, bytes: Uint8Array): void {
    this.#loop?.enqueue({ kind: "frame", link, bytes });
  }

  /** The writer as the loop sees it, with the power cut a test armed. */
  #writer(writer: OpenedStore["writer"]): LoopWriter {
    const flushed = <T>(flush: () => T): T => {
      const cut = this.#cut;
      const items = this.#staged;
      const armed = cut !== undefined && this.#cutCopy === undefined && cut.when(items);
      if (armed && cut.point === "beforeCommit") this.#copyNow();
      const done = flush();
      this.#staged = [];
      if (armed && cut.point === "afterCommit") this.#copyNow();
      if (armed && cut.point === "afterSends") this.#cutAfterTurn = true;
      return done;
    };
    return {
      stage: (items) => {
        writer.stage(items);
        this.#staged.push(...items);
        this.stagedLog.push(...items);
      },
      setCadence: (everyMs) => {
        writer.setCadence(everyMs);
      },
      durable: (device) => writer.durable(device),
      due: (now) => writer.due(now),
      flushIfDue: (now) => flushed(() => writer.flushIfDue(now)),
      flush: (reason) => flushed(() => writer.flush(reason)),
      takeOutcome: () => writer.takeOutcome(),
      maintain: () => writer.maintain(),
    };
  }

  #cutAfterTurn = false;

  /** The disk as it is now becomes the next run's; nothing more of this run leaves the hub. */
  #copyNow(): void {
    const copy = tempDir("rekey-cut");
    this.#dirs.push(copy);
    for (const name of [DATABASE_FILE, `${DATABASE_FILE}-wal`]) {
      const from = join(this.#dir, name);
      if (existsSync(from)) copyFileSync(from, join(copy.path, name));
    }
    this.#cutCopy = copy.path;
    this.#dead = true;
  }

  /**
   * Arms a power cut at `point` of the next turn whose commit holds an item `when` likes; the hub
   * then starts again from the disk as the cut left it, off for `offUs`.
   */
  cutAt(point: CutPoint, when: (items: readonly StagedEffect[]) => boolean): void {
    this.#cut = { point, when };
    this.#cutCopy = undefined;
  }

  /** Whether an armed cut fell. */
  get cut(): boolean {
    return this.#cutCopy !== undefined;
  }

  drain(): void {
    const loop = this.#loop;
    if (loop === undefined) return;
    for (let turns = 0; loop.waiting > 0; turns++) {
      if (turns > 10_000) expect.unreachable("inputs keep making inputs");
      loop.turn();
      if (this.#cutAfterTurn) {
        this.#cutAfterTurn = false;
        this.#copyNow();
      }
      if (this.#cutCopy !== undefined && this.#dead && this.#loop === loop) {
        this.#restartFromCut();
        return;
      }
    }
  }

  #restartFromCut(): void {
    const copy = this.#cutCopy;
    if (copy === undefined) return;
    this.#store?.db.close(true);
    this.#store = undefined;
    this.#loop = undefined;
    this.#dir = copy;
    this.#cutCopy = undefined;
    this.clock.trueUs += 5 * SECOND;
    this.run += 1;
    this.start();
  }

  /** A frame the hub sent: to the device on that link; what it answers goes back. */
  #send(link: LinkId, bytes: Uint8Array): void {
    if (this.#dead) return;
    this.left.push({ link, bytes, run: this.run });
    const { gateway, siren } = this.members;
    if (link === this.#gatewayLink) {
      const before = gateway.transmitted.length;
      for (const answer of gateway.receive(bytes)) this.#frame(link, answer);
      for (const packet of gateway.transmitted.slice(before)) this.#air(packet);
    } else if (link === this.#sirenLink) {
      siren.receive(bytes);
    } else {
      this.#linkDevices.get(link)?.receive(bytes);
    }
  }

  /** A packet the gateway transmitted reaches the device it is addressed to. */
  #air(packet: Uint8Array): void {
    const address = new DataView(packet.buffer, packet.byteOffset + 1, 4).getUint32(0, true);
    const { sensors, siren } = this.members;
    for (const s of sensors) if (s.address === address) s.receive(packet);
    if (siren.address === address) siren.receive(packet);
  }

  /** A device packet on the air, heard by the gateway, which forwards it. */
  radio(packet: Uint8Array): void {
    const link = this.#gatewayLink;
    const frame = this.members.gateway.forward(packet, this.clock.trueUs);
    if (link === undefined || frame === undefined) expect.unreachable("the gateway has no session");
    this.#frame(link, frame);
    this.drain();
  }

  /** Device packets heard together, forwarded together: the hub takes them in one turn. */
  radioTogether(packets: readonly Uint8Array[]): void {
    const link = this.#gatewayLink ?? expect.unreachable("the gateway is not connected");
    for (const packet of packets) {
      const frame = this.members.gateway.forward(packet, this.clock.trueUs);
      if (frame === undefined) expect.unreachable("the gateway has no session");
      this.#frame(link, frame);
    }
    this.drain();
  }

  /** A frame from the siren on its Wi-Fi link. */
  sirenWifi(packet: Uint8Array): void {
    const link = this.#sirenLink;
    if (link === undefined) return;
    this.#frame(link, packet);
    this.drain();
  }

  /** A frame from the gateway on its link, as it is (a replayed hello, say). */
  gatewayFrame(bytes: Uint8Array): void {
    const link = this.#gatewayLink;
    if (link === undefined) return;
    this.#frame(link, bytes);
    this.drain();
  }

  /**
   * The gateway connects again with a new hello, as after a lost connection; or, given `bytes`,
   * someone connects as it and sends those (a recorded hello).
   */
  reconnectGateway(bytes?: Uint8Array): void {
    this.#gatewayLink = this.#openLink();
    this.#frame(this.#gatewayLink, bytes ?? this.members.gateway.hello());
    this.drain();
  }

  /** Advances true time by `us`, running every hub wake on the way. */
  advance(us: number): void {
    const to = this.clock.trueUs + us;
    for (let wakes = 0; wakes < 100_000; wakes++) {
      const wake = this.#loop?.nextWake();
      const at = wake === undefined ? undefined : wake + this.clock.bootAtUs;
      if (at === undefined || at > to) break;
      this.clock.trueUs = Math.max(this.clock.trueUs, at);
      this.#loop?.turn();
      this.drain();
    }
    this.clock.trueUs = to;
  }

  command(command: ControlCommand): ControlReply | undefined {
    const request = requestId(this.#nextRequest++);
    this.#loop?.enqueue({ kind: "command", conn: connId(0), request, actor: "test", command });
    this.drain();
    return this.told.find((t) => t.request === request)?.reply;
  }

  input(event: HubEvent): void {
    this.#loop?.enqueue(event);
    this.drain();
  }

  decisions(kind: DecisionKind, device?: DeviceId): readonly AuditRecord[] {
    return this.records.filter(
      (r) =>
        r.kind === "decision" &&
        r.row.kind === kind &&
        (device === undefined || r.row.deviceId === device),
    );
  }

  /** Commits everything staged, as `hsn log` does. */
  flush(): void {
    this.store.writer.flush("log")._unsafeUnwrap();
  }

  /** A backup written now, through the real backup job (M2 9): its file's path. */
  backup(): string {
    this.flush();
    const folder = join(this.#dirs[0]?.path ?? this.#dir, "backups");
    mkdirSync(folder, { recursive: true });
    const done = runToEnd(
      jobId(1),
      { kind: "backup", folder, keep: 20, key: BACKUP_KEY, epoch: 1 },
      {
        db: this.store.db,
        dataDir: this.#dir,
        migrationsFolder: MIGRATIONS,
        rules: this.rules,
        uploads: { pathOf: () => undefined },
        exports: { send: () => ok(undefined) },
        prefix: undefined,
        switchBlockedBy: () => undefined,
        nowMs: () => this.clock.now().wall,
        salt: () => ok(new Uint8Array(8).fill(9)),
      },
    );
    if (done.kind !== "ready" || done.outcome.kind !== "backupWritten") {
      expect.unreachable(`no backup: ${JSON.stringify(done)}`);
    }
    return join(folder, done.outcome.name);
  }

  /**
   * A restore of `file` through the real restore (`applyRestore`, M2 9), then the restored hub's
   * first start, as `switchRestore` and the service's restart do: the hub stops cleanly, the file
   * replaces its database, and it starts again from it.
   */
  restore(file: string, gateway = true): void {
    this.store.writer.stop()._unsafeUnwrap();
    this.store.db.close(true);
    this.#store = undefined;
    this.#loop = undefined;
    const pieces = new RestorePieces({
      dataDir: this.#dir,
      uploadPath: file,
      key: BACKUP_KEY,
      migrationsFolder: MIGRATIONS,
      rules: this.rules,
    });
    let outcome;
    while ((outcome = pieces.next()) === undefined);
    if (outcome.kind !== "restoreReady") expect.unreachable(`restore: ${JSON.stringify(outcome)}`);
    swapRestored(this.#dir)._unsafeUnwrap();
    this.clock.trueUs += 10 * SECOND;
    this.run += 1;
    this.start(gateway);
  }

  /** The hub stops cleanly and starts again from its disk. */
  restart(): void {
    this.store.writer.stop()._unsafeUnwrap();
    this.store.db.close(true);
    this.#store = undefined;
    this.#loop = undefined;
    this.clock.trueUs += 5 * SECOND;
    this.run += 1;
    this.start();
  }

  /** `device_keys` as committed: each device's key, next key and mark. */
  keyRows(): readonly {
    readonly id: number;
    readonly key: string;
    readonly next: string | null;
    readonly rekey: number;
  }[] {
    return this.store.db
      .query<{ id: number; key: string; next: string | null; rekey: number }, []>(
        `SELECT device_id AS id, lower(hex(key)) AS key, CASE WHEN next_key IS NULL THEN NULL ELSE lower(hex(next_key)) END AS next, rekey FROM device_keys ORDER BY device_id`,
      )
      .all();
  }

  /** The hub's sending resume point for a device, as committed. */
  resumePoint(device: DeviceId): number | undefined {
    return this.store.db
      .query<{ r: number }, [number]>(
        `SELECT resume_point AS r FROM send_counters WHERE device_id = ?`,
      )
      .get(device)?.r;
  }

  get now(): Mono {
    return this.clock.now().mono;
  }
}

/** A sensor's door report (§6): open, `ageS` old, reply wanted. */
export function doorOpen(ageS = 0, version = 1): Message {
  return {
    type: MessageType.DoorChanged,
    settingsVersion: version,
    flags: {
      doorOpen: true,
      coverOpen: false,
      usbPower: false,
      charging: false,
      replyWanted: true,
      localAlarmSounded: false,
      buzzing: false,
      listeningAtSendRate: false,
    },
    batteryCode: 120,
    temperatureCelsius: 21,
    doorChangeCount: 1,
    eventAgeSeconds: ageS,
  };
}

export { heartbeat };
