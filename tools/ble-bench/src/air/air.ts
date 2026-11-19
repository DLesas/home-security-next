/**
 * The scripted air: the scripted boards (`Peripheral`s) in one place, and the connections between
 * them and the phones (`ScriptedCentral`, `central.ts`). Nothing here is a radio: a write, a read
 * or a notification is a timer on the air's clock, `latencyMs` away, delivered in the order it
 * was sent, unless a fault (`faults.ts`) loses, repeats, corrupts it or drops the connection.
 *
 * What it models, as NimBLE and the phones' stacks behave:
 *
 * - **Advertising and scanning.** A central scanning for a service hears every board whose
 *   advertisement names it, every `advertIntervalMs` (Android reports each advertisement; a
 *   central made with `duplicates: false` reports each board once per scan, as iOS does).
 * - **One connection per board.** A board advertises only while nobody is connected (NimBLE stops
 *   connectable advertising on a connection, and protocomm starts it again on the disconnect), so
 *   a second phone's connect waits and times out.
 * - **MTU, writes and notifications** with Bluetooth's limits (`gatt.ts`).
 * - **The ends of a connection.** A phone that closes sees `null`; a board that closes, a drop
 *   and a board that vanishes are `lost` for the phone, after whatever was already on its way.
 */
import { type Clock, realClock } from "../clock.ts";
import type { Crossing, Faults } from "./faults.ts";
import {
  ATT_HEADER_BYTES,
  type AttError,
  type ConnectionHandlers,
  MIN_MTU,
  type Peripheral,
  type PeripheralConnection,
} from "./gatt.ts";

export interface AirOptions {
  /** How often a board's advertisement is heard (the real board's interval is 160 ms). */
  readonly advertIntervalMs?: number;
  /** How long a connect waits for a board that does not take it. */
  readonly connectTimeoutMs?: number;
}

/** One connection between a central and a board, as both ends see it. */
export class AirConnection implements PeripheralConnection {
  readonly mtu: number;
  readonly number: number;
  /** New writes, reads and notifications are taken. */
  open = true;
  /** Nothing more reaches the phone: the link is gone at its end. */
  gone = false;
  handlers: ConnectionHandlers | undefined;
  /** Characteristics the board has been told the central subscribed to. */
  readonly subscribed = new Set<string>();
  /** The central's watchers, by characteristic. */
  readonly watchers = new Map<string, Set<(bytes: Uint8Array) => void>>();
  readonly #closedListeners: ((fault: "lost" | null) => void)[] = [];
  readonly #counts = new Map<string, number>();
  #closeReported = false;

  constructor(
    readonly air: BleAir,
    readonly peripheral: Peripheral,
    mtu: number,
    number: number,
  ) {
    this.mtu = mtu;
    this.number = number;
  }

