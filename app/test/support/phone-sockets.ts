/**
 * Sockets for the phone's client in tests: `MakeSocket` onto in-memory hub ends (`hub-end.ts`),
 * one per home-network address, as React Native's WebSocket reaches a hub on a phone. Each socket
 * records its URL and `Origin`; an address with no hub, or one that is not reachable, closes
 * before opening, as a refused connection does.
 */
import type { MakeSocket, SocketLike } from "../../src/hub/finder";
import type { ChannelPath, Wire } from "../../src/hub/wire";
import type { HubEnd } from "./hub-end";

const PATHS: Readonly<Record<string, ChannelPath>> = {
  "/app": "session",
  "/app/link": "link",
  "/app/restore": "restore",
};

export interface PhoneSockets {
  readonly make: MakeSocket;
  /** Each socket asked for: its URL and `Origin`. */
  readonly opened: { readonly url: string; readonly origin: string }[];
}

export function phoneSockets(hubs: ReadonlyMap<string, HubEnd>): PhoneSockets {
  const opened: { url: string; origin: string }[] = [];
  const make: MakeSocket = (url, origin) => {
    opened.push({ url, origin });
    const parsed = /^wss:\/\/(\[[^\]]+\]|[^/:]+):(\d+)(\/.*)$/u.exec(url);
    const host = (parsed?.[1] ?? "").replace(/^\[(.*)\]$/u, "$1");
    const path = PATHS[parsed?.[3] ?? ""];
    let wire: Wire | undefined;
    const socket: SocketLike = {
      binaryType: "blob",
      readyState: 0,
      send: (data) => {
        wire?.send(data);
      },
      close: (code) => {
        (socket as { readyState: number }).readyState = 3;
        wire?.close(code);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    const hub = hubs.get(host);
    setTimeout(() => {
      if (
        hub === undefined ||
        path === undefined ||
        `https://${parsed?.[1] ?? ""}:${parsed?.[2] ?? ""}` !== origin
      ) {
        socket.onclose?.({ code: 1006 });
        return;
      }
      void hub
        .connect(path, {
          message: (data) => {
            const copy = data.slice();
            socket.onmessage?.({ data: copy.buffer });
          },
          closed: (code) => {
            (socket as { readyState: number }).readyState = 3;
            socket.onclose?.({ code });
          },
        })
        .then((made) => {
          if (made === undefined) {
            socket.onclose?.({ code: 1006 });
            return;
          }
          wire = made;
          (socket as { readyState: number }).readyState = 1;
          socket.onopen?.({});
        });
    }, 0);
    return socket;
  };
  return { make, opened };
}
