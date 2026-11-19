/** Downloads a firmware image into the session cache and validates the whole file. */
import {
  FILE_CHUNKS,
  type AppEvent,
  type AppOpBodyV2,
  type BluetoothSessionObject,
} from "@hsn/protocol/app";
import { sha256, toHex } from "../hub/digest";
import { fromBase64url } from "../hub/files";
import type { Outcome } from "../platform/split";
import { phoneRequest, type PhoneHub } from "./hub";
import type { ImageReader } from "./firmware-server";
import type { RadioClock } from "./radio";

export interface ImageCache extends ImageReader {
  append(bytes: Uint8Array): boolean;
  remove(): void;
}

/** Compares a new stream's prefix with the bytes already saved before appending. */
function appendFrom(cache: ImageCache, offset: number, data: Uint8Array): boolean {
  const retained = Math.min(data.length, cache.size - offset);
  if (retained < 0) return false;
  if (retained > 0) {
    const previous = cache.read(offset, retained);
    if (previous?.length !== retained || previous.some((byte, index) => byte !== data[index]))
      return false;
  }
  return retained === data.length || cache.append(data.subarray(retained));
}

/** Reissues the hub's stream on retry, verifies its already-cached prefix and appends missing chunks. */
export function downloadImage(
  hub: PhoneHub,
  update: Pick<BluetoothSessionObject, "imageId" | "fileBytes" | "sha256">,
  image: AppOpBodyV2<"firmware.download">["image"],
  cache: ImageCache,
  clock: RadioClock,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<Outcome<void, "interrupted" | "corrupt" | "cancelled">> {
  return new Promise((resolve) => {
    let job: number | undefined;
    let early: AppEvent[] = [];
    let complete = false;
    let chunk = 0;
    let offset = 0;
    let settled = false;
    let timeout: () => void = () => undefined;
    let stop: () => void = () => undefined;

    /** Stops listening as soon as the session, stream or validation ends. */
    function finish(fault?: "interrupted" | "corrupt" | "cancelled") {
      if (settled) return;
      settled = true;
      stop();
      timeout();
      early = [];
      signal.removeEventListener("abort", cancel);
      resolve(fault === undefined ? { ok: true, value: undefined } : { ok: false, fault });
    }
    /** Ends the receiver without reading any more file bytes. */
    const cancel = () => {
      finish("cancelled");
    };

    /** Checks both the grant's digest and the terminating chunk's digest. */
    function verify(expected: string) {
      complete = true;
      const saved = cache.read(0, update.fileBytes);
      if (saved?.length !== update.fileBytes) {
        finish("corrupt");
        return;
      }
      // Protocol image header: the signed payload hash occupies bytes 16 to 47.
      if (toHex(saved.subarray(16, 48)) !== update.sha256) {
        finish("corrupt");
        return;
      }
      void Promise.all([sha256(saved), sha256(saved.subarray(128))]).then(
        ([fileHash, payloadHash]) => {
          finish(
            toHex(fileHash) === expected && toHex(payloadHash) === update.sha256
              ? undefined
              : "corrupt",
          );
        },
        () => {
          finish("corrupt");
        },
      );
    }

    /** Applies only this download's events after the hub identifies its job. */
    function receive(event: AppEvent) {
      if (settled || complete || (event.ev !== "fileFailed" && event.ev !== "fileChunk")) return;
      if (job === undefined) {
        if (early.length >= Math.ceil(update.fileBytes / FILE_CHUNKS.maxChunkBytes) + 2)
          finish("corrupt");
        else early.push(event);
        return;
      }
      if (event.body.job !== job) return;
      if (event.ev === "fileFailed") {
        finish("interrupted");
        return;
      }
      const body = event.body;
      if (body.n !== chunk) {
        finish("interrupted");
        return;
      }
      const data = fromBase64url(body.data);
      if (
        data === undefined ||
        data.length > FILE_CHUNKS.maxChunkBytes ||
        offset + data.length > update.fileBytes ||
        !appendFrom(cache, offset, data)
      ) {
        finish("corrupt");
        return;
      }
      chunk += 1;
      offset += data.length;
      progress(cache.size);
      timeout();
      timeout = clock.after(15_000, () => {
        finish("interrupted");
      });
      if (body.end === undefined) return;
      if (body.end.chunks !== chunk || offset !== update.fileBytes) {
        finish("corrupt");
        return;
      }
      verify(body.end.sha256);
    }

    if (signal.aborted) {
      cancel();
      return;
    }
    signal.addEventListener("abort", cancel, { once: true });
    stop = hub.client.onEvent(receive);
    timeout = clock.after(15_000, () => {
      finish("interrupted");
    });
    void phoneRequest(hub, "firmware.download", { image }).then((reply) => {
      if (settled) return;
      if (!reply.ok) {
        finish("interrupted");
        return;
      }
      job = reply.value.job;
      const pending = early;
      early = [];
      pending.forEach(receive);
    });
  });
}
