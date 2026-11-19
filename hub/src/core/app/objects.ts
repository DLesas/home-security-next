/**
 * The objects of the snapshot, `device.list`, `site.show` and the events (m2-design.md section
 * 6), built from the core's state as `hsn status` is (HD 3: "Reads never defeat the batching"),
 * and filtered by what the actor may view (section 7): sensors by *view*, sirens and gateways for
 * everyone ‡, since an alarm concerns everyone in the house.
 */
import { DataRate, dataRatesInMask, Role, SirenState } from "@hsn/protocol";
import type { DeviceObject, HubInfo, SnapshotObject, AppOpReply } from "@hsn/protocol/app";
import {
  APP_PROTO_VERSION,
  appIdentityBytes,
  formatIdentity,
  OPTIONAL_CATEGORIES,
} from "@hsn/protocol/app";
import { batteryLow, batteryPercent, poorLink, silent, tamperOpen } from "../health/view.ts";
import { currentMode, groupObjects, modeObjects } from "../layout/view.ts";
import { prefsFor, unreadFor } from "../notify/view.ts";
import { sensorConfig } from "../sensors/view.ts";
import { scheduleObjects, timeZone } from "../schedules/view.ts";
import { appStaticPublic } from "../people/view.ts";
import { hubFacts } from "./view.ts";
import { alarmSummary, sensorSummary, sirenShould } from "../alarm/view.ts";
import { bootOf, wallTrusted } from "../clock/view.ts";
import { gatewayConfig, gatewaySummaries } from "../gateways/view.ts";
import { knownDevice } from "../intake/view.ts";
import { type DeviceId, deviceId } from "../model/ids.ts";
import type { Actor } from "../model/messages.ts";
import { DeviceState, type DeviceRow } from "../model/rows.ts";
import type { HubState } from "../model/state.ts";
import { type Mono, msBetween, type Now } from "../model/time.ts";
import { mayView } from "../people/view.ts";
import { firmwareText, registeredDevices, roleName } from "../registry/view.ts";
import { latestMove, moveCounts, siteRow } from "../site/view.ts";
import { sirenIds, sirenSettings, sirenSummary } from "../sirens/view.ts";
import type { CoreDeps } from "../model/handler.ts";

type SirenStatus = SnapshotObject["sirens"][number];
type SiteObject = SnapshotObject["site"];
type SiteMove = NonNullable<SnapshotObject["siteMove"]>;

const STATE_NAMES: Readonly<Record<DeviceState, DeviceObject["state"]>> = {
  [DeviceState.Provisioning]: "provisioning",
  [DeviceState.Paired]: "paired",
  [DeviceState.Contacted]: "contacted",
  [DeviceState.ResetByOwner]: "resetByOwner",
  [DeviceState.Removed]: "removed",
  [DeviceState.LeftBehind]: "leftBehind",
};

/** A monotonic instant of this run as wall milliseconds, by `now`'s pair of readings. */
function wallAt(now: Now, at: Mono): number {
  return Math.max(0, Math.round(now.wall - msBetween(at, now.mono)));
}

/** Whether a device may be shown to the actor: a sensor by *view*, any other device always. */
export function deviceVisible(view: HubState, actor: Actor, row: DeviceRow): boolean {
  return row.role !== Role.Sensor || mayView(view, actor, row.id);
}

export function deviceObject(
  view: HubState,
  deps: CoreDeps,
  row: DeviceRow,
): DeviceObject | undefined {
  const role = roleName(row.role);
  if (role === undefined) return undefined;
  const known = knownDevice(view, row.id);
  const rssi = known?.rssi ?? null;
  const snr = known?.snrQ ?? null;
  return {
    id: row.id,
    name: row.name,
    role,
    state: STATE_NAMES[row.state],
    firmware: row.firmware === 0 ? "" : firmwareText(row.firmware),
    batteryPercent: batteryPercent(view, deps.rules, row.id),
    signal: rssi === null || snr === null ? null : { rssiDbm: rssi, snrQuarterDb: snr },
    temperatureC: null,
    lastSeenMs: known?.heardMs ?? null,
    heardBy: known?.bestGateway ?? null,
    health: {
      silent: silent(view, row.id),
      batteryLow: batteryLow(view, row.id),
      tamperOpen: tamperOpen(view, row.id),
      poorLink: poorLink(view, row.id),
    },
  };
}

