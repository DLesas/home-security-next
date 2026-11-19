/**
 * `bridgeBleCentral`: a `BleCentral` (app/src/platform/ble.ts, frozen) that reaches the scripted
 * boards through the bridge (`server.ts`) over the simulator's network, for **development builds
 * only** (m3-design.md section 5, "A bridge for the simulators"). A development build given the
 * bridge's address in `EXPO_PUBLIC_HSN_BLE_BENCH` uses it in place of react-native-ble-plx; the
 * app's code above `BleCentral` is then exactly what a phone runs.
 *
 * **It cannot ship.** Three things keep it out of a release build:
 *
 * 1. **Where it is chosen.** The app chooses it only inside `if (__DEV__) { … require(…) … }`
 *    (the selector is P4's, in `app/src/pairing/`; the form to use is in tools/ble-bench/README.md).
 *    A release bundle folds `__DEV__` to `false` before Metro collects modules, so this file is
 *    never collected, as `dev/wave0.ts` is not (docs/spikes/P0-phone-build.md).
 * 2. **The checks.** `test/release.test.ts` fails if any file under `app/src` imports this file
 *    other than by a `require` inside an `if (__DEV__` block; and `app/e2e-native/release-check.ts`
 *    builds the release bundles with `expo export` and fails if either holds `hsn-ble-bench/1`,
 *    this wire's version, which is in this file.
 * 3. **By itself.** Where `__DEV__` is false it opens nothing: Bluetooth reads as "unsupported"
 *    and every connect fails. And it talks only to this Mac: loopback, or the Android emulator's
 *    alias for it (10.0.2.2); any other address is refused, so nothing leaves the Mac.
 *
 * It uses only the global `WebSocket` (React Native's, the browser's, Bun's) and the shared wire.
 */
import type {
  Advert,
  BleCentral,
  BleFault,
  BleState,
  GattLink,
} from "../../../../app/src/platform/ble.ts";
import { fault, ok, type Outcome } from "../outcome.ts";
import { type BridgeSocket, type MakeSocket, openSocket, sendText } from "../safe/socket.ts";
import {
  advertFromWire,
  BRIDGE_WIRE,
  fromHex,
  isBleState,
  isLocalBridge,
  type ReplyValue,
  readToPhone,
  type ToBench,
  toHex,
} from "./wire.ts";

/** React Native's and Metro's development flag; not defined under Bun or in a browser page. */
declare const __DEV__: boolean | undefined;

const OPEN = 1;

export interface BridgeCentral extends BleCentral {
  /** True once the bridge answered its hello; false if it could not be reached. */
  readonly ready: Promise<boolean>;
  /** Closes the bridge's socket: every link is lost, every scan stops. */
  shutdown(): void;
}

export interface BridgeOptions {
  /** How to open a WebSocket; the global one by default. */
  readonly makeSocket?: MakeSocket;
}

type Waiting = (reply: Outcome<ReplyValue, BleFault>) => void;

/** True where a development build's flag is known to be off: a release bundle. */
function releaseBuild(): boolean {
  return typeof __DEV__ !== "undefined" && !__DEV__;
}

/** A central that has nothing: for a release build or a bridge address not on this Mac. */
function nothing(state: BleState): BridgeCentral {
  return {
    ready: Promise.resolve(false),
    state: () => Promise.resolve(state),
    scan: () => () => undefined,
    connect: () => Promise.resolve(fault("failed")),
    shutdown: () => undefined,
  };
}

const defaultSocket: MakeSocket = (url) => new WebSocket(url) as unknown as BridgeSocket;

