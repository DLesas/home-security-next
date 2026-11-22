/**
 * The phone away from home: its path through the relay (m3-design.md section 6, "Home or relay";
 * m4-design.md section 3, "Phones"). Platform-neutral: the socket is made by a `MakeRelaySocket`
 * (React Native's own WebSocket on a phone, `start.native.ts`; Bun's in tests).
 *
 * - **Which relay.** The hub's own word (`hub.info`'s `relay`), else the code's `r=` (both kept
 *   in the record's `relayUrl`), else the deployment's default (`defaultRelayUrl`, null while
 *   the domain is the placeholder): with none of them there is no away path at all.
 * - **The socket.** `<relay url>/v1/phone/<identity>/<session | link | restore>`
 *   (`phoneStreamUrl`), one binary message per Noise message, a text message refused as at home:
 *   the same `Wire` as at home, so the channel and the handshakes do not change. The relay has an
 *   ordinary certificate, so TLS is the platform's own (D132 is for home hosts only); `ws://` is
 *   taken only in a development build, and only to a loopback or private address.
 * - **Its closes.** 4404, the hub is not connected to the relay; 1013 and 4429, the relay is busy
 *   (`relayClosedOf`). The hub's own closes come through unchanged and mean what they mean at
 *   home; a close of the relay's own before message 2 is the hub not reached, not refused
 *   (`isRelayOwnClose`), so it never counts towards "this phone may have been removed".
 * - **The order.** Home first, the relay last (`homeThenRelay`).
 * - Nothing here logs. The URL names the hub's identity only, never a key or a secret.
 */
import { isLocalHost } from "@hsn/deployment";
import { PHONE_CLOSE, PHONE_CLOSE_FROM_HUB, phoneStreamUrl } from "@hsn/protocol/relay";
import type { RelayConnect } from "../platform/connect";
import type { SocketLike } from "./finder";
import { openSocket } from "./safe/socket";
import { CLOSE, type Connect, type Timers, type Wire } from "./wire";

/** A relay socket is given this long to open ‡: past it, the relay is not reached. */
export const RELAY_OPEN_MS = 10_000;

/** Makes a socket to the relay's `url`. May throw. */
export type MakeRelaySocket = (url: string) => SocketLike;

/** What the app was built as: `ws://` relays are for development builds only (section 2). */
export interface RelayBuild {
  readonly development: boolean;
}

// ----- Which relay -----

/**
 * The relay a hub is reached through away from home: `named` (the record's `relayUrl`:
 * `hub.info`'s `relay`, else the code's `r=`), else the deployment's default; undefined when
 * neither, which is the case while the deployment's domain is the placeholder and the hub names
 * none (RD 2).
 */
export function relayUrlFor(
  named: string | null | undefined,
  defaultRelay: string | null,
): string | undefined {
  if (named !== null && named !== undefined && named !== "") return named;
  return defaultRelay ?? undefined;
}

