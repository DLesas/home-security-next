/**
 * The pair page's sequencing decisions, as plain functions the page calls (`pair-page.tsx`), so
 * each rule is tested without rendering: the failure each fault shows, what going to the
 * background does on each page, and where "Try again" leads after each failure.
 */
import type { DeviceObject } from "@hsn/protocol/app";
import type { PairFault } from "../platform/ble";

/** The pair page's steps (m3-design.md section 5, "The flow on the phone"). */
export type PairPageName =
  | "choose"
  | "open"
  | "permission"
  | "find"
  | "chooseBoard"
  | "found"
  | "scan"
  | "type"
  | "checking"
  | "name"
  | "adding"
  | "waiting"
  | "done"
  | "failure";

/** The failure the page shows for each fault of the search and of checking the code. */
export const searchFault = {
  timeout: "anotherPhone",
  notFound: "noBoard",
  lost: "vanished",
  failed: "radioFailed",
  off: "off",
  unauthorized: "unauthorized",
  protocol: "protocol",
  wrongCode: "wrongCode",
  tooManyTries: "tooManyTries",
} as const satisfies Record<PairFault, string>;

/** What a trip to the background does: nothing, an interrupted pairing, or an unfinished one. */
export type PairBackground = "none" | "interrupted" | "unfinished";

/**
 * Decides what going to the background does on `page`. Only a page with a Bluetooth link or an
 * exchange with the board in flight is interrupted: the search with its probes (`find`), the
 * session being opened (`checking`) and the open session held while the person names the board
 * (`name`). `adding` is unfinished, as the hub may hold a provisioning row. Every other page has
 * nothing in flight: the scan page may send the person to Settings for the camera, and on
 * `waiting` the hub has added the device already.
 */
export function pairBackground(page: PairPageName): PairBackground {
  switch (page) {
    case "find":
    case "checking":
    case "name":
      return "interrupted";
    case "adding":
      return "unfinished";
    default:
      return "none";
  }
}

/** Where "Try again" leads, and the board whose wrong codes the phone forgets first. */
export interface PairRetry {
  readonly page: "type" | "find" | "permission" | "open";
  /** The chip whose count restarts: the person is told to hold the board's button again. */
  readonly reopen: string | undefined;
}

/**
 * Decides the failure page's "Try again" for `reason`, with `chip` the board last chosen. A wrong
 * code goes back to the code; Bluetooth off or blocked to its page. After five wrong codes the
 * person says the light shows again, and the search runs. Every other failure goes to "Open
 * pairing on the device", which tells the person to hold the button for 5 seconds: that hold opens
 * a new window on the board with five tries, so the phone forgets the old window's count too.
 */
export function retryAfter(reason: string, chip: string | undefined): PairRetry {
  if (reason === "wrongCode" && chip !== undefined) return { page: "type", reopen: undefined };
  if (reason === "tooManyTries" && chip !== undefined) return { page: "find", reopen: chip };
  if (reason === "off" || reason === "unauthorized")
    return { page: "permission", reopen: undefined };
  return { page: "open", reopen: chip };
}

/** Chooses whether the completed pairing still needs its first contact. */
export function showsNoContact(
  timedOut: boolean,
  state: DeviceObject["state"] | undefined,
): boolean {
  return timedOut && state !== "contacted";
}
