/**
 * How a phone opens the channel's socket (m3-design.md section 2, "Reaching the hub at home";
 * section 6, "Home or relay"). Types only, frozen by step 0. Each gives a `Connect` (`hub/wire.ts`),
 * so the channel and the handshakes do not change. P1 and P2 build them (wave 1; the relay's with
 * M5). A browser has one way: the page's own origin (`webSocketConnect`, `channelOrigin`).
 */
import type { Connect } from "../hub/wire";
import type { Outcome } from "./split";

/** At home, by address. */
export interface HomeConnectOptions {
  /**
   * In the order tried: the address that last worked, then the hub's own list (the code's `a=`,
   * then `hub.info`'s `addresses`), then those an mDNS browse found (`HubFinder`).
   */
  readonly addresses: readonly string[];
  /** The apps' port. */
  readonly port: number;
  /** How long each address is given to connect † (1.5 s). */
  readonly perAddressMs: number;
  /** Told which address answered, so the record keeps it first. */
  readonly answered: (address: string) => void;
  /**
   * Told when the system refused the connection for want of the local network permission (iOS
   * says so ‡), so the page can say what to turn on; the `Connect` then resolves undefined.
   */
  readonly localNetworkDenied: () => void;
}

/**
 * `wss://<address>:<port>` and the channel's path, sending `Origin: https://<address>:<port>`
 * itself (the hub checks `Host` and `Origin` on every upgrade). TLS is carriage only (D132): the
 * hub's self-signed certificate is accepted for a private, link-local or loopback address or a
 * `.local` name, never for anything else; Noise's message 2 proves the hub.
 */
export type HubSocketConnect = (options: HomeConnectOptions) => Connect;

/** Away, through the relay's phone path (m4-design.md section 3). */
export interface RelayConnectOptions {
  /**
   * The relay's URL, no path: `hub.info`'s `relay`, else the code's `r=`, else the deployment's
   * default. `wss://`, or `ws://` to a private or loopback address in a development build only.
   */
  readonly relayUrl: string;
  /** The hub's app identity: the path is `/v1/phone/<identity>/<session | link | restore>`. */
  readonly identity: string;
}

/** Why the relay's `Connect` was not made: a `ws://` URL outside a development build. */
export type RelayRefusal = "notSecure";

/**
 * React Native's own WebSocket to the relay, which has an ordinary certificate. Its closes pass
 * through as the WebSocket gives them: 4404, the hub is not connected to the relay; 1013 and 4429,
 * the relay is busy; the hub's own, as at home.
 */
export type RelayConnect = (options: RelayConnectOptions) => Outcome<Connect, RelayRefusal>;
