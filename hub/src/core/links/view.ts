/**
 * Read-only selectors over the links module's slice that other modules may use (hub-design.md
 * section 2, module 3): the link table and the device directory frames are sorted by. Also the
 * one builder of a `rejected` message, which every module that counts a rejected frame uses
 * (section 10, "How every rejection and error reaches the audit record").
 */
import type { RejectReason } from "../model/errors.ts";
import type { LinkKind } from "../model/events.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { Internal, RejectSource } from "../model/messages.ts";
import type { HubState } from "../model/state.ts";
import type { DirectoryEntry, LinkCarrier } from "./state.ts";

/** The directory's and the link table's entries, for the selectors' callers. */
export type { DirectoryEntry, LinkCarrier } from "./state.ts";

/** A rejected frame keeps its first 16 bytes (`rejects.sample`, section 6). */
export const REJECT_SAMPLE_BYTES = 16;

/** The `rejected` message for a frame or packet (HB15): its first 16 bytes as the sample. */
export function rejection(
  source: RejectSource,
  reason: RejectReason,
  bytes: Uint8Array,
  address: number | undefined,
): Internal {
  return {
    kind: "rejected",
    source,
    reason,
    address,
    sample: bytes.slice(0, REJECT_SAMPLE_BYTES),
    copy: undefined,
  };
}

/** The device with this address, if the hub knows one (section 8, "Accepting a device packet"). */
export function deviceAtAddress(view: HubState, address: number): DirectoryEntry | undefined {
  return view.links.byAddress.get(address);
}

/** A known device's address and role. */
export function directoryEntry(view: HubState, device: DeviceId): DirectoryEntry | undefined {
  return view.links.byDevice.get(device);
}

/** An open link's kind, or undefined for a link that is not open. */
export function linkKind(view: HubState, link: LinkId): LinkKind | undefined {
  return view.links.open.get(link)?.kind;
}

/**
 * A link's label, open or recently closed, for `rejects.via` (section 6): a serial port's path
 * or a WebSocket's peer address.
 */
export function linkLabel(view: HubState, link: LinkId): string | undefined {
  return (
    view.links.open.get(link)?.label ?? view.links.closed.findLast((c) => c.link === link)?.label
  );
}

/** What an open link carries (section 7, "Gateway connection"). */
export function linkCarrier(view: HubState, link: LinkId): LinkCarrier | undefined {
  return view.links.open.get(link)?.carrier;
}

/** Every open link, in the order they opened, for `hsn status` and `hsn usb list`. */
export function openLinks(
  view: HubState,
): readonly { readonly link: LinkId; readonly kind: LinkKind; readonly label: string }[] {
  return [...view.links.open.values()].map(({ link, kind, label }) => ({ link, kind, label }));
}