  /** The next crossing's numbers. */
  crossing(
    direction: Crossing["direction"],
    kind: Crossing["kind"],
    characteristic: string,
    data: Uint8Array,
  ): Crossing {
    const key = `${direction}:${kind}`;
    const index = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, index);
    const crossing = { direction, kind, characteristic, data, index, connection: this.number };
    this.air.heard(this.peripheral.id, crossing);
    return crossing;
  }

  get faults(): Faults {
    return this.air.faultsFor(this.peripheral.id);
  }

  get latency(): number {
    return Math.max(0, this.faults.latencyMs ?? 0);
  }

  get boardDelay(): number {
    return Math.max(0, this.faults.boardDelayMs ?? 0);
  }

  onClosed(listener: (fault: "lost" | null) => void): void {
    this.#closedListeners.push(listener);
  }

  /** Tells the central once that the link closed. */
  reportClosed(fault: "lost" | null): void {
    if (this.#closeReported) return;
    this.#closeReported = true;
    for (const listener of this.#closedListeners) listener(fault);
  }

  // ----- The board's side -----

  notify(characteristic: string, data: Uint8Array): boolean {
    const uuid = characteristic.toLowerCase();
    if (!this.open || !this.subscribed.has(uuid)) return false;
    if (data.length > this.mtu - ATT_HEADER_BYTES) return false;
    const crossing = this.crossing("toPhone", "notify", uuid, data.slice());
    const faults = this.faults;
    if (faults.lose?.(crossing) === true) return true;
    const bytes = faults.corrupt?.(crossing) ?? crossing.data;
    const times = faults.repeat?.(crossing) === true ? 2 : 1;
    const drop = faults.dropAfter?.(crossing) === true;
    this.air.clock.after(this.latency, () => {
      if (this.gone) return;
      for (let i = 0; i < times; i++) {
        for (const watcher of this.watchers.get(uuid) ?? []) watcher(bytes.slice());
      }
      if (drop) this.air.drop(this);
    });
    return true;
  }

  disconnect(): void {
    if (!this.open) return;
    this.open = false;
    const handlers = this.handlers;
    // The board's own disconnect event comes from its stack, after the call returns.
    this.air.clock.after(0, () => handlers?.closed(false));
    // Whatever was already on its way to the phone arrives first.
    this.air.clock.after(this.latency, () => {
      this.gone = true;
      this.reportClosed("lost");
    });
  }
}

export class BleAir {
  readonly clock: Clock;
  readonly advertIntervalMs: number;
  readonly connectTimeoutMs: number;
  /** Faults for every board without its own. */
  faults: Faults = {};
  readonly #boardFaults = new Map<string, Faults>();
  readonly #peripherals = new Map<string, Peripheral>();
  readonly #connections = new Map<string, AirConnection>();
  readonly #attempts = new Map<string, number>();
  readonly #sniffers = new Set<(board: string, crossing: Crossing) => void>();

  constructor(clock: Clock = realClock, options: AirOptions = {}) {
    this.clock = clock;
    this.advertIntervalMs = options.advertIntervalMs ?? 100;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  }

  /**
   * Hears every crossing as it is sent, before any fault: what a board sent and what a phone
   * wrote, in order. Returns the stop.
   */
  sniff(listener: (board: string, crossing: Crossing) => void): () => void {
    this.#sniffers.add(listener);
    return () => {
      this.#sniffers.delete(listener);
    };
  }

  heard(board: string, crossing: Crossing): void {
    for (const sniffer of this.#sniffers) sniffer(board, crossing);
  }

  add(peripheral: Peripheral): void {
    this.#peripherals.set(peripheral.id, peripheral);
  }

  remove(id: string): void {
    this.#peripherals.delete(id);
  }

  peripheral(id: string): Peripheral | undefined {
    return this.#peripherals.get(id);
  }

  peripherals(): readonly Peripheral[] {
    return [...this.#peripherals.values()];
  }

  /** One board's faults, in place of the air's. */
  setFaults(id: string, faults: Faults): void {
    this.#boardFaults.set(id, faults);
  }

  faultsFor(id: string): Faults {
    return this.#boardFaults.get(id) ?? this.faults;
  }

  /** The open connection to a board, if any. */
  connectionTo(id: string): AirConnection | undefined {
    const connection = this.#connections.get(id);
    return connection?.open === true ? connection : undefined;
  }

  /**
   * A central's connect: the board takes it after a round trip, or the attempt waits
   * `connectTimeoutMs` and times out. Resolves with the connection, or why not.
   */
  connect(
    id: string,
    mtu: number,
  ): Promise<
    | { readonly ok: true; readonly value: AirConnection }
    | { readonly ok: false; readonly fault: "notFound" | "timeout" | "failed" }
  > {
    const peripheral = this.#peripherals.get(id);
    if (peripheral === undefined) return Promise.resolve({ ok: false, fault: "notFound" });
    const faults = this.faultsFor(id);
    const latency = Math.max(0, faults.latencyMs ?? 0);
    const attempt = (this.#attempts.get(id) ?? 0) + 1;
    this.#attempts.set(id, attempt);
    return new Promise((resolve) => {
      this.clock.after(2 * latency, () => {
        if (faults.refuseConnect?.(attempt) === true) {
          resolve({ ok: false, fault: "failed" });
          return;
        }
        const busy = this.connectionTo(id) !== undefined;
        const agreed = Math.max(MIN_MTU, Math.min(mtu, peripheral.maxMtu));
        const connection = new AirConnection(this, peripheral, agreed, attempt);
        const handlers = busy ? undefined : peripheral.accept(connection);
        if (handlers === undefined) {
          connection.open = false;
          connection.gone = true;
          this.clock.after(this.connectTimeoutMs, () => {
            resolve({ ok: false, fault: "timeout" });
          });
          return;
        }
        connection.handlers = handlers;
        this.#connections.set(id, connection);
        resolve({ ok: true, value: connection });
      });
    });
  }

  /** A drop: the radio link is gone for both ends at once; nothing on its way arrives. */
  drop(connection: AirConnection): void {
    if (connection.gone) return;
    connection.open = false;
    connection.gone = true;
    connection.handlers?.closed(false);
    connection.reportClosed("lost");
  }

  /** The central closed the link. */
  closeFromCentral(connection: AirConnection): void {
    if (connection.gone) return;
    const wasOpen = connection.open;
    connection.open = false;
    connection.gone = true;
    const handlers = connection.handlers;
    if (wasOpen) this.clock.after(connection.latency, () => handlers?.closed(true));
    this.clock.after(0, () => {
      connection.reportClosed(null);
    });
  }

  /** A central's write reaches the board; the board's answer comes back for a write with response. */
  write(
    connection: AirConnection,
    characteristic: string,
    data: Uint8Array,
    withResponse: boolean,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AttError | "lost" }> {
    const uuid = characteristic.toLowerCase();
    const crossing = connection.crossing("toBoard", "write", uuid, data.slice());
    const faults = connection.faults;
    const lost = !withResponse && faults.lose?.(crossing) === true;
    const bytes = faults.corrupt?.(crossing) ?? crossing.data;
    const times = !withResponse && faults.repeat?.(crossing) === true ? 2 : 1;
    const drop = faults.dropAfter?.(crossing) === true;
    return new Promise((resolve) => {
      if (!withResponse) resolve({ ok: true });
      if (lost) return;
      this.clock.after(connection.latency + connection.boardDelay, () => {
        if (!connection.open) {
          resolve({ ok: false, error: "lost" });
          return;
        }
        let answer: { readonly ok: true } | { readonly ok: false; readonly error: AttError } = {
          ok: true,
        };
        for (let i = 0; i < times; i++) {
          answer = connection.handlers?.write(uuid, bytes.slice(), withResponse) ?? {
            ok: false,
            error: "unlikely",
          };
        }
        if (drop) this.drop(connection);
        if (!withResponse) return;
        this.clock.after(connection.latency, () => {
          resolve(connection.gone ? { ok: false, error: "lost" } : answer);
        });
      });
    });
  }

  /** A central's read: the board's value comes back after a round trip. */
  read(
    connection: AirConnection,
    characteristic: string,
  ): Promise<
    | { readonly ok: true; readonly value: Uint8Array }
    | { readonly ok: false; readonly error: AttError | "lost" }
  > {
    const uuid = characteristic.toLowerCase();
    return new Promise((resolve) => {
      this.clock.after(connection.latency + connection.boardDelay, () => {
        if (!connection.open) {
          resolve({ ok: false, error: "lost" });
          return;
        }
        const answer = connection.handlers?.read(uuid) ?? { ok: false, error: "unlikely" };
        const crossing = connection.crossing(
          "toPhone",
          "read",
          uuid,
          answer.ok ? answer.value : new Uint8Array(),
        );
        const faults = connection.faults;
        const drop = faults.dropAfter?.(crossing) === true;
        const value = answer.ok ? (faults.corrupt?.(crossing) ?? crossing.data) : undefined;
        this.clock.after(connection.latency, () => {
          if (connection.gone) {
            resolve({ ok: false, error: "lost" });
            return;
          }
          resolve(value === undefined ? answer : { ok: true, value });
          if (drop) this.drop(connection);
        });
      });
    });
  }

  /** The central's subscription reaches the board. */
  subscribe(connection: AirConnection, characteristic: string, on: boolean): void {
    const uuid = characteristic.toLowerCase();
    this.clock.after(connection.latency + connection.boardDelay, () => {
      if (!connection.open) return;
      if (on) connection.subscribed.add(uuid);
      else connection.subscribed.delete(uuid);
      connection.handlers?.subscribed(uuid, on);
    });
  }
}