export function bridgeBleCentral(url: string, options: BridgeOptions = {}): BridgeCentral {
  if (releaseBuild() || !isLocalBridge(url)) return nothing("unsupported");
  const opened = openSocket(options.makeSocket ?? defaultSocket, url);
  if (!opened.ok) return nothing("unsupported");
  const socket = opened.value;

  let up = false;
  let ended = false;
  let nextId = 1;
  const queued: string[] = [];
  const waiting = new Map<number, Waiting>();
  const scans = new Map<number, (advert: Advert) => void>();
  const watches = new Map<number, (bytes: Uint8Array) => void>();
  const links = new Map<number, ClientLink>();
  let markReady: (ready: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((resolve) => {
    markReady = resolve;
  });

  const send = (message: ToBench): void => {
    const text = JSON.stringify(message);
    if (ended) return;
    if (up && socket.readyState === OPEN) {
      if (!sendText(socket, text)) end();
    } else queued.push(text);
  };

  const ask = (make: (id: number) => ToBench): Promise<Outcome<ReplyValue, BleFault>> => {
    if (ended) return Promise.resolve(fault("lost"));
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      send(make(id));
    });
  };

  class ClientLink implements GattLink {
    readonly #closed: ((fault: BleFault | null) => void)[] = [];
    #ended: { readonly fault: BleFault | null } | undefined;
    readonly #watches = new Set<number>();

    constructor(
      readonly number: number,
      readonly mtu: number,
    ) {}

    async write(
      characteristic: string,
      data: Uint8Array,
      response: boolean,
    ): Promise<Outcome<void, BleFault>> {
      if (this.#ended !== undefined) return fault("lost");
      const reply = await ask((id) => ({
        t: "write",
        id,
        link: this.number,
        char: characteristic,
        data: toHex(data),
        response,
      }));
      return reply.ok ? ok(undefined) : reply;
    }

    async read(characteristic: string): Promise<Outcome<Uint8Array, BleFault>> {
      if (this.#ended !== undefined) return fault("lost");
      const reply = await ask((id) => ({ t: "read", id, link: this.number, char: characteristic }));
      if (!reply.ok) return reply;
      const bytes = typeof reply.value === "string" ? fromHex(reply.value) : undefined;
      return bytes === undefined ? fault("failed") : ok(bytes);
    }

    watch(characteristic: string, data: (bytes: Uint8Array) => void): () => void {
      if (this.#ended !== undefined) return () => undefined;
      const watch = nextId++;
      watches.set(watch, data);
      this.#watches.add(watch);
      send({ t: "watch", watch, link: this.number, char: characteristic });
      return () => {
        if (!watches.delete(watch)) return;
        this.#watches.delete(watch);
        send({ t: "unwatch", watch });
      };
    }

    onClosed(closed: (fault: BleFault | null) => void): void {
      const done = this.#ended;
      if (done === undefined) this.#closed.push(closed);
      else
        queueMicrotask(() => {
          closed(done.fault);
        });
    }

    close(): void {
      if (this.#ended !== undefined) return;
      send({ t: "close", link: this.number });
      this.ended(null);
    }

    ended(why: BleFault | null): void {
      if (this.#ended !== undefined) return;
      this.#ended = { fault: why };
      links.delete(this.number);
      for (const watch of this.#watches) watches.delete(watch);
      this.#watches.clear();
      for (const listener of this.#closed.splice(0)) listener(why);
    }
  }

  function end(): void {
    if (ended) return;
    ended = true;
    up = false;
    markReady(false);
    for (const resolve of waiting.values()) resolve(fault("lost"));
    waiting.clear();
    scans.clear();
    for (const link of [...links.values()]) link.ended("lost");
  }

  socket.onopen = () => {
    up = true;
    if (!sendText(socket, JSON.stringify({ t: "hello", v: BRIDGE_WIRE }))) {
      end();
      return;
    }
    for (const text of queued.splice(0)) if (!sendText(socket, text)) end();
  };
  socket.onclose = end;
  socket.onerror = end;
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    const message = readToPhone(event.data);
    if (message === undefined) return;
    switch (message.t) {
      case "hello":
        markReady(message.v === BRIDGE_WIRE);
        if (message.v !== BRIDGE_WIRE) socket.close();
        return;
      case "reply": {
        const resolve = waiting.get(message.id);
        waiting.delete(message.id);
        resolve?.(message.ok ? ok(message.value) : fault(message.fault));
        return;
      }
      case "advert": {
        const advert = advertFromWire(message.advert);
        if (advert !== undefined) scans.get(message.scan)?.(advert);
        return;
      }
      case "notify": {
        const bytes = fromHex(message.data);
        if (bytes !== undefined) watches.get(message.watch)?.(bytes);
        return;
      }
      case "closed":
        links.get(message.link)?.ended(message.fault);
        return;
    }
  };

  return {
    ready,
    async state(): Promise<BleState> {
      const reply = await ask((id) => ({ t: "state", id }));
      return reply.ok && isBleState(reply.value) ? reply.value : "unsupported";
    },
    scan(service: string, found: (advert: Advert) => void): () => void {
      const scan = nextId++;
      scans.set(scan, found);
      send({ t: "scan", scan, service });
      return () => {
        if (!scans.delete(scan)) return;
        send({ t: "stopScan", scan });
      };
    },
    async connect(id: string, wantMtu: number): Promise<Outcome<GattLink, BleFault>> {
      const reply = await ask((n) => ({ t: "connect", id: n, device: id, mtu: wantMtu }));
      if (!reply.ok) return reply;
      const value = reply.value;
      if (value === null || typeof value === "string") return fault("failed");
      const link = new ClientLink(value.link, value.mtu);
      links.set(value.link, link);
      return ok(link);
    },
    shutdown(): void {
      socket.close();
      end();
    },
  };
}
