/** One phone-side update grant, held in memory until its screen finishes. */
import type { BluetoothSessionObject } from "@hsn/protocol/app";
import { fromHex } from "@hsn/protocol/messages";
import { BLUETOOTH_UPDATE, bluetoothUpdateName } from "@hsn/protocol/update";
import { fromBase64url } from "../hub/files";
import type { BleCentral, BluetoothUpdate } from "../platform/ble";
import { type ImageReader, MIN_UPDATE_MTU, NO_PROGRESS_MS, serveImage } from "./firmware-server";
import { discover, isAborted, type RadioClock } from "./radio";

/** Turns the grant into memory-only bytes, with an expiry on the phone's monotonic clock. */
export function updateGrant(
  value: BluetoothSessionObject,
  clock: RadioClock,
): BluetoothUpdate | undefined {
  const sessionKey = fromBase64url(value.sessionKey);
  if (sessionKey?.length !== BLUETOOTH_UPDATE.sessionKeyBytes) return undefined;
  return {
    device: value.device,
    address: value.address,
    version: value.version,
    needsWake: value.needsWake,
    fileBytes: value.fileBytes,
    windowS: value.windowS,
    imageId: fromHex(value.imageId),
    sha256: fromHex(value.sha256),
    sessionKey,
    expiresAtMs: clock.now() + value.expiresInMs,
  };
}

/** Tracks the board's deadline from actual progress across dropped connections. */
export function updateTransfer(central: BleCentral, clock: RadioClock, update: BluetoothUpdate) {
  let highest = 0;
  let lastProgress: number | undefined;
  const name = bluetoothUpdateName(update.address);
  const scanWindow = update.windowS * 1000;
  return {
    /** Returns the absolute limit of the current resume opportunity. */
    resumeUntil: () => Math.min(update.expiresAtMs, (lastProgress ?? clock.now()) + NO_PROGRESS_MS),
    /** Finds the address in the grant, opens the GATT link and serves the file. */
    async run(
      file: ImageReader,
      signal: AbortSignal,
      waitMs: number,
      connected: () => void,
      progress: (offset: number) => void,
    ) {
      const end = Math.min(
        update.expiresAtMs,
        lastProgress === undefined
          ? clock.now() + scanWindow + waitMs
          : lastProgress + NO_PROGRESS_MS,
      );
      if (clock.now() >= end)
        return {
          kind: "failed",
          fault: clock.now() >= update.expiresAtMs ? "expired" : "windowEnded",
        } as const;
      const found = await discover(
        central,
        clock,
        BLUETOOTH_UPDATE.serviceUuid,
        (advert) => advert.name === name,
        end - clock.now(),
        signal,
      );
      if (!found.ok) return { kind: "failed", fault: found.fault } as const;
      const advert = found.value[0];
      if (advert === undefined || isAborted(signal))
        return { kind: "failed", fault: "lost" } as const;
      const link = await central.connect(advert.id, BLUETOOTH_UPDATE.requestedMtu);
      if (!link.ok) return { kind: "failed", fault: link.fault } as const;
      if (isAborted(signal) || clock.now() >= end) {
        link.value.close();
        return { kind: "failed", fault: isAborted(signal) ? "lost" : "windowEnded" } as const;
      }
      if (link.value.mtu < MIN_UPDATE_MTU) {
        link.value.close();
        return { kind: "failed", fault: "smallMtu" } as const;
      }
      lastProgress ??= clock.now();
      connected();
      const result = await serveImage(
        link.value,
        update,
        file,
        (offset) => {
          // The board may have resumed from an earlier checkpoint and be making real progress.
          lastProgress = clock.now();
          if (offset <= highest) return;
          highest = offset;
          progress(offset);
        },
        clock,
        signal,
        lastProgress + NO_PROGRESS_MS,
      );
      if (!result.ok) return { kind: "failed", fault: result.fault } as const;
      return { kind: "done", ...result.value } as const;
    },
  };
}
