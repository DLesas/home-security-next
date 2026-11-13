/**
 * The bench bridge (hub-design.md section 11, "Real time: M1a's 'done when'"): for each network
 * link of the firmware's bench (a siren's Wi-Fi, a gateway's Wi-Fi), it holds the link's
 * pseudo-terminal and one WebSocket to the hub's `/device`, and carries one frame per message
 * both ways: the terminal's COBS frames (each ended by a zero byte, as on USB, §10) become
 * WebSocket messages, and each message is written to the terminal as one such frame. So the hub's
 * own WebSocket code is what the board reaches.
 *
 * The bench counts a network link as up while the far end holds its terminal open. So the bridge
 * opens the terminal only once the hub has taken the WebSocket, and closing either end closes the
 * other: the hub gone (stopped, restarted) is the board's network gone. It then tries again every
 * `retryMs` until it is stopped: the board's network comes back with the hub. Each terminal is
 * held by a small process of its own (`terminal-relay.ts`), which opens it byte-clean exactly as
 * the hub opens a serial port, so that letting go of it is immediate.
 */
import { join } from "node:path";
import { encodeUsbFrame, MaxPacketLength, UsbFrameDecoder } from "@hsn/protocol";

const RELAY = join(import.meta.dir, "terminal-relay.ts");

/** A terminal held by its relay process. */
interface HeldTerminal {
  readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
}

/** Opens `path` through a relay process: held once the relay says nothing went wrong at once. */
async function holdTerminal(path: string): Promise<HeldTerminal | string> {
  const proc = Bun.spawn(["bun", RELAY, path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // A terminal that cannot be opened ends the relay at once with a message.
  const early = await Promise.race([proc.exited, Bun.sleep(150).then(() => undefined)]);
  if (early !== undefined) {
    const why = (await new Response(proc.stderr).text()).trim();
    return why === "" ? `the relay for ${path} ended (${early})` : why;
  }
  return { process: proc };
}

/** One network link of the manifest. */
export interface BridgeLink {
  readonly device: string;
  readonly path: string;
}

export interface BridgeOptions {
  /** The hub's device endpoint, as `ws://127.0.0.1:8443/device`. */
  readonly hubUrl: string;
  /** How long to wait before trying a link again. */
  readonly retryMs?: number;
  /** How long a WebSocket may take to open. */
  readonly connectTimeoutMs?: number;
  /** One line per thing that happened, for the operator. */
  readonly log?: (line: string) => void;
}

/** What one link is doing now. */
export type LinkState = "connecting" | "up" | "stopped";

const DEFAULT_RETRY_MS = 500;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;

/** The network links of a bench manifest. */
export function networkLinks(manifest: {
  readonly devices: readonly {
    readonly name: string;
    readonly links: readonly { readonly kind: string; readonly path: string }[];
  }[];
}): readonly BridgeLink[] {
  return manifest.devices.flatMap((device) =>
    device.links
      .filter((link) => link.kind === "network")
      .map((link) => ({ device: device.name, path: link.path })),
  );
}

/**
 * An open WebSocket to the hub. What it gets before the terminal is held (the hub's first frames,
 * or its closing) is kept for `carry`, so nothing is lost while the relay starts.
 */
class HubSocket {
  readonly socket: WebSocket;
  #early: Uint8Array[] = [];
  #closed = false;
  #onMessage: ((bytes: Uint8Array) => void) | undefined;
  #onClose: (() => void) | undefined;

  constructor(socket: WebSocket, log: (line: string) => void) {
    this.socket = socket;
    socket.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : undefined;
      if (bytes === undefined) {
        log("a text message from the hub, dropped");
        return;
      }
      if (this.#onMessage === undefined) this.#early.push(bytes);
      else this.#onMessage(bytes);
    };
    socket.onclose = () => {
      this.#closed = true;
      this.#onClose?.();
    };
  }

  /** From now on, each message to `onMessage` (the early ones first), and the close to `onClose`. */
  attach(onMessage: (bytes: Uint8Array) => void, onClose: () => void): void {
    this.#onMessage = onMessage;
    this.#onClose = onClose;
    for (const bytes of this.#early.splice(0)) onMessage(bytes);
    if (this.#closed) onClose();
  }

  close(): void {
    this.socket.close();
  }
}

/** The WebSocket opened, or why not. */
function connect(
  url: string,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<HubSocket | string> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      socket.close();
      resolve(`no answer from ${url} within ${timeoutMs} ms`);
    }, timeoutMs);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(new HubSocket(socket, log));
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve(`cannot reach ${url}`);
    };
  });
}

