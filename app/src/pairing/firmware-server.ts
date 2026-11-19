/** Answers only the sensor's update requests. Each GATT connection must authenticate anew. */
import { toHex } from "@hsn/protocol/messages";
import {
  BLUETOOTH_UPDATE,
  bluetoothMaxData,
  bluetoothOpenTag,
  decodeTransferFrame,
  encodeTransferFrame,
  GoneReason,
  type TransferFrameToSend,
  TransferKind,
  TransferResult,
} from "@hsn/protocol/update";
import type { BluetoothUpdate, FirmwareServer, GattLink, UpdateFault } from "../platform/ble";
import type { Outcome } from "../platform/split";
import { radioClock, type RadioClock } from "./radio";

export const MIN_UPDATE_MTU = 185;
export const NO_PROGRESS_MS = BLUETOOTH_UPDATE.idleStopMs;

export interface ImageReader {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | undefined;
}

type Result = Outcome<{ readonly verified: boolean; readonly reason: number }, UpdateFault>;

/** Serves one authenticated link and releases its notifications and timers on every outcome. */
export function serveImage(
  link: GattLink,
  update: BluetoothUpdate,
  file: ImageReader,
  served: (highest: number) => void,
  clock: RadioClock,
  signal: AbortSignal,
  progressUntil: number,
): Promise<Result> {
  return new Promise((resolve) => {
    let open = false;
    let ended = false;
    let highest = 0;
    let stop: () => void = () => undefined;
    let timer: () => void = () => undefined;
    let deadline = progressUntil;
    const id = toHex(update.imageId);
    const max = bluetoothMaxData(link.mtu);
    let maxData = max;
    let queue = Promise.resolve();

    /** Releases this transfer before notifying its caller. */
    function finish(result: Result) {
      if (ended) return;
      ended = true;
      timer();
      signal.removeEventListener("abort", cancel);
      stop();
      link.close();
      resolve(result);
    }
    /** Finishes with the typed reason for a failed transfer. */
    function fail(fault: UpdateFault) {
      finish({ ok: false, fault });
    }
    /** Cancels the connection with its owning flow. */
    const cancel = () => {
      fail("lost");
    };

    /** Schedules the earlier of the hub's expiry and the board's no-progress deadline. */
    function armTimer() {
      timer();
      const end = Math.min(update.expiresAtMs, deadline);
      timer = clock.after(Math.max(0, end - clock.now()), () => {
        fail(update.expiresAtMs <= clock.now() ? "expired" : "windowEnded");
      });
    }

    /** Encodes and writes exactly one frame without response. */
    async function send(frame: TransferFrameToSend): Promise<boolean> {
      const encoded = encodeTransferFrame(frame);
      if (!encoded.ok) {
        fail("protocol");
        return false;
      }
      const written = await link.write(BLUETOOTH_UPDATE.rxUuid, encoded.value, false);
      if (!written.ok) fail(written.fault);
      return written.ok && !ended;
    }

    /** Serializes notifications, file seeks and writes even when the sensor pipelines Gets. */
    async function receive(bytes: Uint8Array) {
      if (ended) return;
      const decoded = decodeTransferFrame(bytes);
      if (!decoded.ok) return;
      const frame = decoded.value;
      if (frame.kind === TransferKind.Hello) {
        if (open) return;
        if (
          frame.address !== update.address ||
          toHex(frame.imageId) !== id ||
          frame.bytesHeld > file.size
        ) {
          fail("protocol");
          return;
        }
        const tag = bluetoothOpenTag(
          update.sessionKey,
          frame.address,
          frame.deviceRandom,
          frame.imageId,
        );
        if (!tag.ok) {
          fail("wrongTag");
          return;
        }
        maxData = Math.min(max, frame.largestData);
        open = await send({ kind: TransferKind.Open, tag: tag.value });
        return;
      }
      if (!open || !("imageId" in frame) || toHex(frame.imageId) !== id) return;
      if (frame.kind === TransferKind.Get) {
        const { offset, length, imageId } = frame;
        if (offset + length > file.size || length > maxData || length < 1) {
          await send({ kind: TransferKind.Gone, imageId, reason: GoneReason.OutOfRange });
          return;
        }
        const data = file.read(offset, length);
        if (data?.length !== length) {
          await send({ kind: TransferKind.Gone, imageId, reason: GoneReason.NotAvailable });
          fail("failed");
          return;
        }
        if (!(await send({ kind: TransferKind.Data, imageId, offset, data }))) return;
        if (offset + length > highest) {
          highest = offset + length;
          deadline = clock.now() + NO_PROGRESS_MS;
          armTimer();
          served(highest);
        }
      } else if (frame.kind === TransferKind.Done) {
        finish({
          ok: true,
          value: { verified: frame.result === TransferResult.Verified, reason: frame.reason },
        });
      }
    }

    if (signal.aborted) {
      cancel();
      return;
    }
    if (clock.now() >= update.expiresAtMs) {
      fail("expired");
      return;
    }
    if (clock.now() >= deadline) {
      fail("windowEnded");
      return;
    }
    if (link.mtu < MIN_UPDATE_MTU || file.size !== update.fileBytes) {
      fail("protocol");
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    armTimer();
    link.onClosed((why) => {
      // The board can drop the link immediately after notifying Done.
      void queue.then(() => {
        fail(why ?? "lost");
      });
    });
    stop = link.watch(BLUETOOTH_UPDATE.txUuid, (bytes) => {
      queue = queue.then(() => receive(bytes));
    });
  });
}

export const firmwareServer: FirmwareServer = {
  /** Runs the same frame handling over an in-memory source for the frozen server interface. */
  serve(link, update, file, served) {
    return serveImage(
      link,
      update,
      { size: file.length, read: (offset, length) => file.subarray(offset, offset + length) },
      served,
      radioClock,
      new AbortController().signal,
      radioClock.now() + NO_PROGRESS_MS,
    );
  },
};
