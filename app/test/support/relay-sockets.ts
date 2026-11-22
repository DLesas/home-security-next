/**
 * A relay for the phone's client in tests: a `MakeRelaySocket` whose sockets, by the test's
 * choice, carry the phone's messages to an in-memory hub end (`hub-end.ts`) one for one, as the
 * relay carries them to a joined hub; open and then close with a code (4404 before any message,
 * as the relay answers when the hub is not connected, or a hub's own close passed through); close
 * before opening (an upgrade refused); or never open. Each socket records its URL and how it ended.
 */
import type { SocketLike } from "../../src/hub/finder";
import type { MakeRelaySocket } from "../../src/hub/relay";
import type { ChannelPath, Wire } from "../../src/hub/wire";
import type { HubEnd } from "./hub-end";

export type RelayBehaviour =
  | { readonly kind: "carry" }
  | { readonly kind: "close"; readonly code: number }
  | { readonly kind: "refuse" }
  | { readonly kind: "silent" };

export interface RelaySocketRecord {
  readonly url: string;
  /** The code the socket closed with, by either end; undefined while open or never opened. */
  closedWith: number | undefined;
  /** What the phone closed it with, if it did. */
  phoneClosed: number | undefined;
}

export interface RelaySockets {
  readonly make: MakeRelaySocket;
  readonly opened: RelaySocketRecord[];
  behaviour: RelayBehaviour;
}

const PATH = /^wss?:\/\/[^/]+\/v1\/phone\/([a-z2-7]{26})\/(session|link|restore)$/u;

export function relaySockets(hub: HubEnd, behaviour: RelayBehaviour = { kind: "carry" }) {
  const sockets: RelaySockets = {
    opened: [],
    behaviour,
    make: (url) => {
      const record: RelaySocketRecord = { url, closedWith: undefined, phoneClosed: undefined };
      sockets.opened.push(record);
      const parsed = PATH.exec(url);
      const path = parsed?.[2] as ChannelPath | undefined;
      let wire: Wire | undefined;
      const setState = (state: number) => {
        (socket as { readyState: number }).readyState = state;
      };
      const closeWith = (code: number) => {
        if (record.closedWith !== undefined) return;
        record.closedWith = code;
        setState(3);
        socket.onclose?.({ code });
      };
      const socket: SocketLike = {
        binaryType: "blob",
        readyState: 0,
        send: (data) => {
          wire?.send(data);
        },
        close: (code) => {
          record.phoneClosed ??= code ?? 1000;
          wire?.close(code);
          // As a WebSocket's own: the close event comes after `close` returns.
          setTimeout(() => {
            closeWith(code ?? 1000);
          }, 0);
        },
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
      };
      const now = sockets.behaviour;
      setTimeout(() => {
        if (now.kind === "silent") return;
        if (now.kind === "refuse" || path === undefined || parsed?.[1] !== hub.identity) {
          closeWith(1006);
          return;
        }
        if (now.kind === "close") {
          setState(1);
          socket.onopen?.({});
          setTimeout(() => {
            closeWith(now.code);
          }, 0);
          return;
        }
        void hub
          .connect(path, {
            message: (data) => {
              const copy = data.slice();
              socket.onmessage?.({ data: copy.buffer });
            },
            closed: (code) => {
              closeWith(code);
            },
          })
          .then((made) => {
            if (made === undefined) {
              closeWith(1006);
              return;
            }
            wire = made;
            setState(1);
            socket.onopen?.({});
          });
      }, 0);
      return socket;
    },
  };
  return sockets;
}
