/** Doubles for the Win32 calls made by the production serial worker. */
import type { Pointer } from "bun:ffi";
import { parentPort, workerData } from "node:worker_threads";
import type {
  SerialCompletion,
  SerialIoCalls,
} from "../../../src/shell/safe/ffi-windows-serial.ts";
import { serveSerial } from "../../../src/shell/safe/worker-serial-transfer.ts";
import type { SerialWorkerData } from "../../../src/shell/safe/worker-windows-serial.ts";

export type FakeMode =
  | "loopback"
  | "echo"
  | "unplug"
  | "partial"
  | "write-error"
  | "waiting"
  | "busy-read"
  | "before-read"
  | "after-read"
  | "late-data"
  | "no-completion"
  | "cancel-failed"
  | "cancel-not-found"
  | "close-race";

export const WAKE = 0;
export const READS = 1;
export const GATE = 2;
export const DRAINED = 3;
export const WRITES = 4;
export const FIRST_BYTE = 5;
export const ESCAPE = 6;
export const STOP = 1;
export const WRITE = 2;

type FakeWorkerData = Extract<SerialWorkerData, { kind: "port" }> & {
  shared: Int32Array;
  mode: FakeMode;
};

/** Supplies pending I/O with an observable read barrier and a 500 ms idle deadline. */
function driver({ shared, mode, handle, wake }: FakeWorkerData) {
  const callbacks = new Map<unknown, Parameters<SerialCompletion>[0]>();
  let reading:
    { bytes: Uint8Array; complete: Parameters<SerialCompletion>[0]; until: number } | undefined;
  let writing: { count: number; complete: Parameters<SerialCompletion>[0] } | undefined;
  let incoming =
    mode === "echo" || mode === "unplug" || mode === "after-read"
      ? Uint8Array.from({ length: 256 }, (_, i) => i)
      : undefined;

  /** Delays at a specific boundary until the test posts its write or stop. */
  function gate(): void {
    Atomics.store(shared, GATE, 1);
    if (mode === "close-race") Atomics.wait(shared, GATE, 1, 500);
    else Atomics.wait(shared, WAKE, 0, 500);
  }

  const createCompletion: SerialCompletion = (complete) => {
    const ptr = (callbacks.size + 1) as Pointer;
    callbacks.set(ptr, complete);
    return {
      ptr,
      close: () => {
        callbacks.delete(ptr);
      },
    };
  };

  const calls: SerialIoCalls = {
    GetLastError: () => (mode === "cancel-not-found" ? 1168 : 1167),
    ReadFileEx: (port, bytes, length, overlap, callback) => {
      const complete = callbacks.get(callback);
      if (
        port !== handle ||
        !(bytes instanceof Uint8Array) ||
        !(bytes.buffer instanceof SharedArrayBuffer) ||
        length !== bytes.length ||
        !(overlap instanceof Uint8Array) ||
        !(overlap.buffer instanceof SharedArrayBuffer) ||
        overlap.length !== 32 ||
        overlap.some((byte) => byte !== 0) ||
        complete === undefined
      )
        return 0;
      if ((mode === "before-read" || mode === "close-race") && Atomics.load(shared, READS) === 0)
        gate();
      Atomics.add(shared, READS, 1);
      if (mode === "unplug" && Atomics.load(shared, READS) > 1) return 0;
      reading = {
        bytes,
        complete,
        until: mode === "no-completion" ? Infinity : performance.now() + 500,
      };
      // Windows owns the status and count fields after submission.
      overlap.fill(0xff, 0, 16);
      return 1;
    },
    WriteFileEx: (port, bytes, length, overlap, callback) => {
      const complete = callbacks.get(callback);
      if (
        port !== handle ||
        !(bytes instanceof Uint8Array) ||
        !(bytes.buffer instanceof SharedArrayBuffer) ||
        length !== bytes.length ||
        !(overlap instanceof Uint8Array) ||
        !(overlap.buffer instanceof SharedArrayBuffer) ||
        overlap.length !== 32 ||
        overlap.some((byte) => byte !== 0) ||
        complete === undefined ||
        mode === "write-error"
      )
        return 0;
      overlap.fill(0xff, 0, 16);
      if (Atomics.add(shared, WRITES, 1) === 0) Atomics.store(shared, FIRST_BYTE, bytes[0] ?? -1);
      writing = { count: mode === "partial" ? length - 1 : length, complete };
      if (mode === "echo" || mode === "loopback") incoming = bytes.slice();
      return 1;
    },
    WaitForMultipleObjectsEx: (length, events, all, timeout, alertable) => {
      if (
        length !== 2 ||
        !(events instanceof BigInt64Array) ||
        events[0] !== wake.stop ||
        events[1] !== wake.write ||
        all !== 0 ||
        timeout !== 1000 ||
        alertable !== 1
      )
        return 0xffff_ffff;
      for (;;) {
        const signal = Atomics.load(shared, WAKE);
        if ((signal & STOP) !== 0) return 0;
        if (writing !== undefined && mode !== "no-completion") {
          writing.complete(0, writing.count);
          writing = undefined;
          return 0xc0;
        }
        // This Win32 double can repeatedly return an APC ahead of the signaled write event.
        if (mode === "busy-read" && reading !== undefined) {
          reading.complete(0, 0);
          reading = undefined;
          return 0xc0;
        }
        if ((signal & WRITE) !== 0) {
          Atomics.and(shared, WAKE, ~WRITE);
          return 1;
        }
        if (
          reading !== undefined &&
          (incoming !== undefined || performance.now() >= reading.until)
        ) {
          const count = incoming?.length ?? 0;
          if (incoming !== undefined) reading.bytes.set(incoming);
          incoming = undefined;
          reading.complete(0, count);
          reading = undefined;
          if (mode === "after-read" && count > 0) gate();
          return 0xc0;
        }
        Atomics.wait(
          shared,
          WAKE,
          signal,
          Math.min(timeout, (reading?.until ?? 0) - performance.now()),
        );
      }
    },
    CancelIoEx: (port, overlap) => {
      if (port !== handle || overlap !== null) return 0;
      Atomics.store(shared, DRAINED, 1);
      return mode === "cancel-failed" || mode === "cancel-not-found" ? 0 : 1;
    },
    SleepEx: (timeout, alertable) => {
      if (alertable !== 1) return 0;
      // The watchdog can free even a worker regressed to an infinite wait.
      if (mode === "no-completion" || Atomics.load(shared, DRAINED) !== 1) {
        Atomics.wait(shared, ESCAPE, 0, timeout);
        if (Atomics.load(shared, ESCAPE) === 0) return 0;
      }
      reading?.complete(995, 0);
      writing?.complete(995, 0);
      reading = undefined;
      writing = undefined;
      Atomics.store(shared, DRAINED, 2);
      return 0xc0;
    },
  };
  return { calls, createCompletion };
}

if (parentPort !== null) {
  const job = workerData as FakeWorkerData;
  if (job.mode === "late-data") {
    parentPort.postMessage({ kind: "ready" });
    Atomics.wait(job.shared, WAKE, 0, 500);
    // Simulates a data message already in flight when the parent asks the worker to stop.
    parentPort.postMessage({ kind: "data", bytes: Uint8Array.of(0, 1, 255) });
    parentPort.postMessage({ kind: "drained" });
    job.incoming.close();
    parentPort.close();
  } else {
    const { calls, createCompletion } = driver(job);
    serveSerial(parentPort, job, calls, createCompletion);
  }
}
