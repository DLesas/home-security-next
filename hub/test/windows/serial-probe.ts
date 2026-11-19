/** Native W1 probe: overlapped I/O on hosted COM, optional Identify on the owner's board. */
import {
  decodeSetupMessage,
  encodeSetupMessage,
  encodeUsbFrame,
  SetupType,
  UsbFrameDecoder,
} from "@hsn/protocol";
import { setTimeout as deadline } from "node:timers/promises";
import { parentPort, Worker, workerData } from "node:worker_threads";
import {
  serialCalls,
  serialCompletion,
  type SerialCompletion,
  type SerialIoCalls,
} from "../../src/shell/safe/ffi-windows-serial.ts";
import { serveSerial } from "../../src/shell/safe/worker-serial-transfer.ts";
import type { SerialWorkerData } from "../../src/shell/safe/worker-windows-serial.ts";
import { openWindowsSerial, type WindowsSerialPort } from "../../src/shell/safe/serial-windows.ts";

const READ_AT_WRITE = 0;
const ABORTED_READ = 1;
const IDLE_READS = 2;
const ERROR_OPERATION_ABORTED = 995;

type NativeProbeData = Extract<SerialWorkerData, { kind: "port" }> & {
  readonly observed: Int32Array;
};

/** Numbers accepted reads and matches writes to the native completion of the same read. */
function observeReads(observed: Int32Array) {
  const native = serialCalls();
  let readCallback: Parameters<SerialIoCalls["ReadFileEx"]>[4];
  let reads = 0;
  let outstanding = 0;
  const calls: SerialIoCalls = {
    ...native,
    ReadFileEx: (...args) => {
      const accepted = native.ReadFileEx(...args);
      if (accepted !== 0) {
        readCallback = args[4];
        outstanding = ++reads;
      }
      return accepted;
    },
    WriteFileEx: (...args) => {
      Atomics.store(observed, READ_AT_WRITE, outstanding);
      return native.WriteFileEx(...args);
    },
  };
  const completion: SerialCompletion = (complete) => {
    const callback = serialCompletion((code, count) => {
      if (callback.ptr === readCallback) {
        if (code === ERROR_OPERATION_ABORTED) Atomics.store(observed, ABORTED_READ, outstanding);
        if (code === 0 && count === 0) Atomics.add(observed, IDLE_READS, 1);
        outstanding = 0;
      }
      complete(code, count);
    });
    return callback;
  };
  return { calls, completion };
}

// COM2 on a shared VM can lose some scheduling time. Still reject half-second serialization.
const BUDGET_MS = 100;

/** Writes on the first read, after an idle timeout, or as an Identify exchange with a board. */
async function probe(
  port: WindowsSerialPort,
  trial: "overlap" | "idle" | "identify",
  observed: Int32Array,
): Promise<boolean> {
  const ready = await Promise.race([
    new Promise<boolean>((resolve) => {
      port.stream.once("ready", () => {
        resolve(true);
      });
    }),
    port.closed.then(() => false),
    // A losing deadline must not keep the probe alive and delay mode.exe after release.
    deadline(5000, false, { ref: false }),
  ]);
  if (!ready) {
    port.close();
    await port.closed;
    console.error("The serial worker failed before accepting its first overlapped read");
    return false;
  }
  const identity = Promise.withResolvers<boolean>();
  if (trial === "identify") {
    const decoder = new UsbFrameDecoder();
    port.stream.on("data", (chunk: Buffer) => {
      for (const received of decoder.push(chunk)) {
        if (!received.ok) continue;
        const message = decodeSetupMessage(received.value);
        if (message.ok && message.value.type === SetupType.Identity) identity.resolve(true);
      }
    });
  }
  if (trial === "idle") await Bun.sleep(600);
  const idleReads = Atomics.load(observed, IDLE_READS);
  const frame = encodeUsbFrame(encodeSetupMessage({ type: SetupType.Identify }));
  const asked = performance.now();
  const sent = await port.write(frame);
  const writeMs = performance.now() - asked;
  let answered = true;
  if (trial === "identify" && sent.isOk()) {
    answered = await Promise.race([identity.promise, deadline(2000, false, { ref: false })]);
  }
  const stopping = performance.now();
  port.close();
  await port.closed;
  const closeMs = performance.now() - stopping;
  const readAtWrite = Atomics.load(observed, READ_AT_WRITE);
  const abortedRead = Atomics.load(observed, ABORTED_READ);
  console.log(
    `${port.path}: ${trial} WriteFileEx ${sent.isOk() ? "completed" : sent.error.message} in ${writeMs.toFixed(3)} ms (read at write: ${readAtWrite}, prior idle completions: ${idleReads})`,
  );
  console.log(
    `${port.path}: ${trial} close released the handle in ${closeMs.toFixed(3)} ms (aborted read: ${abortedRead})`,
  );
  if (trial === "identify")
    console.log(`${port.path}: ${answered ? "received Identity" : "no Identity within 2 s"}`);
  // The kernel aborted this very read after our write. It had not completed at submission.
  const overlapped = readAtWrite !== 0 && readAtWrite === abortedRead;
  return (
    sent.isOk() &&
    writeMs < BUDGET_MS &&
    closeMs < BUDGET_MS &&
    answered &&
    (trial !== "overlap" || overlapped) &&
    (trial !== "idle" || idleReads > 0)
  );
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
  for (const trial of identify ? (["identify"] as const) : (["idle", "overlap"] as const)) {
    const observed = new Int32Array(new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT));
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
    if (!(await probe(opened.value, trial, observed))) process.exit(1);
  }
}

if (parentPort === null) {
  await main();
} else {
  const data = workerData as NativeProbeData;
  const { calls, completion } = observeReads(data.observed);
  serveSerial(parentPort, data, calls, completion);
}
