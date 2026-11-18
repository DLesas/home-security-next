/** Overlapped serial exchange. Only this worker waits on the driver. */
import { receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import {
  OverlappedSerialOperation,
  serialCompletion,
  type SerialCompletion,
  type SerialIoCalls,
  type SerialWake,
} from "./ffi-windows-serial.ts";

export type WorkerReply =
  | { kind: "ready" }
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "written" }
  | { kind: "failed"; message: string };

const WAIT_IO_COMPLETION = 0xc0;
const WAIT_TIMEOUT = 0x102;
const INFINITE = 0xffff_ffff;

/** Keeps one read pending. Writes and stop wake the worker independently of its read. */
export function serveSerial(
  channel: MessagePort,
  incoming: MessagePort,
  stopping: Int32Array,
  handle: bigint,
  wake: SerialWake,
  calls: SerialIoCalls,
  completion: SerialCompletion = serialCompletion,
): void {
  const read = new OverlappedSerialOperation(calls, handle, "ReadFileEx", completion);
  let write: OverlappedSerialOperation | undefined;
  /** Transfers one packet or outcome to the hub. */
  const send = (reply: WorkerReply): void => {
    channel.postMessage(reply);
  };
  const bytes = new Uint8Array(4096);
  const events = BigInt64Array.of(wake.stop, wake.write);
  try {
    write = new OverlappedSerialOperation(calls, handle, "WriteFileEx", completion);
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
        if (!(next instanceof Uint8Array) || write.pending)
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
    send({
      kind: "failed",
      message: failure instanceof Error ? failure.message : "a serial call failed",
    });
  } finally {
    if (read.pending || write?.pending === true) {
      // Cancel does not wait, and an I/O that won the race can complete normally.
      calls.CancelIoEx(handle, null);
      while (read.pending || write?.pending === true) calls.SleepEx(INFINITE, 1);
    }
    write?.close();
    read.close();
    incoming.close();
    channel.close();
  }
}
