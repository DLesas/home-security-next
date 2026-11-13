/**
 * Read-only selectors over the setup module's slice that other modules may use (hub-design.md
 * section 2), and what an Identity means (section 9; protocol.md §10), which the registry reads
 * from the same setup frame before setup does.
 */
import { decodeSetupMessage, SetupType } from "@hsn/protocol";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import { sameBytes } from "../registry/view.ts";
import type { Identity, UsbBoard } from "./state.ts";

export type { Identity, UsbBoard } from "./state.ts";

/** Every open USB link, in the order they opened. */
export function usbBoards(view: HubState): readonly UsbBoard[] {
  return [...view.setup.boards.values()].toSorted((a, b) => a.link - b.link);
}

/** The open USB link whose port path is `label`, as `hsn usb add <port>` names it. */
export function boardByLabel(view: HubState, label: string): UsbBoard | undefined {
  return usbBoards(view).find((board) => board.label === label);
}

/**
 * The Identity of the board being provisioned as `device`, for the registry's new row: its
 * chip, firmware and build (section 6, `devices`).
 */
export function provisionedIdentity(view: HubState, device: DeviceId): Identity | undefined {
  for (const board of view.setup.boards.values()) {
    if (board.exchange?.kind === "provision" && board.exchange.device === device) {
      return board.identity;
    }
  }
  return undefined;
}

/** The Identity a setup frame carries, if `message` is one with a valid Identity (§10). */
export function identityIn(
  message: Internal,
): { readonly link: LinkId; readonly identity: Identity } | undefined {
  if (message.kind !== "setupFrame") return undefined;
  const decoded = decodeSetupMessage(message.bytes);
  if (!decoded.ok || decoded.value.type !== SetupType.Identity) return undefined;
  return { link: message.link, identity: decoded.value };
}

/** What an Identity says about whom the board belongs to (§10, section 9). */
export type Belonging =
  /** No pairing stored: a new or factory-reset board. */
  | "unpaired"
  /** Paired to this hub: its hub identity is ours. */
  | "ours"
  /** Paired to another hub. */
  | "elsewhere";

/**
 * Whom the board belongs to. In an Identity whose "paired" byte is 0 the hub identity bytes mean
 * nothing (§10), so they are not read. With no hub identity of our own yet, a paired board is
 * another hub's.
 */
export function belonging(identity: Identity, hubIdentity: Uint8Array | undefined): Belonging {
  if (!identity.paired) return "unpaired";
  return hubIdentity !== undefined && sameBytes(identity.hubIdentity, hubIdentity)
    ? "ours"
    : "elsewhere";
}
