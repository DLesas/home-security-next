/**
 * The sorting of frames (hub-design.md section 2, module 3; section 8, "Accepting a device
 * packet"; section 10). The shell knows nothing of the protocol, so the links module decides
 * what each frame is, reading only the clear header (§3, "Order of checks"):
 *
 * - a USB frame that starts 0xF1 is a setup frame (§10);
 * - a frame that starts 0xF2 is a firmware transfer frame that no grant covered, since the shell
 *   serves those it granted itself (D137, R3): counted as `transferNotGranted` and nothing more
 *   (m3-updates-design section 4, `links`);
 * - a packet from a gateway's address is a gateway packet;
 * - a packet from a siren's address on a network link is a device packet (§5, "Paths"), and so is
 *   a sensor's, on the Wi-Fi it joins only for its update (§10; intake refuses on that path every
 *   type but those a sensor sends there);
 * - anything else is a counted rejection: a bad header by the protocol's error code, a packet
 *   from the hub's own direction as `wrongDirection`, an address the hub does not know as
 *   `unknownAddress` (with no AES spent), and any other device on a link as `wrongPath`.
 */
import { Direction, MaxPacketLength, readPacketHeader, Role, SETUP_MARKER } from "@hsn/protocol";

/**
 * The first byte of a firmware transfer frame (§10, D137): `TRANSFER_PREFIX` of
 * `@hsn/protocol/update`, which the core may not import (section 1); a test holds the two equal.
 */
export const TRANSFER_MARKER = 0xf2;
import type { Internal } from "../model/messages.ts";
import type { LinkId } from "../model/ids.ts";
import type { LinkEntry, LinksSlice } from "./state.ts";
import { rejection } from "./view.ts";

/** What one frame becomes: exactly one message, a forwarding or a rejection. */
export function sortFrame(
  slice: LinksSlice,
  entry: LinkEntry | undefined,
  link: LinkId,
  bytes: Uint8Array,
): Internal {
  if (entry === undefined) {
    // A frame on a link the core never saw open: nothing can be believed about its path.
    return rejection({ link }, "wrongPath", bytes, undefined);
  }
  if (entry.kind === "usb" && bytes[0] === SETUP_MARKER) {
    return { kind: "setupFrame", link, bytes };
  }
  if (bytes[0] === TRANSFER_MARKER)
    return rejection({ link }, "transferNotGranted", bytes, undefined);
  const header = readPacketHeader(bytes, MaxPacketLength.Link);
  if (!header.ok) return rejection({ link }, header.error.code, bytes, undefined);
  const { address, direction } = header.value;
  if (direction !== Direction.ToHub) return rejection({ link }, "wrongDirection", bytes, address);
  const device = slice.byAddress.get(address);
  if (device === undefined) return rejection({ link }, "unknownAddress", bytes, address);
  if (device.role === Role.Gateway) return { kind: "gatewayPacket", link, bytes };
  if ((device.role === Role.Siren || device.role === Role.Sensor) && entry.kind === "network") {
    return { kind: "devicePacket", bytes, arrival: { path: "wifi", link } };
  }
  return rejection({ link }, "wrongPath", bytes, address);
}
