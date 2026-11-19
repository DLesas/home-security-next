/**
 * The update page's sequencing decisions, as plain functions the page calls (`update-page.tsx`),
 * so each rule is tested without rendering: what ends the grant's life in memory, when going to
 * the background ends the update, whether a resume may still start, and whether a failed attempt
 * offers "Carry on".
 */
import type { BluetoothSessionObject } from "@hsn/protocol/app";
import type { BluetoothUpdate } from "../platform/ble";
import type { ImageCache } from "./download";
import type { updateTransfer } from "./update-flow";

/** One update the page holds: the grant, the file being kept for it, and its cancellation. */
export interface ActiveUpdate {
  readonly offer: Pick<BluetoothSessionObject, "imageId" | "fileBytes" | "sha256">;
  readonly image: number;
  readonly grant: BluetoothUpdate;
  cache: ImageCache;
  readonly transfer: ReturnType<typeof updateTransfer>;
  readonly abort: AbortController;
  readonly stopExpiry: () => void;
}

/**
 * Ends an update's life in memory (m3-design.md section 7, step 9): its expiry timer stops, its
 * link and requests are cancelled, the session key is zeroed and the cached file deleted.
 */
export function releaseUpdate(running: ActiveUpdate): void {
  running.stopExpiry();
  running.abort.abort();
  running.grant.sessionKey.fill(0);
  running.cache.remove();
}

/** Decides whether going to the background ends the update: only while a grant is asked or held. */
export function backgroundEnds(holding: boolean): boolean {
  return holding;
}

/** Decides whether "Carry on" may still start: only before the resume deadline. */
export function mayResume(now: number, deadline: number): boolean {
  return now < deadline;
}

/** The faults after which the sensor may still be reached again in its window. */
const RESUMABLE: readonly string[] = ["lost", "timeout", "off", "notFound"];

/**
 * Decides what a failed attempt leads to: "Carry on" when the fault is a drop or a radio that may
 * come back, the deadline has not passed, and the phone had reached the sensor (this attempt was a
 * resume, or an earlier one connected); otherwise the failure page.
 */
export function afterFailedSend(
  fault: string,
  now: number,
  deadline: number,
  resuming: boolean,
  connectedBefore: boolean,
): "resume" | "fail" {
  return RESUMABLE.includes(fault) && mayResume(now, deadline) && (resuming || connectedBefore)
    ? "resume"
    : "fail";
}
