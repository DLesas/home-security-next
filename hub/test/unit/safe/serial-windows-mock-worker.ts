/** Exercises the actual serial worker exchange without loading kernel32 on another system. */
import { parentPort, workerData } from "node:worker_threads";
import { readPort, writePort } from "../../../src/shell/safe/ffi-windows-serial.ts";
import { serveSerial } from "../../../src/shell/safe/worker-serial-transfer.ts";

const { stopping, shared, mode } = workerData as {
  stopping: Int32Array;
  shared: Int32Array;
  mode: "echo" | "unplug" | "partial" | "waiting";
};
const count = new Uint32Array(1);
let incoming: Uint8Array | undefined = Uint8Array.from({ length: 256 }, (_, i) => i);
const calls = {
  GetLastError: () => 1167,
  /** Supplies one initial packet and then the fake driver's write buffer. */
  ReadFile: (_handle: number | bigint, bytes: unknown, _length: number, read: unknown) => {
    if (!(bytes instanceof Uint8Array) || !(read instanceof Uint32Array)) return 0;
    Atomics.add(shared, 0, 1);
    if (mode === "waiting") Atomics.wait(shared, 1, 0, 500);
    else Bun.sleepSync(10);
    if (mode === "unplug" && incoming === undefined) return 0;
    read[0] = incoming?.length ?? 0;
    if (incoming !== undefined) bytes.set(incoming);
    incoming = undefined;
    return 1;
  },
  /** Copies the real worker message into the driver's queue and reports the byte count. */
  WriteFile: (_handle: number | bigint, bytes: unknown, length: number, written: unknown) => {
    if (!(bytes instanceof Uint8Array) || !(written instanceof Uint32Array)) return 0;
    written[0] = mode === "partial" ? length - 1 : length;
    incoming = bytes.slice();
    return 1;
  },
};

if (parentPort !== null)
  serveSerial(
    parentPort,
    stopping,
    (bytes) => readPort(calls, 10n, bytes, count),
    (bytes) => {
      writePort(calls, 10n, bytes, count);
    },
  );
