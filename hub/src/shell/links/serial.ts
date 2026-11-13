/**
 * USB serial links (hub-design.md section 3, "Serial links"; protocol.md §10): a gateway's or a
 * board's serial port, or one of the bench's pseudo-terminals given with `--serial <path>`.
 * Each packet or setup message is COBS-encoded and ends with a zero byte; the protocol's
 * `UsbFrameDecoder` splits the stream into frames, and a frame that fails decoding costs only
 * itself and is counted (section 10). Writes leave one at a time through the link's send queue.
 * The port is opened as a terminal (see the SPEC-QUESTION on `TtyPort`).
 */
import { encodeUsbFrame, UsbFrameDecoder } from "@hsn/protocol";
import { err, ok, type Result } from "neverthrow";
import type { LinkId } from "../../core/model/ids.ts";
import type { LinkError } from "../../ports/links.ts";
import { SendQueue } from "./queue.ts";
import type { FrameRejection, LinkRegistry } from "./registry.ts";
import { closeTty, openTty, type TtyPort, writeTty } from "../safe/serial.ts";

/** The serial ports open as USB links, by path. */
export class SerialLinks {
  readonly #registry: LinkRegistry;
  /** Open ports by path, so a port is never opened twice. */
  readonly #byPath = new Map<string, LinkId>();

  constructor(registry: LinkRegistry) {
    this.#registry = registry;
  }

  /** Whether a port at this path is open. */
  has(path: string): boolean {
    return this.#byPath.has(path);
  }

  /** The paths open now. */
  get paths(): readonly string[] {
    return [...this.#byPath.keys()];
  }

  /** Opens the port at `path` as a USB link; an open one is left as it is. */
  open(path: string): Result<LinkId, LinkError> {
    const open = this.#byPath.get(path);
    if (open !== undefined) return ok(open);
    const port = openTty(path);
    if (port.isErr()) return err(port.error);
    return ok(this.#attach(port.value));
  }

  #attach(port: TtyPort): LinkId {
    const decoder = new UsbFrameDecoder();
    const opened: { link: LinkId | undefined } = { link: undefined };
    const queue = new SendQueue(
      (bytes) => writeTty(port, encodeUsbFrame(bytes)),
      (error, refs) => {
        // A write that failed after `send` returned: each send that will not leave is
        // `sendFailed`, and the link is closed (registry.ts).
        const link = opened.link;
        if (link === undefined) return;
        for (const ref of refs) this.#registry.failed(link, ref, error);
        this.#gone(port, link, "error");
      },
    );
    const link = this.#registry.open("usb", port.path, {
      send: (bytes, ref) => queue.push(bytes, ref),
      close: () => {
        queue.stop();
        this.#byPath.delete(port.path);
        return closeTty(port);
      },
    });
    opened.link = link;
    this.#byPath.set(port.path, link);
    port.stream.on("data", (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.ok) this.#registry.frame(link, frame.value);
        else this.#registry.reject(link, rejectionOf(frame.error.code));
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

  #gone(port: TtyPort, link: LinkId, reason: "remote" | "error"): void {
    if (this.#byPath.get(port.path) === link) this.#byPath.delete(port.path);
    if (!this.#registry.isOpen(link)) return;
    this.#registry.closed(link, reason);
    closeTty(port).match(
      () => undefined,
      () => undefined,
    );
  }
}

/** The decoder's errors: a frame that is not COBS, or one that is too long (§10). */
function rejectionOf(code: string): FrameRejection {
  return code === "tooLong" ? "tooLong" : "badFrame";
}
