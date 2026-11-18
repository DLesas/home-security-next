/**
 * USB serial links (hub-design.md section 3, "Serial links"; protocol.md §10): a gateway's or a
 * board's serial port, or one of the bench's pseudo-terminals given with `--serial <path>`.
 * Each packet or setup message is COBS-encoded and ends with a zero byte; the protocol's
 * `UsbFrameDecoder` splits the stream into frames, and a frame that fails decoding costs only
 * itself and is counted (section 10). Writes leave one at a time through the link's send queue.
 * The port is opened as a terminal (see the SPEC-QUESTION on `TtyPort`).
 */
import type { EventEmitter } from "node:events";
import { encodeUsbFrame, UsbFrameDecoder } from "@hsn/protocol";
import { err, ok, type Result, type ResultAsync } from "neverthrow";
import type { LinkId } from "../../core/model/ids.ts";
import type { LinkError } from "../../ports/links.ts";
import { SendQueue } from "./queue.ts";
import type { FrameRejection, LinkRegistry } from "./registry.ts";
import { closeTty, openTty, writeTty } from "../safe/serial.ts";
import { serialPath } from "../safe/serial-windows.ts";

/** The byte stream beneath the shared USB framing. */
export interface SerialBytes {
  readonly path: string;
  readonly stream: EventEmitter;
  readonly write: (bytes: Uint8Array) => ResultAsync<void, LinkError>;
  readonly close: () => Result<void, LinkError>;
  readonly closed?: Promise<void>;
}

/** Adapts the system's terminal to the link's byte stream. */
function nativePort(path: string): Result<SerialBytes, LinkError> {
  return openTty(path).map((port) => ({
    path: port.path,
    stream: port.stream,
    write: (bytes) => writeTty(port, bytes),
    close: () => closeTty(port),
    ...("fd" in port ? {} : { closed: port.closed }),
  }));
}

/** The serial ports open as USB links, by path. */
export class SerialLinks {
  readonly #registry: LinkRegistry;
  /** Open ports by path, so a port is never opened twice. */
  readonly #byPath = new Map<string, LinkId>();
  readonly #asyncPorts = new Map<SerialBytes, Promise<void>>();
  #closing = false;

  constructor(
    registry: LinkRegistry,
    private readonly openPort: typeof nativePort = nativePort,
    private readonly reopenFailed?: (error: LinkError) => void,
  ) {
    this.#registry = registry;
  }

  /** Whether a port at this path is open. */
  has(path: string): boolean {
    return this.#byPath.has(serialPath(path));
  }

  /** The paths open now. */
  get paths(): readonly string[] {
    return [...this.#byPath.keys()];
  }

  /** Opens the port at `path` as a USB link; an open one is left as it is. */
  open(path: string): Result<LinkId, LinkError> {
    return this.#open(path, false);
  }

  #open(path: string, recovering: boolean): Result<LinkId, LinkError> {
    const label = serialPath(path);
    const open = this.#byPath.get(label);
    if (open !== undefined) return ok(open);
    const port = this.openPort(label);
    if (port.isErr()) return err(port.error);
    return ok(this.#attach(port.value, recovering));
  }

  /** Waits for ports with asynchronous close, including Windows serial workers. */
  async closeAsyncPorts(): Promise<void> {
    this.#closing = true;
    const pending = [...this.#asyncPorts.values()];
    for (const port of this.#asyncPorts.keys())
      port.close().match(
        () => undefined,
        () => undefined,
      );
    await Promise.all(pending);
  }

  #attach(port: SerialBytes, recovering: boolean): LinkId {
    if (port.closed !== undefined) {
      this.#asyncPorts.set(port, port.closed);
      void port.closed.then(() => this.#asyncPorts.delete(port));
    }
    const decoder = new UsbFrameDecoder();
    let canRecover = !recovering;
    let resync = recovering;
    const opened: { link: LinkId | undefined } = { link: undefined };
    const queue = new SendQueue(
      (bytes) => {
        const frame = encodeUsbFrame(bytes);
        if (!resync) return port.write(frame);
        // The board may still have the prefix of the frame that timed out.
        const delimited = new Uint8Array(frame.length + 1);
        delimited.set(frame, 1);
        resync = false;
        return port.write(delimited);
      },
      (error, refs) => {
        // A write that failed after `send` returned: each send that will not leave is
        // `sendFailed`, and the link is closed (registry.ts).
        const link = opened.link;
        if (link === undefined) return;
        for (const ref of refs) this.#registry.failed(link, ref, error);
        this.#gone(port, link, "error");
        // Reopen a Windows port once after a failed write. A healthy inbound frame restores
        // the allowance; a permanently failing port waits for a real device notification.
        if (canRecover && error.code === "writeFailed" && port.closed !== undefined)
          void port.closed.then(() => {
            if (this.#closing || this.has(port.path)) return;
            const reopened = this.#open(port.path, true);
            if (reopened.isErr()) this.reopenFailed?.(reopened.error);
          });
      },
    );
    const link = this.#registry.open("usb", port.path, {
      send: (bytes, ref) => queue.push(bytes, ref),
      close: () => {
        queue.stop();
        this.#byPath.delete(port.path);
        return port.close();
      },
    });
    opened.link = link;
    this.#byPath.set(port.path, link);
    port.stream.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.ok) {
          canRecover = true;
          this.#registry.frame(link, frame.value);
        } else this.#registry.reject(link, rejectionOf(frame.error.code));
      }
    });
    port.stream.on("close", () => {
      queue.stop();
      this.#gone(port, link, "remote");
    });
    port.stream.on("error", () => {
      queue.stop();
      this.#gone(port, link, "error");
    });
    return link;
  }

  #gone(port: SerialBytes, link: LinkId, reason: "remote" | "error"): void {
    if (this.#byPath.get(port.path) === link) this.#byPath.delete(port.path);
    if (!this.#registry.isOpen(link)) return;
    this.#registry.closed(link, reason);
    port.close().match(
      () => undefined,
      () => undefined,
    );
  }
}

/** The decoder's errors: a frame that is not COBS, or one that is too long (§10). */
function rejectionOf(code: string): FrameRejection {
  return code === "tooLong" ? "tooLong" : "badFrame";
}
