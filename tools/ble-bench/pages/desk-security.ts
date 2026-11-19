/**
 * The desk page's one join point with pairing's security layer. A real board speaks protocomm
 * security 2 only, so the page must open the session with P3's client (`OpenSetupSession` over a
 * `GattLink`, in `@hsn/protocol/pairing`); until P3 hands it in, this opener refuses cleanly and
 * the page says so after reading `proto-ver`. Joining it is this file alone: export P3's opener as
 * `openDeskSession`. The bench's stand-in is never used here: a real board would refuse it.
 */
import type { OpenSetupSession } from "../../../app/src/platform/ble.ts";
import { fault } from "../src/outcome.ts";

/** True once P3's security 2 client is joined here. */
export function security2Joined(): boolean {
  return false;
}

export const openDeskSession: OpenSetupSession = () => Promise.resolve(fault("protocol"));
