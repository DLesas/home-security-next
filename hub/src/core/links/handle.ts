/**
 * The links module's handler (hub-design.md section 2, module 3). It keeps the link table
 * (`linkOpened`, `linkClosed`, and what each link carries from `gatewayUp` and a siren's
 * accepted Wi-Fi packets) and the device directory (the boot snapshot, `deviceAdded`,
 * `deviceRemoved`), and sorts every `frame` into a setup frame, a gateway packet, a device
 * packet or a counted rejection (`sort.ts`). A text message on a WebSocket closes the socket in
 * the shell; its `linkClosed` is counted here as a `textFrame` rejection (section 3).
 */
import { ok, type Result } from "neverthrow";
import { Role } from "@hsn/protocol";
import type { CoreFault } from "../model/errors.ts";
import type { Handled, Handler } from "../model/handler.ts";
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { DeviceState } from "../model/rows.ts";
import { sortFrame } from "./sort.ts";
import {
  CLOSED_LINKS_KEPT,
  type DirectoryEntry,
  type LinkCarrier,
  type LinkEntry,
  type LinksSlice,
} from "./state.ts";
import { rejection } from "./view.ts";

/** The roles that send packets the hub sorts: sensor, siren and gateway (§6, Started). */
const DEVICE_ROLES: ReadonlySet<number> = new Set([Role.Sensor, Role.Siren, Role.Gateway]);

type Out = Result<Handled<"links">, CoreFault>;

function unchanged(slice: LinksSlice): Out {
  return ok({ slice, out: [] });
}

/** The directory with one device set, replacing any earlier entry for its id or address. */
function withDevice(slice: LinksSlice, entry: DirectoryEntry): LinksSlice {
  const removed = withoutDevice(slice, entry.device);
  const byAddress = new Map(removed.byAddress);
  const stale = byAddress.get(entry.address);
  const byDevice = new Map(removed.byDevice);
  if (stale !== undefined) byDevice.delete(stale.device);
  byAddress.set(entry.address, entry);
  byDevice.set(entry.device, entry);
  return { ...slice, byAddress, byDevice };
}

function withoutDevice(slice: LinksSlice, device: DeviceId): LinksSlice {
  const entry = slice.byDevice.get(device);
  if (entry === undefined) return slice;
  const byAddress = new Map(slice.byAddress);
  const byDevice = new Map(slice.byDevice);
  byAddress.delete(entry.address);
  byDevice.delete(device);
  return { ...slice, byAddress, byDevice };
}

/** Every link carrying `carrier`'s device is set to `carrier`'s link only (one link per device). */
function withCarrier(slice: LinksSlice, link: LinkId, carrier: LinkCarrier): LinksSlice {
  if (carrier.kind === "unknown") return slice;
  const open = new Map<LinkId, LinkEntry>();
  for (const [id, entry] of slice.open) {
    const sameDevice =
      entry.carrier.kind === carrier.kind && entry.carrier.device === carrier.device;
    if (id === link) open.set(id, { ...entry, carrier });
    else if (sameDevice && carrier.kind === "gateway") {
      open.set(id, { ...entry, carrier: { kind: "unknown" } });
    } else open.set(id, entry);
  }
  return { ...slice, open };
}

/** The handler of module 3 (section 2). */
export const handleLinks: Handler<"links"> = (slice, message, ctx): Out => {
  switch (message.kind) {
    case "boot": {
      let next: LinksSlice = { ...slice, byAddress: new Map(), byDevice: new Map() };
      for (const row of message.snapshot.devices) {
        if (row.state === DeviceState.Removed || !DEVICE_ROLES.has(row.role)) continue;
        next = withDevice(next, { device: row.id, address: row.address, role: row.role });
      }
      return ok({ slice: next, out: [] });
    }
    case "deviceAdded":
      if (!DEVICE_ROLES.has(message.role)) return unchanged(slice);
      return ok({
        slice: withDevice(slice, {
          device: message.device,
          address: message.address,
          role: message.role,
        }),
        out: [],
      });
    case "deviceRemoved":
      return ok({ slice: withoutDevice(slice, message.device), out: [] });
    case "linkOpened": {
      const open = new Map(slice.open);
      open.set(message.link, {
        link: message.link,
        kind: message.linkKind,
        label: message.label,
        openedAt: ctx.now.mono,
        carrier: { kind: "unknown" },
      });
      return ok({ slice: { ...slice, open }, out: [] });
    }
    case "linkClosed": {
      const entry = slice.open.get(message.link);
      const out: Internal[] =
        message.reason === "textMessage"
          ? [rejection({ link: message.link }, "textFrame", new Uint8Array(0), undefined)]
          : [];
      if (entry === undefined) return ok({ slice, out });
      const open = new Map(slice.open);
      open.delete(message.link);
      const closed = [...slice.closed, { link: entry.link, kind: entry.kind, label: entry.label }];
      return ok({
        slice: { ...slice, open, closed: closed.slice(-CLOSED_LINKS_KEPT) },
        out,
      });
    }
    case "frame":
      return ok({
        slice,
        out: [sortFrame(slice, slice.open.get(message.link), message.link, message.bytes)],
      });
    case "inputRejected": {
      // A USB frame the shell could not decode is a rejection like any other (section 10).
      const { rejection: what } = message;
      if (what.source !== "frame") return unchanged(slice);
      return ok({
        slice,
        out: [rejection({ link: what.link }, what.reason, new Uint8Array(0), undefined)],
      });
    }
    case "gatewayUp":
      return ok({
        slice: withCarrier(slice, message.link, { kind: "gateway", device: message.gateway }),
        out: [],
      });
    case "accepted":
      if (message.role !== Role.Siren || message.arrival.path !== "wifi") return unchanged(slice);
      if (!slice.open.has(message.arrival.link)) return unchanged(slice);
      return ok({
        slice: withCarrier(slice, message.arrival.link, { kind: "siren", device: message.device }),
        out: [],
      });
    default:
      return unchanged(slice);
  }
};