/** The devices the actor may see, excluding the hub and devices removed for good. */
export function visibleDevices(view: HubState, actor: Actor): readonly DeviceRow[] {
  return registeredDevices(view)
    .filter(
      (row) =>
        row.state !== DeviceState.Removed &&
        roleName(row.role) !== undefined &&
        deviceVisible(view, actor, row),
    )
    .toSorted((a, b) => a.id - b.id);
}

/** `site.show` and the snapshot's site: no channel (null) until the first survey. */
export function siteObject(view: HubState): SiteObject {
  const row = siteRow(view);
  return {
    channel: row.channel,
    rate: dataRatesInMask(row.rateMask).at(-1) ?? DataRate.DR5,
    countdownS: row.countdownDefaultS,
    autoStopS: row.autoStopS,
    wifiName: new TextDecoder().decode(row.wifiName),
    retentionRoutineDays: row.retentionRoutineDays,
    retentionEventDays: row.retentionEventDays,
  };
}

/** The site move as the app shows it, with `site`'s counts (section 11, "Step 1's questions"). */
export function siteMoveObject(view: HubState): SiteMove | null {
  const move = latestMove(view);
  if (move === undefined) return null;
  return {
    stage: move.stage,
    channel: move.channel ?? null,
    rate: move.rate ?? null,
    ...moveCounts(view),
  };
}

function secondsLeft(now: Mono, until: Mono): number {
  return Math.max(0, Math.ceil(msBetween(now, until) / 1000));
}

type Output = SirenStatus["should"];

function output(kind: "off" | "sound" | "test", until: Mono | undefined, now: Mono): Output {
  if (kind === "off" || until === undefined) return { kind: "off", secondsLeft: null };
  return { kind, secondsLeft: secondsLeft(now, until) };
}

function reportedOutput(state: number, seconds: number): Output {
  if (state === SirenState.SoundingAlarm) return { kind: "sound", secondsLeft: seconds };
  if (state === SirenState.Testing) return { kind: "test", secondsLeft: seconds };
  return { kind: "off", secondsLeft: null };
}

function pathName(path: "up" | "lost" | "none"): "up" | "lost" | "unknown" {
  return path === "none" ? "unknown" : path;
}

export function sirenStatuses(view: HubState, now: Mono): readonly SirenStatus[] {
  return sirenIds(view).flatMap((siren) => {
    const line = sirenSummary(view, siren, now);
    if (line === undefined) return [];
    const should = sirenShould(view, siren, now);
    const commanded = line.commanded;
    return [
      {
        id: siren,
        should: output(should.kind, should.kind === "off" ? undefined : should.until, now),
        commanded:
          commanded === undefined
            ? null
            : output(commanded.kind, commanded.kind === "off" ? undefined : commanded.until, now),
        reported:
          line.reported === undefined
            ? null
            : reportedOutput(line.reported.state, line.reported.secondsLeft),
        wifi: pathName(line.wifi),
        lora: pathName(line.lora),
      },
    ];
  });
}

export function alarmObject(view: HubState, actor: Actor, now: Now): SnapshotObject["alarm"] {
  const run = alarmSummary(view);
  if (run === undefined) return null;
  return {
    startedMs: wallAt(now, run.startedAt),
    triggers: run.triggers.filter((sensor) => mayView(view, actor, sensor)),
    sirens: run.sirens,
  };
}

/** The certificate's SHA-256 as browsers show a fingerprint: upper-case hex pairs, colons between. */
export function fingerprintText(sha256: Uint8Array): string {
  return [...sha256].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}

/**
 * `hub.info` (section 6): from the shell's `hubFacts`, the hub's app key (its identity, section 5)
 * and the schedules' time zone, "" until the shell has given one. Undefined before the shell has
 * given its facts, or before the app key exists.
 */
export function hubInfoObject(view: HubState, deps: CoreDeps, now: Now): HubInfo | undefined {
  const facts = hubFacts(view);
  const key = appStaticPublic(view);
  const boot = bootOf(view);
  if (facts === undefined || key === undefined || boot === undefined) return undefined;
  return {
    hub: facts.version,
    proto: APP_PROTO_VERSION,
    identity: formatIdentity(appIdentityBytes(deps.sha256, key)),
    fingerprint: fingerprintText(facts.certificateSha256),
    timeZone: timeZone(view) ?? "",
    clockTrusted: wallTrusted(view, now),
    boot,
  };
}

/**
 * A device's settings for `device.show` (section 6): the matching `*.settings` body's fields, from
 * the M1a modules' views, with the version they make; undefined for a device with none yet.
 */
