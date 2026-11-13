/**
 * Read-only selectors over the gateways module's slice that other modules may use (hub-design.md
 * section 2, module 6): which gateway a packet goes through (section 8), the power its settings
 * give it, its clock, the sensors whose silence a silent gateway holds back (D97), and what
 * `hsn status` shows of each gateway (section 9). The handler routes `radioOut` through the same
 * functions (`routing.ts`), so a module that asks here gets the gateway its packet will take.
 */
import type { DeviceId, LinkId } from "../model/ids.ts";
import type { RadioPurpose } from "../model/messages.ts";
import type { HubRules } from "../model/rules.ts";
import type { HubState } from "../model/state.ts";
import type { Mono } from "../model/time.ts";
import { toGateway, toHub } from "./clock.ts";
import type { GatewayConfig } from "./state.ts";
import {
  bestGatewayForSiren as bestForSiren,
  connectedGateway,
  connectedGateways as connected,
  routeRadio,
  sensorsOnlyHeardBy as onlyHeardBy,
  settingsPowerDbm,
  silenceHeldBack,
} from "./routing.ts";

/** Every gateway packets can go through now: a live session, not silent; by device id. */
export function connectedGateways(view: HubState): readonly DeviceId[] {
  return connected(view.gateways).map((g) => g.device);
}

/** Whether packets can go through this gateway now. */
export function isGatewayConnected(view: HubState, gateway: DeviceId): boolean {
  return connectedGateway(view.gateways, gateway) !== undefined;
}

/** The link of a gateway's live session, for `hsn status`. */
export function gatewayLink(view: HubState, gateway: DeviceId): LinkId | undefined {
  return view.gateways.gateways.get(gateway)?.live?.link;
}

/**
 * The gateway a reply goes through (section 8; §7, GW9): the one that delivered the first
 * accepted copy if it is connected; for an event reply or a notice whose gateway is gone, any
 * other connected gateway; none means `no_path`. A heartbeat reply has no second choice: pass
 * `heartbeat` and it is the delivering gateway or none.
 */
export function replyGateway(
  view: HubState,
  delivered: DeviceId | undefined,
  heartbeat: boolean,
): DeviceId | undefined {
  const route = routeRadio(view.gateways, delivered, heartbeat);
  return route.kind === "gateway" ? route.entry.device : undefined;
}

/**
 * The gateway a siren command goes through by LoRa (section 8): the best SNR in the last 15
 * minutes ‡ among open sessions, the most recent on a tie; else any connected; else none.
 */
export function bestGatewayForSiren(
  view: HubState,
  siren: DeviceId,
  now: Mono,
  rules: HubRules,
): DeviceId | undefined {
  return bestForSiren(view.gateways, siren, now, rules);
}

/** The power a gateway's settings give a packet of this kind (section 8, "Powers"). */
export function gatewayPowerDbm(
  view: HubState,
  gateway: DeviceId,
  purpose: RadioPurpose,
): number | undefined {
  const entry = view.gateways.gateways.get(gateway);
  return entry === undefined ? undefined : settingsPowerDbm(entry, purpose);
}

/** A time on the gateway's 32-bit clock as hub time, through its live session's mapping. */
export function gatewayTimeToHub(
  view: HubState,
  gateway: DeviceId,
  gatewayMicros: number,
  now: Mono,
): Mono | undefined {
  const clock = view.gateways.gateways.get(gateway)?.live?.clock;
  return clock === undefined ? undefined : toHub(clock, gatewayMicros, now);
}

/** A hub time on the gateway's 32-bit clock, through its live session's mapping. */
export function hubTimeToGateway(view: HubState, gateway: DeviceId, at: Mono): number | undefined {
  const clock = view.gateways.gateways.get(gateway)?.live?.clock;
  return clock === undefined ? undefined : toGateway(clock, at);
}

/** The sensors only this gateway heard in its last hour (D97), as `gateway_offline` names them. */
export function sensorsOnlyHeardBy(
  view: HubState,
  gateway: DeviceId,
  rules: HubRules,
): readonly DeviceId[] {
  return onlyHeardBy(view.gateways, gateway, rules);
}

/** Whether a sensor's own silence alert waits because its only gateway is silent (D97). */
export function sensorSilenceHeldBack(view: HubState, sensor: DeviceId, rules: HubRules): boolean {
  return silenceHeldBack(view.gateways, sensor, rules);
}

/** A gateway's uptime from its last status in this boot, or the one saved before (section 5). */
export function gatewayUptimeS(view: HubState, gateway: DeviceId): number | undefined {
  const entry = view.gateways.gateways.get(gateway);
  return entry?.status?.uptimeSeconds ?? entry?.uptimeS;
}

/** A gateway's last status in this boot: its uptime and when it came (section 5, way 2). */
export function gatewayStatusThisBoot(
  view: HubState,
  gateway: DeviceId,
): { readonly uptimeS: number; readonly atMono: Mono } | undefined {
  const status = view.gateways.gateways.get(gateway)?.status;
  return status === undefined ? undefined : { uptimeS: status.uptimeSeconds, atMono: status.at };
}

/** A gateway's settings of its own (`gateway_config`), for `hsn device show`. */
export function gatewayConfig(view: HubState, gateway: DeviceId): GatewayConfig | undefined {
  return view.gateways.gateways.get(gateway)?.config;
}

/** What `hsn status` shows of one gateway (section 9). */
export interface GatewaySummary {
  readonly device: DeviceId;
  readonly link: LinkId | undefined;
  readonly unproven: number;
  readonly offline: boolean;
  readonly settingsVersion: number;
  readonly heldVersion: number | undefined;
  readonly lastStatusAt: Mono | undefined;
  readonly noiseMedianDbm: number | undefined;
  readonly baselineDbm: number | undefined;
  readonly hubJudgesInterference: boolean;
  readonly gatewayReportsInterference: boolean;
  readonly damagedPackets: boolean;
  readonly requestsInFlight: number;
}

/** Every gateway as `hsn status` shows it, by device id (section 9). */
export function gatewaySummaries(view: HubState): readonly GatewaySummary[] {
  return [...view.gateways.gateways.values()]
    .toSorted((a, b) => a.device - b.device)
    .map((g) => ({
      device: g.device,
      link: g.live?.link,
      unproven: g.candidates.length,
      offline: g.offline,
      settingsVersion: g.config.version,
      heldVersion: g.status?.settingsVersion,
      lastStatusAt: g.status?.at,
      noiseMedianDbm: g.status?.noiseMedianDbm,
      baselineDbm: g.noise.baseline,
      hubJudgesInterference: g.noise.interference,
      gatewayReportsInterference: g.reportedInterference,
      damagedPackets: g.noise.damaged,
      requestsInFlight: g.requests.length,
    }));
}
