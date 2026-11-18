/** Serial worker exchange, exercised with doubles on any host. */
import type { MessagePort } from "node:worker_threads";

export type ReadSerial = (into: Uint8Array) => number;
export type WriteSerial = (bytes: Uint8Array) => void;
export type WorkerReply =
  | { kind: "ready" }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "written" }
  | { kind: "failed"; message: string };

/** Run synchronous driver reads and writes on the worker. */
export function serveSerial(
  channel: MessagePort,
  stopping: Int32Array,
  read: ReadSerial,
  write: WriteSerial,
): void {
  const bytes = new Uint8Array(4096);
  let ended = false;
  /** Sends bytes or an outcome to the hub. */
  const send = (reply: WorkerReply): void => {
    channel.postMessage(reply);
  };
  /** Disconnect so the parent sees the thread exit and can release the handle. */
  const end = (failure?: unknown): void => {
    if (ended) return;
    ended = true;
    if (failure !== undefined)
      send({
        kind: "failed",
        message: failure instanceof Error ? failure.message : "a serial call failed",
      });
    channel.close();
  };
  /** The close flag is visible even while the worker is in a blocking read. */
  const stopped = (): boolean => ended || Atomics.load(stopping, 0) !== 0;
  channel.on("message", (incoming: Uint8Array) => {
    if (stopped()) {
      end();
      return;
    }
    try {
      write(incoming);
      send({ kind: "written" });
    } catch (reason) {
      end(reason);
    }
  });
  /** A bounded native read, then yield to queued writes. */
  const receive = (): void => {
    if (stopped()) {
      end();
      return;
    }
    try {
      const got = read(bytes);
      if (!stopped() && got > 0) send({ kind: "data", bytes: bytes.slice(0, got) });
      setImmediate(receive);
    } catch (reason) {
      end(reason);
    }
  };
  send({ kind: "ready" });
  setImmediate(receive);
}
