/** Native W1 probe: overlapped I/O on hosted COM, optional Identify on the owner's board. */
import {
  decodeSetupMessage,
  encodeSetupMessage,
  encodeUsbFrame,
  SetupType,
  UsbFrameDecoder,
} from "@hsn/protocol";
import { parentPort, Worker, workerData } from "node:worker_threads";
import { serialCalls, type SerialIoCalls } from "../../src/shell/safe/ffi-windows-serial.ts";
import { serveSerial } from "../../src/shell/safe/worker-serial-transfer.ts";
import type { SerialWorkerData } from "../../src/shell/safe/worker-windows-serial.ts";
import { openWindowsSerial, type WindowsSerialPort } from "../../src/shell/safe/serial-windows.ts";

const PENDING_AT_WRITE = 0;
const CANCELLED_PENDING_READ = 1;

type NativeProbeData = Extract<SerialWorkerData, { kind: "port" }> & {
  readonly observed: Int32Array;
};

/** Looks at the actual OVERLAPPED passed to the kernel, without changing the worker's decisions. */
function observeReads(observed: Int32Array): SerialIoCalls {
  const calls = serialCalls();
  let read: Uint8Array | undefined;
  /** OVERLAPPED.Internal is STATUS_PENDING (0x103) while the native request is outstanding. */
  const pending = (): boolean =>
    read !== undefined && new DataView(read.buffer, read.byteOffset).getUint32(0, true) === 0x103;
  return {
    ...calls,
    ReadFileEx: (...args) => {
      if (args[3] instanceof Uint8Array) read = args[3];
      return calls.ReadFileEx(...args);
    },
    WriteFileEx: (...args) => {
      if (pending()) Atomics.store(observed, PENDING_AT_WRITE, 1);
      return calls.WriteFileEx(...args);
    },
    CancelIoEx: (...args) => {
      const reading = pending();
      const cancelled = calls.CancelIoEx(...args);
      if (reading && cancelled !== 0) Atomics.store(observed, CANCELLED_PENDING_READ, 1);
      return cancelled;
    },
  };
}

// COM2 on a shared VM can lose some scheduling time. Still reject half-second serialization.
const BUDGET_MS = 100;

/** Waits for the first read submission, then tries one write or a direct close. */
async function probe(
  port: WindowsSerialPort,
  write: boolean,
  identify: boolean,
  observed: Int32Array,
): Promise<boolean> {
  const ready = await Promise.race([
    new Promise<boolean>((resolve) => {
      port.stream.once("ready", () => {
        resolve(true);
      });
    }),
    port.closed.then(() => false),
    Bun.sleep(5000).then(() => false),
  ]);
  if (!ready) {
    port.close();
    await port.closed;
    console.error("The serial worker failed before accepting its first overlapped read");
    return false;
  }
  let ok = true;
  if (write) {
    const identity = Promise.withResolvers<boolean>();
    const decoder = new UsbFrameDecoder();
    port.stream.on("data", (chunk: Buffer) => {
      for (const received of decoder.push(chunk)) {
        if (!received.ok) continue;
        const message = decodeSetupMessage(received.value);
        if (message.ok && message.value.type === SetupType.Identity) identity.resolve(true);
      }
    });
    const asked = performance.now();
    const frame = encodeUsbFrame(encodeSetupMessage({ type: SetupType.Identify }));
    const sent = await port.write(frame);
    const elapsed = performance.now() - asked;
    const duringRead = Atomics.load(observed, PENDING_AT_WRITE) === 1;
    console.log(
      `${port.path}: WriteFileEx ${sent.isOk() ? "completed" : sent.error.message} in ${elapsed.toFixed(3)} ms (submitted during pending native read: ${duringRead})`,
    );
    ok = sent.isOk() && elapsed < BUDGET_MS;
    if (identify) {
      const answered = await Promise.race([identity.promise, Bun.sleep(2000).then(() => false)]);
      console.log(`${port.path}: ${answered ? "received Identity" : "no Identity within 2 s"}`);
      ok &&= answered;
    } else if (ok) {
      // An ordinary idle timeout must keep the worker alive and able to submit another write.
      await Bun.sleep(600);
      const next = await port.write(frame);
      console.log(
        `${port.path}: write after an idle read timeout ${next.isOk() ? "completed" : next.error.message}`,
      );
      ok &&= duringRead && next.isOk();
    }
  }
  const stopping = performance.now();
  port.close();
  await port.closed;
  const elapsed = performance.now() - stopping;
  const cancelled = Atomics.load(observed, CANCELLED_PENDING_READ) === 1;
  console.log(
    `${port.path}: close released the handle in ${elapsed.toFixed(3)} ms (cancelled pending native read: ${cancelled})`,
  );
  return ok && elapsed < BUDGET_MS && (write || cancelled);
}

/** Runs with an empty hosted port, or asks a real board for Identity under two line settings. */
async function main(): Promise<void> {
  const [path, dtr = "off", rts = "off", option] = process.argv.slice(2);
  if (
    process.platform !== "win32" ||
    path === undefined ||
    (dtr !== "on" && dtr !== "off") ||
    (rts !== "on" && rts !== "off") ||
    (option !== undefined && option !== "--identify")
  ) {
    console.error(
      "On Windows: bun hub/test/windows/serial-probe.ts COMn [on|off] [on|off] [--identify]",
    );
    process.exit(1);
  }
  const identify = option === "--identify";
  const lines = { dtr: dtr === "on", rts: rts === "on" };
  for (const write of identify ? [true] : [true, false]) {
    const observed = new Int32Array(new SharedArrayBuffer(8));
    const opened = openWindowsSerial(path, {
      lines,
      startWorker: (job, stopping) =>
        new Worker(new URL(import.meta.url), {
          workerData: { ...job, stopping, observed },
          transferList: job.kind === "port" ? [job.incoming] : [],
        }),
    });
    if (opened.isErr()) {
      console.error(opened.error.message);
      process.exit(1);
    }
    opened.value.stream.on("error", (failure: { message: string }) => {
      console.error(failure.message);
    });
    console.log(`${path}: opened overlapped and verified DCB read-back (DTR ${dtr}, RTS ${rts})`);
    if (!(await probe(opened.value, write, identify, observed))) process.exit(1);
  }
}

if (parentPort === null) {
  await main();
} else {
  const data = workerData as NativeProbeData;
  serveSerial(
    parentPort,
    data.incoming,
    data.stopping,
    data.handle,
    data.wake,
    observeReads(data.observed),
  );
}
