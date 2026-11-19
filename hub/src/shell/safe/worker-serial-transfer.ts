/** Overlapped serial exchange. Only this worker waits on the driver. */
import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import {
  OverlappedSerialOperation,
  serialCompletion,
  type SerialCompletion,
  type SerialIoCalls,
  type SerialWake,
} from "./ffi-windows-serial.ts";
import { SERIAL_TIMEOUT_MS } from "./serial-windows-layout.ts";

export type WorkerReply =
  | { kind: "ready" }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "written" }
  | { kind: "drained" }
  | { kind: "failed"; message: string };

const WAIT_IO_COMPLETION = 0xc0;
const WAIT_TIMEOUT = 0x102;
const ERROR_NOT_FOUND = 1168;
// The read and write deadlines run concurrently. Allow one more driver timeout for completion delivery.
const DRAIN_MS = 2 * SERIAL_TIMEOUT_MS;

export interface SerialBuffers {
  readonly read: Uint8Array<SharedArrayBuffer>;
  readonly readOverlapped: Uint8Array<SharedArrayBuffer>;
  readonly writeOverlapped: Uint8Array<SharedArrayBuffer>;
}

export interface SerialTransfer {
  readonly incoming: MessagePort;
  readonly stopping: Int32Array;
  readonly handle: bigint;
  readonly wake: SerialWake;
  readonly buffers: SerialBuffers;
}

/** Keeps one read pending. Writes and stop wake the worker independently of its read. */
export function serveSerial(
  channel: MessagePort,
  { incoming, stopping, handle, wake, buffers }: SerialTransfer,
  calls: SerialIoCalls,
  completion: SerialCompletion = serialCompletion,
): void {
  const read = new OverlappedSerialOperation(
    calls,
    handle,
    "ReadFileEx",
    buffers.readOverlapped,
    completion,
  );
  let write: OverlappedSerialOperation | undefined;
  const failures: string[] = [];
  /** Transfers one packet or outcome to the hub. */
  const send = (reply: WorkerReply): void => {
    channel.postMessage(reply);
  };
  const bytes = buffers.read;
  const events = BigInt64Array.of(wake.stop, wake.write);
  try {
    write = new OverlappedSerialOperation(
      calls,
      handle,
      "WriteFileEx",
      buffers.writeOverlapped,
      completion,
    );
    if (Atomics.load(stopping, 0) !== 0) return;
    read.start(bytes);
    send({ kind: "ready" });
    while (Atomics.load(stopping, 0) === 0) {
      // Submission never waits for the read. The extra timeout only covers a failed SetEvent.
      const waited = calls.WaitForMultipleObjectsEx(events.length, events, 0, 1000, 1);
      if (waited === 0 || Atomics.load(stopping, 0) !== 0) break;
      if (waited !== 1 && waited !== WAIT_IO_COMPLETION && waited !== WAIT_TIMEOUT)
        throw new Error(`WaitForMultipleObjectsEx failed (Win32 ${calls.GetLastError()})`);
      const sent = write.take();
      if (sent !== undefined) {
        if (sent.count !== sent.bytes.length)
          throw new Error(`WriteFileEx sent ${sent.count} of ${sent.bytes.length} bytes`);
        send({ kind: "written" });
      }
      // Alertable waits can favor read completions indefinitely on a busy line. Take a write
      // on either wake. Its event is harmless if we already took the message on a read wake.
      const next: unknown = receiveMessageOnPort(incoming)?.message;
      if (next !== undefined) {
        if (
          !(next instanceof Uint8Array) ||
          !(next.buffer instanceof SharedArrayBuffer) ||
          write.pending
        )
          throw new Error("serial write message without a free request");
        write.start(next);
      }
      const got = read.take();
      if (got !== undefined) {
        if (got.count > 0) send({ kind: "data", bytes: got.bytes.slice(0, got.count) });
        if (Atomics.load(stopping, 0) === 0) read.start(bytes);
      }
    }
  } catch (failure) {
    failures.push(failure instanceof Error ? failure.message : "a serial call failed");
  } finally {
    if (read.pending || write?.pending === true) {
      const deadline = performance.now() + DRAIN_MS;
      if (calls.CancelIoEx(handle, null) === 0) {
        // A completed request can still have its APC queued. The code is diagnostic only.
        const code = calls.GetLastError();
        if (code !== ERROR_NOT_FOUND) failures.push(`CancelIoEx failed (Win32 ${code})`);
      }
      while (read.pending || write?.pending === true) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0 || calls.SleepEx(remaining, 1) === 0) break;
      }
      if (read.pending || write?.pending === true)
        failures.push(`serial I/O drain timed out after ${DRAIN_MS} ms`);
    }
    if (failures.length > 0) send({ kind: "failed", message: failures.join("; ") });
    if (!read.pending && write?.pending !== true) send({ kind: "drained" });
    // Leave pending callbacks alone while the issuing worker exits. Its APCs run only on that thread.
    if (write?.pending === false) write.close();
    if (!read.pending) read.close();
    incoming.close();
    channel.close();
  }
}
