/** W1's Windows serial I/O and device-map wait. This entry is bundled in the Windows hub. */
import { parentPort, workerData } from "node:worker_threads";
import { serialCalls } from "./ffi-windows-serial.ts";
import { watchDeviceMap } from "./ffi-windows-serial-watch.ts";
import { serveSerial, type SerialTransfer } from "./worker-serial-transfer.ts";

export type SerialWorkerData =
  | ({ readonly kind: "port" } & SerialTransfer)
  | { readonly kind: "watch"; readonly stopping: Int32Array };

const channel = parentPort;
const data = workerData as SerialWorkerData;
if (channel !== null) {
  if (data.kind === "port") {
    serveSerial(channel, data, serialCalls());
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
