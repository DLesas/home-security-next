/**
 * The bridge (m3-design.md section 5, "A bridge for the simulators"): the scripted air served on a
 * WebSocket on this Mac's loopback only, so an app in the iOS simulator (which shares the Mac's
 * loopback) or the Android emulator (whose 10.0.2.2 is the Mac's loopback, or `adb reverse`) uses
 * the scripted boards through `bridgeBleCentral` exactly as the bench's own tests use them.
 *
 * Each WebSocket is one phone: a `ScriptedCentral` of its own on the shared air, so two simulators
 * are two phones (a second phone arriving is a second socket). What a phone's calls do is the
 * central's; the bridge only carries them (`wire.ts`). A socket that goes takes its scans, links and
 * subscriptions with it. Nothing is logged but counts; no byte of a session is printed.
 */
import type { BleFault, GattLink } from "../../../../app/src/platform/ble.ts";
import type { BleAir } from "../air/air.ts";
import { type CentralOptions, ScriptedCentral } from "../air/central.ts";
import { fault, ok, type Outcome } from "../outcome.ts";
import { serveSockets, type SocketPeer } from "../safe/serve.ts";
import {
  advertToWire,
  BRIDGE_WIRE,
  fromHex,
  readToBench,
  type ReplyValue,
  type ToPhone,
  toHex,
} from "./wire.ts";

export interface BridgeServerOptions {
  readonly air: BleAir;
  /** 0: any free port. */
  readonly port?: number;
  /** Each phone's Bluetooth: its MTU limit, its state, whether it reports duplicates. */
  readonly central?: CentralOptions;
  /** Answers plain HTTP on the same port (the smoke and desk pages). */
  readonly fetch?: (request: Request) => Response | Promise<Response>;
  /** Told when a phone comes or goes, for the bench's lines. */
  readonly onPhone?: (event: "connected" | "gone", phones: number) => void;
}

export interface BridgeServer {
  readonly port: number;
  readonly url: string;
  /** Phones connected now. */
  readonly phones: number;
  stop(): void;
}

interface Phone {
  readonly central: ScriptedCentral;
  greeted: boolean;
  readonly scans: Map<number, () => void>;
  readonly links: Map<number, GattLink>;
  readonly watches: Map<number, () => void>;
  nextLink: number;
}

/** The loopback address the bridge listens on, and only that. */
export const BRIDGE_HOST = "127.0.0.1";

export function startBridge(options: BridgeServerOptions): Outcome<BridgeServer, "cannotListen"> {
  let phones = 0;
  const served = serveSockets<Phone>({
    hostname: BRIDGE_HOST,
    port: options.port ?? 0,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    open: () => {
      phones += 1;
      options.onPhone?.("connected", phones);
      return {
        central: new ScriptedCentral(options.air, options.central),
        greeted: false,
        scans: new Map(),
        links: new Map(),
        watches: new Map(),
        nextLink: 1,
      };
    },
    message: (peer, phone, text) => {
      void handle(peer, phone, text);
    },
    close: (phone) => {
      phones -= 1;
      for (const stop of phone.scans.values()) stop();
      for (const unwatch of phone.watches.values()) unwatch();
      for (const link of phone.links.values()) link.close();
      phone.scans.clear();
      phone.watches.clear();
      phone.links.clear();
      options.onPhone?.("gone", phones);
    },
  });
  if (!served.ok) return fault("cannotListen");
  const server = served.value;
  return ok({
    port: server.port,
    url: `ws://${BRIDGE_HOST}:${String(server.port)}`,
    get phones() {
      return phones;
    },
    stop: () => {
      server.stop();
    },
  });
}

function say(peer: SocketPeer, message: ToPhone): void {
  peer.send(JSON.stringify(message));
}

function reply(peer: SocketPeer, id: number, outcome: Outcome<ReplyValue, BleFault>): void {
  say(
    peer,
    outcome.ok
      ? { t: "reply", id, ok: true, value: outcome.value }
      : { t: "reply", id, ok: false, fault: outcome.fault },
  );
}

async function handle(peer: SocketPeer, phone: Phone, text: string): Promise<void> {
  const message = readToBench(text);
  if (message === undefined) return;
  if (!phone.greeted) {
    if (message.t !== "hello" || message.v !== BRIDGE_WIRE) {
      peer.close();
      return;
    }
    phone.greeted = true;
    say(peer, { t: "hello", v: BRIDGE_WIRE });
    return;
  }
  switch (message.t) {
    case "hello":
      return;
    case "state":
      reply(peer, message.id, ok(await phone.central.state()));
      return;
    case "scan": {
      phone.scans.get(message.scan)?.();
      const stop = phone.central.scan(message.service, (advert) => {
        say(peer, { t: "advert", scan: message.scan, advert: advertToWire(advert) });
      });
      phone.scans.set(message.scan, stop);
      return;
    }
    case "stopScan":
      phone.scans.get(message.scan)?.();
      phone.scans.delete(message.scan);
      return;
    case "connect": {
      const connected = await phone.central.connect(message.device, message.mtu);
      if (!connected.ok) {
        reply(peer, message.id, connected);
        return;
      }
      const link = connected.value;
      const number = phone.nextLink++;
      phone.links.set(number, link);
      link.onClosed((why) => {
        phone.links.delete(number);
        say(peer, { t: "closed", link: number, fault: why });
      });
      reply(peer, message.id, ok({ link: number, mtu: link.mtu }));
      return;
    }
    case "write": {
      const link = phone.links.get(message.link);
      const data = fromHex(message.data);
      if (link === undefined || data === undefined) {
        reply(peer, message.id, fault("lost"));
        return;
      }
      const written = await link.write(message.char, data, message.response);
      reply(peer, message.id, written.ok ? ok(null) : written);
      return;
    }
    case "read": {
      const link = phone.links.get(message.link);
      if (link === undefined) {
        reply(peer, message.id, fault("lost"));
        return;
      }
      const read = await link.read(message.char);
      reply(peer, message.id, read.ok ? ok(toHex(read.value)) : read);
      return;
    }
    case "watch": {
      const link = phone.links.get(message.link);
      if (link === undefined) return;
      const unwatch = link.watch(message.char, (bytes) => {
        say(peer, { t: "notify", watch: message.watch, data: toHex(bytes) });
      });
      phone.watches.set(message.watch, unwatch);
      return;
    }
    case "unwatch":
      phone.watches.get(message.watch)?.();
      phone.watches.delete(message.watch);
      return;
    case "close":
      phone.links.get(message.link)?.close();
      return;
  }
}
