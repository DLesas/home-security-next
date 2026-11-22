/**
 * Finding and reaching the hub from a phone (m3-design.md section 2, "Reaching the hub at home";
 * section 3, the ways in): the codes a phone is given, the order in which it tries a hub's
 * home-network addresses, and the socket to one address. Platform-neutral: the socket is made by
 * a `MakeSocket` (React Native's own WebSocket on a phone, `start.native.ts`; Bun's in tests),
 * the browse by a `HubFinder` (P1's `hub-net`; `NO_FINDER` until it exists).
 *
 * - **TLS is carriage only (D132).** The phone opens `wss://` only to a home host (a private,
 *   link-local or loopback address, or a `.local` name: `isHomeHost`, the rule `plugins/hub-tls`
 *   applies natively), sends `Origin: https://<host>:<port>` itself, as the hub's `Host` and
 *   `Origin` checks ask, and lets Noise's message 2 prove the hub: a connection to the wrong
 *   computer fails there (`notOurHub`, `wrongHub`).
 * - **The order:** the address that last worked; the hub's addresses as it last named them (the
 *   code's `a=`, then `hub.info`'s `addresses`); then the hubs an mDNS browse finds, of this
 *   hub's identity (any hub, for a typed code), each address given 1.5 s †. The relay comes after
 *   (`relay.ts`), for a session, a link and a restore.
 * - Nothing here logs. A code's secret stays in the `LinkSecret` the caller holds.
 */
import {
  APP_PATHS,
  LINKING,
  LISTENER_PORTS,
  parseIdentity,
  parseLinkFragment,
  parseLinkQr,
  parseTypedCode,
} from "@hsn/protocol/app";
import { PAIR_QR } from "@hsn/protocol/pairing";
import type { HomeConnectOptions, HubSocketConnect } from "../platform/connect";
import type { FinderFault, FoundHub, HubFinder } from "../platform/finder";
import type { HubReach } from "../platform/records";
import { NOT_BUILT, type Outcome } from "../platform/split";
import type { LinkSecret } from "./handshake";
import { openSocket } from "./safe/socket";
import { CLOSE, type Connect, type Timers, type Wire, type WireHandlers } from "./wire";

/** Each address is given this long to connect † (m3-design.md section 2). */
export const PER_ADDRESS_MS = 1500;

/** A browse lasts this long † (m3-design.md section 2). */
export const BROWSE_MS = 2000;

/** The apps' port when a person types an address without one: the hub's default. */
export const DEFAULT_APPS_PORT = LISTENER_PORTS.lan;

// ----- Home hosts -----

function ipv4Bytes(text: string): readonly number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^(?:0|[1-9]\d{0,2})$/u.test(p) ? Number(p) : -1));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

function ipv6Bytes(text: string): readonly number[] | undefined {
  if (!/^[0-9a-f:.]+$/iu.test(text) || text.split("::").length > 2) return undefined;
  const half = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const groups = part.split(":");
    for (const [i, group] of groups.entries()) {
      if (i === groups.length - 1 && group.includes(".")) {
        const v4 = ipv4Bytes(group);
        if (v4 === undefined) return undefined;
        out.push(...v4);
      } else if (/^[0-9a-f]{1,4}$/iu.test(group)) {
        const value = Number.parseInt(group, 16);
        out.push(value >> 8, value & 0xff);
      } else return undefined;
    }
    return out;
  };
  const [head = "", tail] = text.split("::");
  const front = half(head);
  const back = tail === undefined ? [] : half(tail);
  if (front === undefined || back === undefined) return undefined;
  if (tail === undefined) return front.length === 16 ? front : undefined;
  const fill = 16 - front.length - back.length;
  return fill >= 2 ? [...front, ...new Array<number>(fill).fill(0), ...back] : undefined;
}

/**
 * A host the phone accepts the hub's certificate for (D132): a private (10/8, 172.16/12,
 * 192.168/16), link-local (169.254/16) or loopback (127/8) IPv4 address; an IPv6 loopback,
 * unique-local (fc00::/7) or link-local (fe80::/10) address, bracketed or not; or a `.local` name.
 * The same rule as `plugins/hub-tls/HSNHubTls.m` and `HubTls.kt`, so the app never tries a host
 * whose certificate the phone would refuse.
 */
