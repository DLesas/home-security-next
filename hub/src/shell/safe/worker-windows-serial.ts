/** W1's Windows serial I/O and device-map wait. This entry is bundled in the Windows hub. */
import { parentPort, workerData } from "node:worker_threads";
import { readPort, serialCalls, writePort } from "./ffi-windows-serial.ts";
import { watchDeviceMap } from "./ffi-windows-serial-watch.ts";
import { serveSerial } from "./worker-serial-transfer.ts";

export type SerialWorkerData = (
  { readonly kind: "port"; readonly handle: bigint } | { readonly kind: "watch" }
) & { readonly stopping: Int32Array };

const channel = parentPort;
const data = workerData as SerialWorkerData;
if (channel !== null) {
  if (data.kind === "port") {
    const calls = serialCalls();
    const count = new Uint32Array(1);
    serveSerial(
      channel,
      data.stopping,
      (bytes) => readPort(calls, data.handle, bytes, count),
      (bytes) => {
        writePort(calls, data.handle, bytes, count);
      },
    );
  } else {
    watchDeviceMap(
      data.stopping,
      () => {
        channel.postMessage({ kind: "ready" });
      },
      () => {
        channel.postMessage({ kind: "changed" });
      },
    );
    channel.close();
  }
}