export function deviceSettings(
  view: HubState,
  device: DeviceId,
): AppOpReply<"device.show">["settings"] | undefined {
  const sensor = sensorConfig(view, device);
  if (sensor !== undefined) {
    return {
      countdown: sensor.countdownS,
      heartbeat: sensor.heartbeatUnits,
      linkCheck: sensor.linkCheckEvery,
      replyRate: sensor.replyRateFixed ? sensor.replyRate : "learn",
      correction: sensor.correctionFixed ? sensor.correctionUnits : "learn",
      version: sensor.version,
    };
  }
  const siren = sirenSettings(view, device);
  if (siren !== undefined) return { max: siren.maxSoundS, version: siren.version };
  const gateway = gatewayConfig(view, device);
  if (gateway !== undefined) {
    return {
      statusS: gateway.statusIntervalS,
      interferenceDb: gateway.interferenceDb,
      interferenceS: gateway.interferenceS,
      powerDbm: gateway.defaultPowerDbm,
      sirenPowerDbm: gateway.sirenPowerDbm,
      version: gateway.version,
    };
  }
  return undefined;
}

/** This client's preferences for the snapshot; the hub computer, which has none, all on. */
function prefsOfActor(view: HubState, actor: Actor): SnapshotObject["notificationPrefs"] {
  return actor.kind === "person" || actor.kind === "console"
    ? prefsFor(view, actor.client)
    : { categories: OPTIONAL_CATEGORIES, revision: 0 };
}

/**
 * The snapshot's configuration (section 5, "Configuration in the snapshot"): every mode (to
 * switch, HB5a's *manage* is still needed); every group, with only the sensors the actor may view
 * in its `sensors` and its sirens in full, as sirens are everyone's; every schedule entry but those
 * whose target is a sensor the actor may not view, or a group none of whose sensors they may view.
 */
export function configurationFor(
  view: HubState,
  actor: Actor,
): Pick<SnapshotObject, "modes" | "groups" | "schedules"> {
  const may = (device: number) => mayView(view, actor, deviceId(device));
  const groups = groupObjects(view);
  const schedules = scheduleObjects(view).filter((entry) => {
    const target = entry.target;
    if ("sensor" in target) return may(target.sensor);
    if ("group" in target) {
      const group = groups.find((g) => g.id === target.group);
      return group === undefined || group.sensors.some(may);
    }
    return true;
  });
  return {
    modes: modeObjects(view),
    groups: groups.map((group) => ({ ...group, sensors: group.sensors.filter(may) })),
    schedules,
  };
}

/**
 * `snapshot` (section 6): the state the actor may see, at revision `rev`, built from the core's
 * state, so a snapshot never causes a commit (section 5, "Live updates").
 */
export function snapshotObject(
  view: HubState,
  deps: CoreDeps,
  actor: Actor,
  now: Now,
  rev: number,
): SnapshotObject | undefined {
  const hub = hubInfoObject(view, deps, now);
  if (hub === undefined) return undefined;
  const devices = visibleDevices(view, actor);
  // The console's (and the hub computer's) are everyone's ‡ (`HubRules.notify.consoleGetsAll`).
  const person = actor.kind === "person" ? actor.person : null;
  const since = now.wall - deps.rules.notify.unreadWindowMs;
  return {
    rev,
    hub,
    site: siteObject(view),
    mode: currentMode(view),
    devices: devices.flatMap((row) => {
      const object = deviceObject(view, deps, row);
      return object === undefined ? [] : [object];
    }),
    sensors: devices
      .filter((row) => row.role === Role.Sensor)
      .flatMap((row) => {
        const line = sensorSummary(view, row.id, now.mono);
        return line === undefined ? [] : [{ id: row.id, ...line }];
      }),
    sirens: sirenStatuses(view, now.mono),
    gateways: gatewaySummaries(view).map((g) => ({
      id: g.device,
      session: g.link !== undefined,
      offline: g.offline,
      lastStatusMs: g.lastStatusAt === undefined ? null : wallAt(now, g.lastStatusAt),
    })),
    alarm: alarmObject(view, actor, now),
    siteMove: siteMoveObject(view),
    notifications: unreadFor(view, person, since, deps.rules, now.wall),
    ...configurationFor(view, actor),
    notificationPrefs: prefsOfActor(view, actor),
  };
}

/** `device.list` (section 6): the devices the actor may view; sirens and gateways for all ‡. */
export function deviceList(
  view: HubState,
  deps: CoreDeps,
  actor: Actor,
): AppOpReply<"device.list"> {
  return {
    devices: visibleDevices(view, actor).flatMap((row) => {
      const object = deviceObject(view, deps, row);
      return object === undefined ? [] : [object];
    }),
  };
}

export type { DeviceId };