export function isHomeHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  if (bare.endsWith(".local") && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u.test(bare)) return true;
  const v4 = ipv4Bytes(bare);
  if (v4 !== undefined) {
    const [a = 0, b = 0] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ipv6Bytes(bare);
  if (v6 === undefined) return false;
  const loopback = v6.slice(0, 15).every((x) => x === 0) && v6[15] === 1;
  const first = v6[0] ?? 0;
  const second = v6[1] ?? 0;
  return loopback || (first & 0xfe) === 0xfc || (first === 0xfe && (second & 0xc0) === 0x80);
}

/**
 * A home host the phone can open a socket to by its text alone: an IPv6 link-local address needs a
 * zone, which a code never carries (m2-design.md section 5), so it is left out.
 */
export function isReachableHomeHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  return isHomeHost(bare) && !bare.includes("%") && !/^fe[89ab][0-9a-f]?:/u.test(bare);
}

/** An address as a URL's host: an IPv6 address in brackets. */
export function urlHost(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}

/**
 * An address a person typed, with or without a port (`192.168.1.20`, `192.168.1.20:8444`,
 * `fd00::20`, `[fd00::20]:8444`, `hub.local`), as the phone tries it; undefined when it is not a
 * home host the phone can reach.
 */
export function typedAddress(
  text: string,
): { readonly address: string; readonly port: number } | undefined {
  const clean = text
    .trim()
    .replace(/^https?:\/\//iu, "")
    .replace(/\/.*$/u, "");
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/u.exec(clean);
  const plain = /^([^:[\]]+)(?::(\d{1,5}))?$/u.exec(clean);
  const [address, port] = bracketed
    ? [bracketed[1] ?? "", bracketed[2]]
    : plain
      ? [plain[1] ?? "", plain[2]]
      : [clean, undefined];
  const portNumber = port === undefined ? DEFAULT_APPS_PORT : Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) return undefined;
  const lower = address.toLowerCase();
  return isReachableHomeHost(lower) ? { address: lower, port: portNumber } : undefined;
}

// ----- Codes -----

/**
 * Where a code says the hub is at home (the QR code's `a=` and `p=`), and its relay (`r=`, on a
 * link code and, should a hub write one, a restore code).
 */
export interface CodeReach {
  readonly addresses: readonly string[];
  readonly port: number;
  readonly relay?: string;
}

/** A link code as the phone holds it: the secret, and where the code says to go. */
export type PhoneLinkSecret = LinkSecret & { readonly reach?: CodeReach };

/** A restore code (`hsn://restore/1?…`, m2-design.md section 9): the new hub's identity and token. */
export interface RestoreCode {
  /** The new hub's own app identity, which message 2's key must hash to. */
  readonly identity: string;
  readonly secret: Uint8Array;
  readonly reach: CodeReach;
}

/** What a code read on the phone is. */
export type PhoneCode =
  /** A QR code or deep link `hsn://link/1?…`, or a pasted link address. */
  | { readonly kind: "link"; readonly from: "qr" | "linkAddress"; readonly secret: PhoneLinkSecret }
  /** A typed code `XXXX-XXXX-XXXX`, with the address the person gave, if any. */
  | { readonly kind: "typed"; readonly secret: PhoneLinkSecret }
  | { readonly kind: "restore"; readonly restore: RestoreCode }
  /** A board's pairing code (`hsn://pair/1?…`): P4's to read. */
  | { readonly kind: "pair"; readonly text: string };

/**
 * Why a code was not taken: not one of ours ("This is not a code from your home system."), one
 * of ours that cannot be read, or one whose address is not on a home network (which the phone
 * never opens a hub connection to, D132).
 */
export type CodeFault = "notOurs" | "unreadable" | "notHome";

const homeAddresses = (addresses: readonly string[]): readonly string[] =>
  addresses.map((a) => a.toLowerCase()).filter(isReachableHomeHost);

