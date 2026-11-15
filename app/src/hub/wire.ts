/**
 * The socket under the channel (m2-design.md section 5, "Framing"): each binary WebSocket message
 * carries exactly one Noise message; a text message closes the socket. The browser's WebSocket is
 * one implementation; the tests' in-memory pair is another.
 */
import { APP_PATHS } from "@hsn/protocol/app";

export interface Wire {
  send(data: Uint8Array): void;
  close(code?: number): void;
}

export interface WireHandlers {
  message(data: Uint8Array): void;
  /** The socket closed, by either end; `code` as the WebSocket gives it. */
  closed(code: number): void;
}

/**
 * Which handshake a socket carries, said by its path (`APP_PATHS`, section 5): `/app` for a
 * session, `/app/link`, `/app/restore`; the hub reads no message on trial.
 */
export type ChannelPath = keyof typeof APP_PATHS;

/** Opens a socket to the hub on a path; undefined when it cannot be reached. */
export type Connect = (path: ChannelPath, handlers: WireHandlers) => Promise<Wire | undefined>;

/** Close codes the client uses (WebSocket's own range). */
export const CLOSE = {
  normal: 1000,
  /**
   * The client stops: a decrypt failure, a frame it cannot read, a hub that does not answer. In
   * the application range: a browser's \`close\` throws on any code but 1000 and 3000 to 4999.
   */
  protocol: 4002,
  /** The hub's 24-hour lifetime (section 5) ‡. */
  lifetime: 4000,
} as const;

/** The channel's origin: the page's own, which the content security policy alone allows. */
export function channelOrigin(location: {
  readonly protocol: string;
  readonly host: string;
}): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/** The browser's WebSocket as a `Connect`. */
export function webSocketConnect(
  origin: string,
  make: (url: string) => WebSocket = (u) => new WebSocket(u),
): Connect {
  return (path, handlers) =>
    new Promise((resolve) => {
      let socket: WebSocket;
      try {
        socket = make(`${origin}${APP_PATHS[path]}`);
      } catch {
        resolve(undefined);
        return;
      }
      socket.binaryType = "arraybuffer";
      let opened = false;
      socket.onopen = () => {
        opened = true;
        resolve({
          send: (data) => {
            if (socket.readyState === socket.OPEN) socket.send(data.slice());
          },
          close: (code = CLOSE.normal) => {
            try {
              socket.close(code);
            } catch {
              // A code the browser refuses: closed all the same, with the default.
              socket.close();
            }
          },
        });
      };
      socket.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof ArrayBuffer) handlers.message(new Uint8Array(event.data));
        else socket.close(CLOSE.protocol);
      };
      socket.onclose = (event) => {
        if (opened) handlers.closed(event.code);
        else resolve(undefined);
      };
    });
}

/**
 * Messages that come in while a handshake waits for them: a queue with one waiter, ended by the
 * socket's close or by a deadline.
 */
export type Next =
  | { readonly kind: "message"; readonly data: Uint8Array }
  | { readonly kind: "closed"; readonly code: number }
  | { readonly kind: "timeout" };

export interface Timers {
  now(): number;
  after(ms: number, run: () => void): () => void;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  after: (ms, run) => {
    const handle = setTimeout(run, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

export class Inbox {
  private readonly queue: Uint8Array[] = [];
  private closedCode: number | undefined;
  private waiter: ((next: Next) => void) | undefined;
  private forwardTo: WireHandlers | undefined;

  constructor(private readonly timers: Timers) {}

  push(data: Uint8Array): void {
    if (this.forwardTo !== undefined) this.forwardTo.message(data);
    else if (this.waiter === undefined) this.queue.push(data);
    else this.settle({ kind: "message", data });
  }

  close(code: number): void {
    this.closedCode = code;
    if (this.forwardTo !== undefined) this.forwardTo.closed(code);
    else this.settle({ kind: "closed", code });
  }

  /** Hands what is queued, and everything after, to `handlers`, in order: the handshake is over. */
  forward(handlers: WireHandlers): void {
    this.forwardTo = handlers;
    for (const data of this.queue.splice(0)) handlers.message(data);
    if (this.closedCode !== undefined) handlers.closed(this.closedCode);
  }

  next(timeoutMs: number): Promise<Next> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve({ kind: "message", data: queued });
    if (this.closedCode !== undefined)
      return Promise.resolve({ kind: "closed", code: this.closedCode });
    return new Promise((resolve) => {
      const cancel = this.timers.after(timeoutMs, () => {
        this.settle({ kind: "timeout" });
      });
      this.waiter = (next) => {
        cancel();
        resolve(next);
      };
    });
  }

  private settle(next: Next): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.(next);
  }
}
