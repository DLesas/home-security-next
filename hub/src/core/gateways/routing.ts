/**
 * Which gateway a packet goes through (hub-design.md section 8, "Which gateway a packet goes
 * through"; D97), over the gateways slice. The handler routes `radioOut` with these, and
 * `view.ts` offers the same functions to the other modules, so both always agree.
 */
import type { DeviceId } from "../model/ids.ts";
import type { RadioPurpose } from "../model/messages.ts";
import type { HubRules } from "../model/rules.ts";
import { type Mono, msBetween } from "../model/time.ts";
import type { GatewayEntry, GatewaysSlice } from "./state.ts";

/** A gateway packets can go through: a live session, and heard within the last 60 s (§7, D97). */
export function isConnected(entry: GatewayEntry): boolean {
  return entry.live !== undefined && !entry.offline;
}

/** Every connected gateway, by device id. */
export function connectedGateways(slice: GatewaysSlice): readonly GatewayEntry[] {
  return [...slice.gateways.values()].filter(isConnected).toSorted((a, b) => a.device - b.device);
}

/** The gateway, if it is connected. */
export function connectedGateway(
  slice: GatewaysSlice,
  gateway: DeviceId | undefined,
): GatewayEntry | undefined {
  const entry = gateway === undefined ? undefined : slice.gateways.get(gateway);
  return entry !== undefined && isConnected(entry) ? entry : undefined;
}

/**
 * "Any connected gateway" (section 8), other than `except`: one whose session has a clock
 * mapping first, since a latest moment can be converted only through one; then by device id.
 */
export function anyConnectedGateway(
  slice: GatewaysSlice,
  except?: DeviceId,
): GatewayEntry | undefined {
  const others = connectedGateways(slice).filter((g) => g.device !== except);
  return others.find((g) => g.live?.clock.offset !== undefined) ?? others[0];
}

/** The gateway a radio packet goes through, or why none (section 8). */
export type Route =
  | { readonly kind: "gateway"; readonly entry: GatewayEntry; readonly rerouted: boolean }
  /** A packet for a moment on a gateway that is gone: skipped, since the moment is on its clock. */
  | { readonly kind: "skipped"; readonly gateway: DeviceId | undefined }
  /** No connected gateway at all: decision `no_path`. */
  | { readonly kind: "noPath" };

/**
 * Section 8: a packet goes through `first` (the gateway that delivered the answered packet, the
 * countdown's reply gateway, or the siren's best) while it is connected. If it is not, a packet
 * timed on its clock (a heartbeat reply) is skipped; any other goes through another connected
 * gateway, `rerouted`, and with none there is no path.
 */
export function routeRadio(
  slice: GatewaysSlice,
  first: DeviceId | undefined,
  fixedMoment: boolean,
): Route {
  const chosen = connectedGateway(slice, first);
  if (chosen !== undefined) return { kind: "gateway", entry: chosen, rerouted: false };
  if (fixedMoment) return { kind: "skipped", gateway: first };
  const other = anyConnectedGateway(slice, first);
  return other === undefined
    ? { kind: "noPath" }
    : { kind: "gateway", entry: other, rerouted: first !== undefined };
}

/**
 * The gateway a siren command goes through by LoRa (section 8): the highest SNR among the
 * siren's authentic copies, duplicates included, in the last 15 minutes ‡, among open sessions;
 * on a tie the most recent. With none heard recently, any connected gateway; with none
 * connected, none (Wi-Fi only).
 */
export function bestGatewayForSiren(
  slice: GatewaysSlice,
  siren: DeviceId,
  now: Mono,
  rules: HubRules,
): DeviceId | undefined {
  let best: { readonly gateway: DeviceId; readonly snr: number; readonly at: Mono } | undefined;
  for (const copy of slice.sirenCopies.get(siren) ?? []) {
    if (msBetween(copy.at, now) > rules.sirens.bestGatewayWindowMs) continue;
    if (connectedGateway(slice, copy.gateway) === undefined) continue;
    const better =
      best === undefined ||
      copy.snrQuarterDb > best.snr ||
      (copy.snrQuarterDb === best.snr && copy.at >= best.at);
    if (better) best = { gateway: copy.gateway, snr: copy.snrQuarterDb, at: copy.at };
  }
  return best?.gateway ?? anyConnectedGateway(slice)?.device;
}

/**
 * The sensors only `gateway` heard (D97): heard by it in the hour ‡ before it was last heard,
 * and by no other gateway since that hour began. They are named when it goes offline.
 */
export function sensorsOnlyHeardBy(
  slice: GatewaysSlice,
  gateway: DeviceId,
  rules: HubRules,
): readonly DeviceId[] {
  const entry = slice.gateways.get(gateway);
  const until = entry?.lastHeardAt;
  if (until === undefined) return [];
  const window = rules.silence.heardByOtherGatewayMs;
  const sensors: DeviceId[] = [];
  for (const [sensor, byGateway] of slice.heard) {
    const at = byGateway.get(gateway);
    if (at === undefined || msBetween(at, until) > window) continue;
    const others = [...byGateway].some(
      ([other, otherAt]) => other !== gateway && msBetween(otherAt, until) <= window,
    );
    if (!others) sensors.push(sensor);
  }
  return sensors.toSorted((a, b) => a - b);
}

/**
 * Whether a sensor's own silence alert is held back (D97): an offline gateway was the only one
 * that heard it.
 */
export function silenceHeldBack(slice: GatewaysSlice, sensor: DeviceId, rules: HubRules): boolean {
  return [...slice.gateways.values()].some(
    (g) => g.offline && sensorsOnlyHeardBy(slice, g.device, rules).includes(sensor),
  );
}

/** The power a gateway's settings give a packet of this kind (section 8, "Powers"). */
export function settingsPowerDbm(entry: GatewayEntry, purpose: RadioPurpose): number {
  return purpose === "sirenCommand" || purpose === "sirenSettings"
    ? entry.config.sirenPowerDbm
    : entry.config.defaultPowerDbm;
}