/**
 * Reads a code a phone was given: scanned, opened as a deep link, pasted or typed. A typed code is
 * read by `readTypedCode`, with its address; here, one typed alone. A console token
 * (`#console=…`) is the hub computer's own and never a phone's: not ours.
 */
export function readCode(text: string): Outcome<PhoneCode, CodeFault> {
  const trimmed = text.trim();
  if (trimmed.startsWith(`${LINKING.qrPrefix}?`)) {
    const qr = parseLinkQr(trimmed, "link");
    if (qr === undefined) return { ok: false, fault: "unreadable" };
    const reach: CodeReach = {
      addresses: homeAddresses(qr.addresses),
      port: qr.port,
      ...(qr.relay === undefined ? {} : { relay: qr.relay }),
    };
    return {
      ok: true,
      value: {
        kind: "link",
        from: "qr",
        secret: { kind: "secret", secret: qr.secret, identity: qr.identity, reach },
      },
    };
  }
  if (trimmed.startsWith(`${LINKING.restoreQrPrefix}?`)) {
    const qr = parseLinkQr(trimmed, "restore");
    if (qr === undefined) return { ok: false, fault: "unreadable" };
    return {
      ok: true,
      value: {
        kind: "restore",
        restore: {
          identity: qr.identity,
          secret: qr.secret,
          reach: {
            addresses: homeAddresses(qr.addresses),
            port: qr.port,
            ...(qr.relay === undefined ? {} : { relay: qr.relay }),
          },
        },
      },
    };
  }
  if (trimmed.startsWith(`${PAIR_QR.prefix}?`))
    return { ok: true, value: { kind: "pair", text: trimmed } };
  const address = /^https:\/\/(\[[^\]]+\]|[^/:#[\]]+):(\d{1,5})\/?#(.*)$/iu.exec(trimmed);
  if (address !== null) {
    const fragment = address[3] ?? "";
    if (!fragment.startsWith(`${LINKING.linkFragment}=`)) return { ok: false, fault: "notOurs" };
    const link = parseLinkFragment(fragment);
    const host = typedAddress(`${address[1] ?? ""}:${address[2] ?? ""}`);
    if (link === undefined) return { ok: false, fault: "unreadable" };
    if (host === undefined) return { ok: false, fault: "notHome" };
    return {
      ok: true,
      value: {
        kind: "link",
        from: "linkAddress",
        secret: {
          kind: "secret",
          secret: link.secret,
          identity: link.identity,
          reach: { addresses: [host.address], port: host.port },
        },
      },
    };
  }
  const typed = readTypedCode(trimmed);
  if (typed.ok) return { ok: true, value: { kind: "typed", secret: typed.value } };
  return { ok: false, fault: /^[\s\w-]{12,20}$/u.test(trimmed) ? "unreadable" : "notOurs" };
}

/**
 * A typed code, `XXXX-XXXX-XXXX` (read as the protocol forgives it: case, spaces, dashes, `I` and
 * `L` as `1`, `O` as `0`), with the address the person gave, if any. Without one, the hub is found
 * by a browse on the home network; with one, that address alone is tried.
 */
export function readTypedCode(
  code: string,
  address?: string,
): Outcome<PhoneLinkSecret, "badCode" | "badAddress"> {
  const parsed = parseTypedCode(code);
  if (parsed === undefined) return { ok: false, fault: "badCode" };
  if (address === undefined || address.trim() === "")
    return { ok: true, value: { kind: "typed", code: parsed } };
  const at = typedAddress(address);
  if (at === undefined) return { ok: false, fault: "badAddress" };
  return {
    ok: true,
    value: { kind: "typed", code: parsed, reach: { addresses: [at.address], port: at.port } },
  };
}

/** Where a phone link code says to go, if it says. */
export function reachOf(secret: LinkSecret): CodeReach | undefined {
  return "reach" in secret ? (secret as PhoneLinkSecret).reach : undefined;
}

// ----- The order of addresses -----

/** One hub's addresses at one port, in the order tried. */
export interface HubTarget {
  /** The hub's app identity, when known: a typed code names none. */
  readonly identity: string | null;
  readonly addresses: readonly string[];
  readonly port: number;
}

/**
 * The addresses a stored hub is tried at, in order: the one that last worked, then the hub's own
 * list (the code's `a=`, replaced by `hub.info`'s `addresses` once known), each once, home hosts
 * the phone can reach only.
 */
export function addressOrder(reach: HubReach): readonly string[] {
  const all = [...(reach.lastAddress === null ? [] : [reach.lastAddress]), ...reach.addresses];
  return [...new Set(all.map((a) => a.toLowerCase()))].filter(isReachableHomeHost);
}

/**
 * The hubs a browse found that may be the one wanted: of `identity` when it is known, every hub
 * when it is not (a typed code), each at its own port, its addresses home hosts only.
 */
export function foundTargets(
  found: readonly FoundHub[],
  identity: string | null,
): readonly HubTarget[] {
  return found
    .filter((hub) => identity === null || hub.identity === identity)
    .filter((hub) => parseIdentity(hub.identity) !== undefined)
    .map((hub) => ({
      identity: hub.identity,
      addresses: [...new Set(homeAddresses(hub.addresses))],
      port: hub.appsPort,
    }))
    .filter((t) => t.addresses.length > 0 && t.port >= 1 && t.port <= 65_535);
}

/** The browse until P1's `hub-net` exists: it finds nothing, and says why (`notBuilt`). */
export const NO_FINDER: HubFinder = { browse: () => Promise.resolve(NOT_BUILT) };

// ----- The socket to one address -----

/** What the phone needs of a WebSocket: React Native's, or Bun's in tests. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
}

/** Makes a socket to `url`, sending `Origin: <origin>` with the upgrade. May throw. */
export type MakeSocket = (url: string, origin: string) => SocketLike;

const OPEN = 1;

/**
 * Whether a socket's error says the system refused the local network (iOS's "local network
 * prohibited", Android 17's `ACCESS_LOCAL_NETWORK` refusal) ‡: the texts are from memory, to be
 * seen on a real phone, which the simulators never refuse.
 */
export function isLocalNetworkDenied(error: unknown): boolean {
  const found =
    typeof error === "object" && error !== null
      ? (error as { readonly message?: unknown }).message
      : error;
  const message = typeof found === "string" ? found : "";
  return /local network|NECP|Operation not permitted|EPERM|-65555|NoAuth/iu.test(message);
}

type Attempt =
  | { readonly kind: "open"; readonly wire: Wire }
  | { readonly kind: "failed" | "timeout" | "denied" };

function attempt(
  make: MakeSocket,
  timers: Timers,
  address: string,
  port: number,
  path: keyof typeof APP_PATHS,
  ms: number,
  handlers: WireHandlers,
): Promise<Attempt> {
  return new Promise((resolve) => {
    const host = `${urlHost(address)}:${String(port)}`;
    const socket = openSocket(
      (url) => make(url, `https://${host}`),
      `wss://${host}${APP_PATHS[path]}`,
    );
    if (socket === undefined) {
      resolve({ kind: "failed" });
      return;
    }
    let state: "opening" | "open" | "done" = "opening";
    let denied = false;
    const settle = (result: Attempt) => {
      if (state !== "opening") return;
      state = result.kind === "open" ? "open" : "done";
      cancel();
      resolve(result);
    };
    const cancel = timers.after(ms, () => {
      settle({ kind: "timeout" });
      socket.close();
    });
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      // One that opens after its time is up is closed: another address may be in use by then.
      if (state !== "opening") {
        socket.close(CLOSE.normal);
        return;
      }
      settle({
        kind: "open",
        wire: {
          send: (data) => {
            if (socket.readyState === OPEN) socket.send(data.slice());
          },
          close: (code = CLOSE.normal) => {
            socket.close(code);
          },
        },
      });
    };
    socket.onerror = (event) => {
      if (isLocalNetworkDenied(event)) denied = true;
    };
    socket.onmessage = (event) => {
      if (state !== "open") return;
      if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
      else socket.close(CLOSE.protocol);
    };
    socket.onclose = (event) => {
      if (state === "open") {
        state = "done";
        handlers.closed(event.code);
      } else settle({ kind: denied ? "denied" : "failed" });
    };
  });
}

