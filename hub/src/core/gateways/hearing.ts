/**
 * Which gateways heard which devices (hub-design.md section 8, "Which gateway a packet goes
 * through" and "Silence"; D97), from the intake module's verdicts on the device packets this
 * module unwrapped: an `accepted` packet that came through a gateway, and a copy refused as a
 * `duplicate`, which for a siren still counts towards the best gateway; the rejection carries
 * the copy's gateway and signal.
 */
import { Role } from "@hsn/protocol";
import type { DeviceId } from "../model/ids.ts";
import type { DomainMessage } from "../model/messages.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, msBetween } from "../model/time.ts";
import type { HubState } from "../model/state.ts";
import { directoryEntry } from "../links/view.ts";
import { SIREN_COPIES_KEPT } from "./constants.ts";
import type { GatewaysSlice } from "./state.ts";

type Accepted = Extract<DomainMessage, { readonly kind: "accepted" }>;
type Rejected = Extract<DomainMessage, { readonly kind: "rejected" }>;

/** The slice after `gateway` delivered an authentic copy of `device`'s packet at `at`. */
function heardBy(
  slice: GatewaysSlice,
  device: DeviceId,
  role: number,
  gateway: DeviceId,
  snrQuarterDb: number | undefined,
  at: Mono,
  rules: HubRules,
): GatewaysSlice {
  if (role === Role.Sensor) {
    const heard = new Map(slice.heard);
    const byGateway = new Map(heard.get(device));
    byGateway.set(gateway, at);
    heard.set(device, byGateway);
    return { ...slice, heard };
  }
  if (role !== Role.Siren || snrQuarterDb === undefined) return slice;
  const window = rules.sirens.bestGatewayWindowMs;
  const copies = [
    ...(slice.sirenCopies.get(device) ?? []).filter((c) => msBetween(c.at, at) <= window),
    { gateway, at, snrQuarterDb },
  ].slice(-SIREN_COPIES_KEPT);
  const sirenCopies = new Map(slice.sirenCopies);
  sirenCopies.set(device, copies);
  return { ...slice, sirenCopies };
}

/** An accepted device packet: through a gateway, it was heard by that gateway. */
export function onAccepted(
  slice: GatewaysSlice,
  message: Accepted,
  now: Mono,
  rules: HubRules,
): GatewaysSlice {
  const { arrival } = message;
  if (arrival.path !== "lora" || !slice.gateways.has(arrival.gateway)) return slice;
  return heardBy(
    slice,
    message.device,
    message.role,
    arrival.gateway,
    arrival.snrQuarterDb,
    now,
    rules,
  );
}

/** A copy refused as a duplicate by a gateway this module knows, with its signal (section 8). */
export function onDuplicate(
  slice: GatewaysSlice,
  message: Rejected,
  view: HubState,
  now: Mono,
  rules: HubRules,
): GatewaysSlice {
  const copy = message.copy;
  if (message.reason !== "duplicate" || copy === undefined) return slice;
  if (!slice.gateways.has(copy.gateway)) return slice;
  const device = directoryEntry(view, copy.device);
  if (device === undefined) return slice;
  return heardBy(slice, copy.device, device.role, copy.gateway, copy.snrQuarterDb, now, rules);
}