/** A relay URL's scheme and host, read as text (React Native's `URL` lacks most of its parts). */
const RELAY_BASE = /^(wss?):\/\/(\[[0-9a-f:.]+\]|[^/?#@:\s[\]]+)(?::\d{1,5})?(?:\/[^?#\s]*)?$/iu;

/**
 * Whether the phone may open `url` (m3-design.md sections 2 and 6): `wss://` to any host;
 * `ws://` only in a development build, and only to a loopback or private address
 * (`isLocalHost`, the rule a hub's `relay.set` applies to `ws://`). Anything else, or a URL that
 * is not a relay's base URL, is refused.
 */
export function relayUrlAllowed(url: string, build: RelayBuild): boolean {
  const match = RELAY_BASE.exec(url);
  const scheme = match?.[1]?.toLowerCase();
  const host = match?.[2] ?? "";
  if (scheme === "wss") return true;
  return scheme === "ws" && build.development && isLocalHost(host);
}

// ----- Its closes -----

/** What a relay's close says to the person (m3-design.md section 6). */
export type RelayClosed =
  /** 4404: "The hub is not connected to the internet relay." */
  | "notConnected"
  /** 1013 (the hub's channel said try later) and 4429 (over a limit): "The relay is busy. Trying again." */
  | "busy";

/** The words a relay close maps to, or undefined for every other code (the hub's own among them). */
export function relayClosedOf(code: number): RelayClosed | undefined {
  if (code === PHONE_CLOSE.hubNotConnected) return "notConnected";
  if (code === PHONE_CLOSE.tryLater || code === PHONE_CLOSE.overLimit) return "busy";
  return undefined;
}

const FROM_HUB: readonly number[] = PHONE_CLOSE_FROM_HUB;
const RELAY_OWN: readonly number[] = Object.values(PHONE_CLOSE).filter(
  (code) => !FROM_HUB.includes(code),
);

/**
 * Whether a close is the relay's own (1001, 1003, 1009, 1013, 4400, 4404, 4410, 4429), not one
 * the hub made and the relay passed through (1000, 1008, 4000 to 4004). Before message 2 such a
 * close means the hub was not reached; the hub's own, as at home, that it refused.
 */
export function isRelayOwnClose(code: number): boolean {
  return RELAY_OWN.includes(code);
}

// ----- The socket -----

/** Told of every relay socket's close, with its code, while it opens or after it opened. */
export interface RelayWatch {
  closed(code: number): void;
}

const NO_WATCH: RelayWatch = { closed: () => undefined };

const OPEN = 1;

/**
 * The relay's `Connect` for one hub (`RelayConnect`, `platform/connect.ts`): refused
 * (`notSecure`) for a URL the phone may not open; otherwise a `Connect` that opens
 * `<relay>/v1/phone/<identity>/<path>` and resolves its `Wire` when the socket opens, or
 * undefined when it closes first or does not open within `RELAY_OPEN_MS`.
 */
export function relayConnect(
  make: MakeRelaySocket,
  timers: Timers,
  build: RelayBuild,
  watch: RelayWatch = NO_WATCH,
  openMs = RELAY_OPEN_MS,
): RelayConnect {
  return (options) => {
    if (!relayUrlAllowed(options.relayUrl, build)) return { ok: false, fault: "notSecure" };
    const connect: Connect = (path, handlers) =>
      new Promise((resolve) => {
        const url = phoneStreamUrl(options.relayUrl, { identity: options.identity, path });
        const socket = url === undefined ? undefined : openSocket(make, url);
        if (socket === undefined) {
          resolve(undefined);
          return;
        }
        let state: "opening" | "open" | "done" = "opening";
        const cancel = timers.after(openMs, () => {
          if (state !== "opening") return;
          state = "done";
          resolve(undefined);
          socket.close();
        });
        socket.binaryType = "arraybuffer";
        socket.onopen = () => {
          // One that opens after its time is up is closed: the phone has moved on.
          if (state !== "opening") {
            socket.close(CLOSE.normal);
            return;
          }
          state = "open";
          cancel();
          const wire: Wire = {
            send: (data) => {
              if (socket.readyState === OPEN) socket.send(data.slice());
            },
            close: (code = CLOSE.normal) => {
              socket.close(code);
            },
          };
          resolve(wire);
        };
        socket.onerror = () => undefined;
        socket.onmessage = (event) => {
          if (state !== "open") return;
          if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
          else socket.close(CLOSE.protocol);
        };
        socket.onclose = (event) => {
          if (state === "done") return;
          const was = state;
          state = "done";
          watch.closed(event.code);
          if (was === "open") handlers.closed(event.code);
          else {
            cancel();
            resolve(undefined);
          }
        };
      });
    return { ok: true, value: connect };
  };
}

// ----- The order -----

/** Which way a channel's socket went. */
export type PathInUse = "home" | "relay";

/**
 * Home first, then the relay (m3-design.md section 6): `home` is section 2's order; `relay`, made
 * at each connection (so a relay the hub has just named is used at once), is tried only when no
 * home socket opened, and not at all when there is none. `used` is told which carried it.
 */
export function homeThenRelay(
  home: Connect,
  relay: () => Connect | undefined,
  used: (path: PathInUse) => void = () => undefined,
): Connect {
  return async (path, handlers) => {
    const atHome = await home(path, handlers);
    if (atHome !== undefined) {
      used("home");
      return atHome;
    }
    const away = relay();
    const through = away === undefined ? undefined : await away(path, handlers);
    if (through !== undefined) used("relay");
    return through;
  };
}