/**
 * The phone's socket to the hub at home (`HubSocketConnect`): each address in turn, each given
 * `perAddressMs`; the first that opens carries the channel, and `answered` is told which.
 */
export function hubSocketConnect(make: MakeSocket, timers: Timers): HubSocketConnect {
  return (options: HomeConnectOptions): Connect =>
    async (path, handlers) => {
      let denied = false;
      for (const address of options.addresses) {
        const result = await attempt(
          make,
          timers,
          address,
          options.port,
          path,
          options.perAddressMs,
          handlers,
        );
        if (result.kind === "open") {
          options.answered(address);
          return result.wire;
        }
        if (result.kind === "denied") denied = true;
      }
      if (denied) options.localNetworkDenied();
      return undefined;
    };
}

/** What `targetsConnect` is told as it goes. */
export interface Reaching {
  /** The address and port that answered. */
  readonly answered: (address: string, port: number) => void;
  /** The system refused the local network (a browse or a socket said so). */
  readonly localNetworkDenied: () => void;
}

/** Tries targets in turn, each address once, until one opens. */
export function targetsConnect(
  socket: HubSocketConnect,
  targets: readonly HubTarget[],
  reaching: Reaching,
  perAddressMs = PER_ADDRESS_MS,
): Connect {
  return async (path, handlers) => {
    const tried = new Set<string>();
    for (const target of targets) {
      const fresh = target.addresses.filter((a) => !tried.has(`${a}|${String(target.port)}`));
      for (const a of fresh) tried.add(`${a}|${String(target.port)}`);
      if (fresh.length === 0) continue;
      const wire = await socket({
        addresses: fresh,
        port: target.port,
        perAddressMs,
        answered: (address) => {
          reaching.answered(address, target.port);
        },
        localNetworkDenied: reaching.localNetworkDenied,
      })(path, handlers);
      if (wire !== undefined) return wire;
    }
    return undefined;
  };
}

