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

/** Estimates the seconds remaining from the transfer's progress so far. */
export function updateSecondsLeft(
  total: number,
  first: { offset: number; at: number },
  current: { offset: number; at: number },
): number | undefined {
  const remaining = total - current.offset;
  const elapsed = current.at - first.at;
  const sent = current.offset - first.offset;
  if (remaining <= 0 || sent <= 0 || elapsed <= 1000) return undefined;
  return Math.ceil((remaining * elapsed) / sent / 1000);
}

/**
 * Tracks the board's deadline across dropped connections. The sensor applies its 30 s rule only
 * once a phone has opened the session (update_session.cpp, `poll_session`); before that it
 * advertises until its window ends. So the no-progress deadline runs from the first Data the
 * board asked for (it accepted Open), and until then a reconnection may run to the end of the
 * window the first attempt allowed, within the grant's expiry.
 */
export function updateTransfer(central: BleCentral, clock: RadioClock, update: BluetoothUpdate) {
  let highest = 0;
  let lastProgress: number | undefined;
  let windowEnd: number | undefined;
  const name = bluetoothUpdateName(update.address);
  const scanWindow = update.windowS * 1000;
  return {
    /** Returns the absolute limit of the current resume opportunity. */
    resumeUntil: () =>
      Math.min(
        update.expiresAtMs,
        lastProgress === undefined
          ? (windowEnd ?? clock.now() + scanWindow)
          : lastProgress + NO_PROGRESS_MS,
      ),
    /** Serves one GATT link, reporting both the overall and the connection’s high-water marks. */
    async run(
      file: ImageReader,
      signal: AbortSignal,
      waitMs: number,
      connected: () => void,
      progress: (highestOffset: number, connectionOffset: number) => void,
    ) {
      windowEnd ??= clock.now() + scanWindow + waitMs;
      const end = Math.min(
        update.expiresAtMs,
        lastProgress === undefined ? windowEnd : lastProgress + NO_PROGRESS_MS,
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
      // Within this connection the board waits 30 s for an Open, as it waits for progress after.
      const connectedAt = clock.now();
      connected();
      const result = await serveImage(
        link.value,
        update,
        file,
        (offset) => {
          // The board may have resumed from an earlier checkpoint and be making real progress.
          lastProgress = clock.now();
          highest = Math.max(highest, offset);
          progress(highest, offset);
        },
        clock,
        signal,
        (lastProgress ?? connectedAt) + NO_PROGRESS_MS,
      );
      if (!result.ok) return { kind: "failed", fault: result.fault } as const;
      return { kind: "done", ...result.value } as const;
    },
  };
}
