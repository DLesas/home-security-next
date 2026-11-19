/**
 * A home for the real hub: a data folder seeded with a gateway and a door sensor already paired
 * (as `hub/test/budget/loop-limit.test.ts` seeds one, with a short entry countdown), and the
 * gateway on the hub's `/device` WebSocket as a scripted gateway (`hub/test/world`), forwarding the
 * door's reports as a gateway hears them and answering the hub's transmit requests through its
 * modelled radio. The door's packets are sealed with the sensor's key, so the hub takes them as a
 * real sensor's.
 */
import { join } from "node:path";
import {
  Direction,
  type Message,
  MaxPacketLength,
  MessageType,
  NO_BINDING,
  ResumeStep,
  sealPacket,
} from "@hsn/protocol";
import { deviceId } from "../../src/core/model/ids.ts";
import { mono, type Mono } from "../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { DeviceState } from "../../src/core/model/rows.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import { SystemClock } from "../../src/shell/clock/system-clock.ts";
import { DEVICE_PATH } from "../../src/shell/links/websocket.ts";
import { openStore } from "../../src/shell/storage/store.ts";
import { sensorRow, siteRowAt } from "../scenarios/sensors/bench.ts";
import { SeededBytes } from "../world/entropy.ts";
import { ScriptedGateway } from "../world/scripted-gateway.ts";
import { HUB_DIR, waitFor } from "./processes.ts";

const MIGRATIONS = join(HUB_DIR, "drizzle");
export const GATEWAY = deviceId(1);
export const SENSOR = deviceId(2);
export const SENSOR_NAME = "front";
const GATEWAY_ADDRESS = 0x6a000001;
const SENSOR_ADDRESS = 0x5e000001;
const GATEWAY_KEY = new Uint8Array(16).map((_, i) => 0x40 + i);
const SENSOR_KEY = new Uint8Array(16).map((_, i) => 0x90 + i);
/** The door's entry countdown, short so a run takes seconds. */
export const COUNTDOWN_S = 8;
const PUMP_MS = 5;
/** The gateway's status, as often as its settings ask (`statusIntervalS`), so it is never offline. */
const STATUS_EVERY_MS = 25_000;

/** The device keys of this home, for the leak search: test keys, but keys. */
export const HOME_KEYS: readonly Uint8Array[] = [GATEWAY_KEY, SENSOR_KEY];

/** Writes a gateway and a door sensor, paired, and the site, before the hub's first start. */
export function seedHome(dataDir: string): void {
  const store = openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  const device = (id: typeof GATEWAY, address: number, role: number, name: string): StoreOp => ({
    table: "devices",
    op: "upsert",
    row: {
      id,
      address,
      role,
      name,
      chipId: new Uint8Array([role, 0, 0, 0, 0, id]),
      firmware: 0x010000,
      development: false,
      state: DeviceState.Contacted,
      addedMs: Date.now() - 86_400_000,
      removedMs: null,
    },
  });
  const ops: StoreOp[] = [
    { table: "site", op: "upsert", row: siteRowAt(5) },
    device(GATEWAY, GATEWAY_ADDRESS, 3, "gateway"),
    device(SENSOR, SENSOR_ADDRESS, 1, SENSOR_NAME),
    {
      table: "device_keys",
      op: "upsert",
      row: { deviceId: GATEWAY, key: GATEWAY_KEY, nextKey: null, rekey: 0 },
    },
    {
      table: "device_keys",
      op: "upsert",
      row: { deviceId: SENSOR, key: SENSOR_KEY, nextKey: null, rekey: 0 },
    },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: GATEWAY, resumePoint: ResumeStep.SirenOrGateway },
    },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: SENSOR, resumePoint: ResumeStep.Hub },
    },
    {
      table: "sensor_config",
      op: "upsert",
      row: sensorRow(SENSOR, 5, { countdownS: COUNTDOWN_S }),
    },
    {
      table: "gateway_config",
      op: "upsert",
      row: {
        deviceId: GATEWAY,
        version: 1,
        statusIntervalS: 30,
        interferenceDb: 10,
        interferenceS: 30,
        defaultPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
  ];
  store.writer.stage(ops.map((op) => ({ kind: "write", durability: "now", op })));
  store.writer.flush("now")._unsafeUnwrap();
  store.writer.stop()._unsafeUnwrap();
  store.db.close(true);
}