/** What a browse gave: the hubs, or why none (`localNetworkDenied` told on). */
export async function browseFor(
  finder: HubFinder,
  identity: string | null,
  reaching: Pick<Reaching, "localNetworkDenied">,
  ms = BROWSE_MS,
): Promise<Outcome<readonly HubTarget[], FinderFault>> {
  const browsed = await finder.browse(ms);
  if (!browsed.ok) {
    if (browsed.fault === "localNetworkDenied") reaching.localNetworkDenied();
    return browsed;
  }
  return { ok: true, value: foundTargets(browsed.value, identity) };
}

/**
 * A stored hub's `Connect`: its known addresses in order (`addressOrder`), then, when none
 * answers, those a browse finds of its identity. `current` is read at each connection, so a
 * record changed meanwhile (an address that answered, `hub.info`'s list) is used at once.
 */
export function storedHubConnect(
  socket: HubSocketConnect,
  finder: HubFinder,
  current: () => { readonly identity: string; readonly reach: HubReach } | undefined,
  reaching: Reaching,
): Connect {
  return async (path, handlers) => {
    const hub = current();
    if (hub === undefined) return undefined;
    const known: HubTarget = {
      identity: hub.identity,
      addresses: addressOrder(hub.reach),
      port: hub.reach.appsPort,
    };
    const first = await targetsConnect(socket, [known], reaching)(path, handlers);
    if (first !== undefined) return first;
    const found = await browseFor(finder, hub.identity, reaching);
    if (!found.ok) return undefined;
    const others = found.value.map((t) => ({
      ...t,
      addresses:
        t.port === known.port
          ? t.addresses.filter((a) => !known.addresses.includes(a))
          : t.addresses,
    }));
    return targetsConnect(socket, others, reaching)(path, handlers);
  };
}
