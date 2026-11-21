/**
 * The Windows COM adapter's doubles (`serial-windows.test.ts`, `serial-windows-timing.child.test.ts`):
 * the Win32 calls as a test supplies them, a port opened on them with the actual message loop in
 * a worker (`serial-windows-mock-worker.ts`), and the waits the tests share.
 */
import { expect } from "bun:test";
import { Worker } from "node:worker_threads";
import type { WindowsSerialCalls } from "../../../src/shell/safe/ffi-windows-serial.ts";
import { newDcb } from "../../../src/shell/safe/serial-windows-layout.ts";
import { openWindowsSerial } from "../../../src/shell/safe/serial-windows.ts";
import { ESCAPE, STOP, WAKE, WRITE, type FakeMode } from "./serial-windows-mock-worker.ts";

export type Failure =
  | "open"
  | "GetCommState"
  | "SetCommState"
  | "GetCommState read-back"
  | "read-back"
  | "SetCommTimeouts"
  | "PurgeComm";

/** Open/configure doubles observe the bytes handed to Win32 in call order. */
export function windows(fail?: Failure, code = 5, shared?: Int32Array) {
  const operations: string[] = [];
  const settings = newDcb();
  const calls: WindowsSerialCalls = {
    CreateFileW: (name, access, share, security, disposition, flags, template) => {
      operations.push("CreateFileW");
      expect(name instanceof Uint16Array ? String.fromCharCode(...name) : "").toBe(
        "\\\\.\\COM10\0",
      );
      expect([access, share, security, disposition, flags, template]).toEqual([
        0xc000_0000,
        0,
        null,
        3,
        0x4000_0000,
        0n,
      ]);
      return fail === "open" ? -1n : 10n;
    },
    GetCommState: (handle, target) => {
      operations.push("GetCommState");
      expect(handle).toBe(10n);
      const call = operations.length > 2 ? "GetCommState read-back" : "GetCommState";
      if (!(target instanceof Uint8Array) || fail === call) return 0;
      target.set(settings);
      if (fail === "read-back" && operations.length > 2) target[18] = 7;
      return 1;
    },
    SetCommState: (_handle, dcb) => {
      operations.push("SetCommState");
      if (!(dcb instanceof Uint8Array) || fail === "SetCommState") return 0;
      settings.set(dcb);
      return 1;
    },
    SetCommTimeouts: (_handle, timeouts) => {
      operations.push("SetCommTimeouts");
      expect(timeouts).toEqual(Uint32Array.of(0xffff_ffff, 0xffff_ffff, 500, 0, 500));
      return fail === "SetCommTimeouts" ? 0 : 1;
    },
    PurgeComm: (_handle, flags) => {
      operations.push("PurgeComm");
      expect(flags).toBe(0x0f);
      return fail === "PurgeComm" ? 0 : 1;
    },
    ReadFileEx: () => 0,
    WriteFileEx: () => 0,
    WaitForMultipleObjectsEx: () => 0,
    CancelIoEx: () => 0,
    SleepEx: () => 0,
    CreateEventW: (_attributes, manual, initial, name) => {
      expect([_attributes, initial, name]).toEqual([null, 0, null]);
      operations.push(manual === 1 ? "stop event" : "write event");
      return manual === 1 ? 11n : 12n;
    },
    SetEvent: (event) => {
      if (shared === undefined) return 0;
      Atomics.or(shared, WAKE, event === 11n ? STOP : WRITE);
      Atomics.notify(shared, WAKE);
      return 1;
    },
    CloseHandle: (handle) => {
      operations.push(handle === 10n ? "CloseHandle" : `close event ${handle}`);
      return 1;
    },
    GetLastError: () => code,
  };
  return { calls, operations };
}

/** Waits for a data or error message sent by the worker. */
export async function until(check: () => boolean): Promise<boolean> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(1);
  return check();
}

/** Opens COM10 with native-call doubles and the actual message loop in a worker. */
export function fakePort(mode: FakeMode) {
  const shared = new Int32Array(new SharedArrayBuffer((ESCAPE + 1) * 4));
  const { calls, operations } = windows(undefined, 5, shared);
  const port = openWindowsSerial("COM10", {
    system: calls,
    startWorker: (job, stopping) => {
      expect(job.kind).toBe("port");
      return new Worker(new URL("./serial-windows-mock-worker.ts", import.meta.url), {
        workerData: { ...job, stopping, mode, shared },
        transferList: job.kind === "port" ? [job.incoming] : [],
      });
    },
  })._unsafeUnwrap();
  let ready = false;
  port.stream.on("ready", () => {
    ready = true;
  });
  const received: Uint8Array[] = [];
  const errors: string[] = [];
  port.stream.on("data", (bytes: Uint8Array) => {
    received.push(bytes);
  });
  port.stream.on("error", (error: { message: string }) => {
    errors.push(error.message);
  });
  return { port, shared, received, errors, operations, ready: () => ready };
}

/** Bounds the test separately from the drain and frees the double if the worker hangs. */
export async function expectClosed(shared: Int32Array, closed: Promise<void>): Promise<void> {
  const watchdog = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    watchdog.resolve(false);
    Atomics.store(shared, ESCAPE, 1);
    Atomics.notify(shared, ESCAPE);
  }, 2200);
  const exited = await Promise.race([closed.then(() => true), watchdog.promise]);
  clearTimeout(timer);
  expect(exited).toBe(true);
}

// Aim for 5 ms. Leave 5 ms for local cross-thread scheduling and more on the hosted Windows VM.
export const wakeBudgetMs = process.platform === "win32" ? 50 : 10;