/**
 * The home's gateway on the hub's `/device` WebSocket, and its door. Connected again after each
 * start of the hub (`connect`); the sensor's packet counter carries on across them, as a real
 * sensor's does.
 */
export class HomeGateway {
  #socket: WebSocket | undefined;
  #pump: ReturnType<typeof setInterval> | undefined;
  #status: ReturnType<typeof setInterval> | undefined;
  readonly #gateway: ScriptedGateway;
  readonly #started = performance.now();
  #counter = 1;
  #changes = 0;
  welcomed = false;

  constructor() {
    const random = new SeededBytes(5);
    this.#gateway = new ScriptedGateway({
      key: GATEWAY_KEY,
      address: GATEWAY_ADDRESS,
      nextRandom: () => random.bytes(8),
    });
  }

  #now(): Mono {
    return mono(Math.round((performance.now() - this.#started) * 1000));
  }

  /** Connects to the hub on `port` and waits for its welcome. */
  async connect(port: number): Promise<boolean> {
    this.close();
    this.welcomed = false;
    const opened = await waitFor(
      () => {
        if (this.#socket === undefined || this.#socket.readyState === WebSocket.CLOSED) {
          const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${DEVICE_PATH}`);
          socket.binaryType = "arraybuffer";
          socket.onmessage = (event) => {
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            for (const answer of this.#gateway.receive(bytes, this.#now())) socket.send(answer);
            if (this.#gateway.session !== undefined) this.welcomed = true;
          };
          socket.onopen = () => {
            const hello = this.#gateway.hello();
            if (hello !== undefined) socket.send(hello);
          };
          this.#socket = socket;
        }
        return this.welcomed;
      },
      20_000,
      50,
    );
    this.#status = setInterval(() => {
      this.#sendStatus();
    }, STATUS_EVERY_MS);
    // The gateway's transmit results, each when its airtime ends.
    this.#pump = setInterval(() => {
      const due = this.#gateway.nextWake();
      if (due === undefined || due > this.#now()) return;
      for (const frame of this.#gateway.wake(this.#now())) this.#socket?.send(frame);
    }, PUMP_MS);
    return opened;
  }

  #sendStatus(): void {
    const frame = this.#gateway.status({
      settingsVersion: this.#gateway.settings?.settingsVersion ?? 0,
      uptimeSeconds: Math.floor((performance.now() - this.#started) / 1000),
      airtimeHundredthsPercent: 12,
      noiseMedianDbm: -118,
      noiseHighestDbm: -110,
      normalNoiseDbm: -118,
      packetsReceived: 0,
      packetsCrcFailed: 0,
      wifiRssiDbm: -60,
      flags: { usbConnected: false, cellFitted: false, onMains: true },
    });
    if (frame !== undefined && this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(frame);
  }

  /** The door opens or shuts: one report, forwarded by the gateway as heard now. */
  door(open: boolean): boolean {
    this.#changes += 1;
    const message: Message = {
      type: MessageType.DoorChanged,
      settingsVersion: 0,
      flags: {
        doorOpen: open,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: true,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: true,
      },
      batteryCode: 200,
      temperatureCelsius: 20,
      doorChangeCount: this.#changes % 256,
      eventAgeSeconds: 0,
    };
    const packet = sealPacket(message, {
      key: SENSOR_KEY,
      direction: Direction.ToHub,
      address: SENSOR_ADDRESS,
      counter: this.#counter++,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    });
    const frame = this.#gateway.forward(packet, {
      endedAt: this.#now(),
      rssiDbm: -92,
      snrQuarterDb: 24,
      dataRate: 5,
      siteChannel: 1,
    });
    if (frame === undefined || this.#socket?.readyState !== WebSocket.OPEN) return false;
    this.#socket.send(frame);
    return true;
  }

  close(): void {
    clearInterval(this.#pump);
    clearInterval(this.#status);
    this.#pump = undefined;
    this.#status = undefined;
    this.#socket?.close();
    this.#socket = undefined;
  }
}
