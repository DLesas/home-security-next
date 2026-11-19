/**
 * A scripted phone's Bluetooth: `BleCentral` (app/src/platform/ble.ts, frozen) over the scripted
 * air, so the app's pairing and update code runs against scripted boards under `bun test` with
 * no radio. Each `ScriptedCentral` is one phone; two of them on one air are two phones.
 *
 * Its answers are the faults `BleFault` names: a write or read on a closed link, or one cut by a
 * drop, is `lost`; a board that does not take a connection is `timeout`; an ATT error the board
 * answers, or a write longer than the link allows, is `failed`; Bluetooth off or not allowed is
 * `off` or `unauthorized` everywhere.
 */
import type {
  Advert,
  BleCentral,
  BleFault,
  BleState,
  GattLink,
} from "../../../../app/src/platform/ble.ts";
import { fault, ok, type Outcome } from "../outcome.ts";
import type { AirConnection, BleAir } from "./air.ts";
import { allows, ATT_HEADER_BYTES, MAX_ATTRIBUTE_BYTES, MIN_MTU } from "./gatt.ts";

export interface CentralOptions {
  /**
   * The largest MTU this phone's stack takes. Android asks for what the app asks (517 at most);
   * iOS settles on its own, 185 on many iPhones, whatever the app asks.
   */
  readonly maxMtu?: number;
  /** Bluetooth's state on this phone. */
  readonly state?: BleState;
  /** False: each board is reported once per scan, as iOS does; true (the default), as Android. */
  readonly duplicates?: boolean;
}

/** What a closed or failed operation answers, by what stopped it. */
function stateFault(state: BleState): BleFault | undefined {
  if (state === "on") return undefined;
  if (state === "unsupported") return "failed";
  return state;
}

class ScriptedLink implements GattLink {
  readonly mtu: number;
  readonly #closed: ((fault: BleFault | null) => void)[] = [];
  #ended: { readonly fault: BleFault | null } | undefined;

  constructor(
    readonly air: BleAir,
    readonly connection: AirConnection,
  ) {
    this.mtu = connection.mtu;
    connection.onClosed((why) => {
      this.#ended = { fault: why };
      for (const listener of this.#closed.splice(0)) listener(why);
    });
  }

  #services() {
    return this.connection.handlers?.services ?? [];
  }

  async write(
    characteristic: string,
    data: Uint8Array,
    response: boolean,
  ): Promise<Outcome<void, BleFault>> {
    if (this.#ended !== undefined || !this.connection.open) return fault("lost");
    const services = this.#services();
    const operation = response ? "write" : "writeWithoutResponse";
    if (!allows(services, characteristic, operation)) return fault("failed");
    const limit = response ? MAX_ATTRIBUTE_BYTES : this.mtu - ATT_HEADER_BYTES;
    if (data.length > limit) return fault("failed");
    const answer = await this.air.write(this.connection, characteristic, data, response);
    if (answer.ok) return ok(undefined);
    return fault(answer.error === "lost" ? "lost" : "failed");
  }

  async read(characteristic: string): Promise<Outcome<Uint8Array, BleFault>> {
    if (this.#ended !== undefined || !this.connection.open) return fault("lost");
    if (!allows(this.#services(), characteristic, "read")) return fault("failed");
    const answer = await this.air.read(this.connection, characteristic);
    if (answer.ok) return ok(answer.value);
    return fault(answer.error === "lost" ? "lost" : "failed");
  }

  watch(characteristic: string, data: (bytes: Uint8Array) => void): () => void {
    const uuid = characteristic.toLowerCase();
    if (this.#ended !== undefined || !allows(this.#services(), uuid, "notify"))
      return () => undefined;
    let watchers = this.connection.watchers.get(uuid);
    if (watchers === undefined) {
      watchers = new Set();
      this.connection.watchers.set(uuid, watchers);
    }
    const first = watchers.size === 0;
    // A function of its own each time, so the same callback watched twice is two watchers.
    const watcher = (bytes: Uint8Array) => {
      data(bytes);
    };
    watchers.add(watcher);
    if (first) this.air.subscribe(this.connection, uuid, true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      watchers.delete(watcher);
      if (watchers.size === 0 && this.connection.open) {
        this.air.subscribe(this.connection, uuid, false);
      }
    };
  }

  onClosed(closed: (fault: BleFault | null) => void): void {
    const ended = this.#ended;
    if (ended === undefined) this.#closed.push(closed);
    else
      queueMicrotask(() => {
        closed(ended.fault);
      });
  }

  close(): void {
    this.air.closeFromCentral(this.connection);
  }
}

export class ScriptedCentral implements BleCentral {
  readonly maxMtu: number;
  /** Bluetooth's state on this phone; a test may change it. */
  bluetooth: BleState;
  readonly duplicates: boolean;
  /** Every link this phone opened, in order. */
  readonly links: GattLink[] = [];

  constructor(
    readonly air: BleAir,
    options: CentralOptions = {},
  ) {
    this.maxMtu = options.maxMtu ?? 517;
    this.bluetooth = options.state ?? "on";
    this.duplicates = options.duplicates ?? true;
  }

  state(): Promise<BleState> {
    return Promise.resolve(this.bluetooth);
  }

  scan(service: string, found: (advert: Advert) => void): () => void {
    const uuid = service.toLowerCase();
    const reported = new Set<string>();
    let stopped = false;
    // Read through a function: `found` may stop the scan.
    const isStopped = () => stopped;
    let cancel: () => void = () => undefined;
    const sweep = () => {
      if (stopped) return;
      if (this.bluetooth === "on") {
        for (const peripheral of this.air.peripherals()) {
          const advert = peripheral.advertising();
          if (advert?.serviceUuids.some((u) => u.toLowerCase() === uuid) !== true) continue;
          if (!this.duplicates && reported.has(peripheral.id)) continue;
          reported.add(peripheral.id);
          const data = advert.serviceData.find(([u]) => u.toLowerCase() === uuid)?.[1];
          found({
            id: peripheral.id,
            name: advert.localName,
            serviceData: data === undefined ? null : data.slice(),
            rssi: peripheral.rssi,
          });
          if (isStopped()) return;
        }
      }
      cancel = this.air.clock.after(this.air.advertIntervalMs, sweep);
    };
    cancel = this.air.clock.after(0, sweep);
    return () => {
      stopped = true;
      cancel();
    };
  }

  async connect(id: string, wantMtu: number): Promise<Outcome<GattLink, BleFault>> {
    const off = stateFault(this.bluetooth);
    if (off !== undefined) return fault(off);
    const mtu = Math.max(MIN_MTU, Math.min(wantMtu, this.maxMtu));
    const connected = await this.air.connect(id, mtu);
    if (!connected.ok) return connected;
    const link = new ScriptedLink(this.air, connected.value);
    this.links.push(link);
    return ok(link);
  }
}