/** One link: the WebSocket and the terminal, carried until either closes. */
function carry(
  link: BridgeLink,
  hub: HubSocket,
  terminal: HeldTerminal,
  log: (line: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const decoder = new UsbFrameDecoder(MaxPacketLength.Link);
    const { process: relay } = terminal;
    let done = false;
    const finish = (why: string): void => {
      if (done) return;
      done = true;
      hub.close();
      relay.kill();
      resolve(why);
    };
    void (async () => {
      const reader = relay.stdout.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const frame of decoder.push(chunk.value)) {
          if (frame.ok) hub.socket.send(frame.value);
          else log(`${link.device}: a frame from the bench does not decode (${frame.error.code})`);
        }
      }
      finish("the bench closed the terminal");
    })();
    hub.attach(
      (bytes) => {
        void relay.stdin.write(encodeUsbFrame(bytes));
        void relay.stdin.flush();
      },
      () => {
        finish("the hub closed the WebSocket");
      },
    );
  });
}

export class BenchBridge {
  readonly #links: readonly BridgeLink[];
  readonly #options: Required<Omit<BridgeOptions, "log">> & {
    readonly log: (line: string) => void;
  };
  readonly #states = new Map<string, LinkState>();
  readonly #running: Promise<void>[] = [];
  #stopped = false;
  /** Wakes every waiting retry, for `stop`. */
  #wake: (() => void)[] = [];
  /** Closes what each link holds now, for `stop`. */
  readonly #holding = new Map<string, () => void>();

  constructor(links: readonly BridgeLink[], options: BridgeOptions) {
    this.#links = links;
    this.#options = {
      hubUrl: options.hubUrl,
      retryMs: options.retryMs ?? DEFAULT_RETRY_MS,
      connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      log: options.log ?? (() => undefined),
    };
  }

  state(device: string): LinkState | undefined {
    return this.#states.get(device);
  }

  start(): void {
    for (const link of this.#links) this.#running.push(this.#run(link));
  }

  /** Closes every link and stops trying. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const close of this.#holding.values()) close();
    for (const wake of this.#wake.splice(0)) wake();
    await Promise.all(this.#running);
  }

  #pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.#options.retryMs);
      this.#wake.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Read through a call: `stop` may set it while `#run` awaits. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  async #run(link: BridgeLink): Promise<void> {
    const { log, hubUrl, connectTimeoutMs } = this.#options;
    let lastProblem = "";
    const problem = (why: string): void => {
      // Said once until it changes: a hub that is down is tried every half second.
      if (why !== lastProblem) log(`${link.device}: ${why}`);
      lastProblem = why;
    };
    while (!this.#stopped) {
      this.#states.set(link.device, "connecting");
      const socket = await connect(hubUrl, connectTimeoutMs, (line) => {
        log(`${link.device}: ${line}`);
      });
      if (typeof socket === "string") {
        problem(socket);
        await this.#pause();
        continue;
      }
      if (this.#isStopped()) {
        socket.close();
        break;
      }
      const terminal = await holdTerminal(link.path);
      if (typeof terminal === "string") {
        socket.close();
        problem(`cannot open ${link.path}: ${terminal}`);
        await this.#pause();
        continue;
      }
      if (this.#isStopped()) {
        // Stopped while the relay started.
        socket.close();
        terminal.process.kill();
        break;
      }
      lastProblem = "";
      this.#states.set(link.device, "up");
      log(`${link.device}: up (${link.path} <-> ${hubUrl})`);
      this.#holding.set(link.device, () => {
        socket.close();
        // Ends the carrying at once, whether or not the close handshake comes.
        terminal.process.kill();
      });
      const why = await carry(link, socket, terminal, log);
      this.#holding.delete(link.device);
      log(`${link.device}: down: ${why}`);
      if (!this.#isStopped()) await this.#pause();
    }
    this.#states.set(link.device, "stopped");
  }
}
