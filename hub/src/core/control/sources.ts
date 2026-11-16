/**
 * What the control module reads from other modules to answer `hsn status`, `hsn site show` and
 * `hsn device show` itself, from the core's state, with no database read (hub-design.md sections
 * 3 and 9: "Reads never defeat the batching"). Each part comes from the view of the module that
 * owns it; the shell adds the writer's part of `status` (last commit, staged items).
 */
import { DataRate, dataRatesInMask, Role, SirenState, toHex } from "@hsn/protocol";
import { alarmSummary, sensorSummary, sirenShould } from "../alarm/view.ts";
import { gatewayConfig, gatewaySummaries } from "../gateways/view.ts";
import { knownDevice } from "../intake/view.ts";
import { linkLabel } from "../links/view.ts";
import type { CommandResult } from "../model/control.ts";
import type { DeviceId } from "../model/ids.ts";
import type { HubState } from "../model/state.ts";
import { type Mono, msBetween, type Now } from "../model/time.ts";
import { deviceById, isWorking, registeredDevices } from "../registry/view.ts";
import { sensorConfig } from "../sensors/view.ts";
import { sirenIds, sirenSettings, sirenSummary } from "../sirens/view.ts";
import { siteRow } from "../site/view.ts";

export type StatusResult = Extract<CommandResult, { readonly kind: "status" }>;
export type SiteShown = Extract<CommandResult, { readonly kind: "siteShow" }>["site"];
type DeviceShowResult = Extract<CommandResult, { readonly kind: "deviceShow" }>;
type Activity = StatusResult["sirens"][number]["should"];

/** The parts of `hsn device show` beyond the registry's row. */
export interface DeviceDetail {
  readonly lastSeenMs: number | null;
  readonly settings: DeviceShowResult["settings"];
  /** The latest status body as hex. */
  readonly reading: string | null;
}

export interface ControlSources {
  /** The whole of `hsn status`, or undefined when it cannot be told. */
  readonly status: (view: HubState, now: Now) => StatusResult | undefined;
  /** `hsn site show`, or undefined when it cannot be told. */
  readonly site: (view: HubState) => SiteShown | undefined;
  readonly deviceDetail: (view: HubState, device: DeviceId) => DeviceDetail;
}

/** What the CLI is told when a source cannot answer. */
export const WAITING_TEXT = "not available: the hub has not started yet";

/** Whole seconds from `now` until `until`, 0 once it has passed. */
function secondsLeft(now: Mono, until: Mono): number {
  return Math.max(0, Math.ceil(msBetween(now, until) / 1000));
}

/** A monotonic instant of this run as wall milliseconds, by `now`'s pair of readings. */
function wallAt(now: Now, at: Mono): number {
  return Math.round(now.wall - msBetween(at, now.mono));
}

function nameOf(view: HubState, device: DeviceId): string {
  return deviceById(view, device)?.name ?? `#${device}`;
}

function activityOf(kind: "off" | "sound" | "test", until: Mono | undefined, now: Mono): Activity {
  if (kind === "off" || until === undefined) return { kind: "off", secondsLeft: null };
  return { kind: kind === "sound" ? "sounding" : "testing", secondsLeft: secondsLeft(now, until) };
}

function reportedActivity(state: number, seconds: number): Activity {
  switch (state) {
    case SirenState.SoundingAlarm:
      return { kind: "sounding", secondsLeft: seconds };
    case SirenState.Testing:
      return { kind: "testing", secondsLeft: seconds };
    default:
      return { kind: "off", secondsLeft: null };
  }
}

function status(view: HubState, now: Now): StatusResult {
  const working = registeredDevices(view).filter((row) => isWorking(row.state));
  const sensors = working
    .filter((row) => row.role === Role.Sensor)
    .flatMap((row) => {
      const line = sensorSummary(view, row.id, now.mono);
      return line === undefined ? [] : [{ name: row.name, ...line }];
    });
  const run = alarmSummary(view);
  const sirens = sirenIds(view).flatMap((siren) => {
    const line = sirenSummary(view, siren, now.mono);
    if (line === undefined) return [];
    const should = sirenShould(view, siren, now.mono);
    const commanded = line.commanded;
    return [
      {
        name: nameOf(view, siren),
        should: activityOf(should.kind, should.kind === "off" ? undefined : should.until, now.mono),
        commanded:
          commanded === undefined
            ? null
            : activityOf(
                commanded.kind,
                commanded.kind === "off" ? undefined : commanded.until,
                now.mono,
              ),
        reported:
          line.reported === undefined
            ? null
            : reportedActivity(line.reported.state, line.reported.secondsLeft),
        wifi: line.wifi,
        lora: line.lora,
      },
    ];
  });
  const gateways = gatewaySummaries(view).map((g) => ({
    name: nameOf(view, g.device),
    session: g.link !== undefined,
    link: g.link === undefined ? null : (linkLabel(view, g.link) ?? null),
    lastStatusMs: g.lastStatusAt === undefined ? null : wallAt(now, g.lastStatusAt),
    noiseMedianDbm: g.noiseMedianDbm ?? null,
    baselineDbm: g.baselineDbm ?? null,
  }));
  return {
    kind: "status",
    sensors,
    alarm:
      run === undefined
        ? null
        : {
            startedMs: Math.max(0, wallAt(now, run.startedAt)),
            triggers: run.triggers.map((d) => nameOf(view, d)),
            sirens: run.sirens.map((d) => nameOf(view, d)),
          },
    sirens,
    gateways,
    // The writer's part, which only the shell knows; it fills these in (shell/control).
    lastCommitMs: null,
    stagedItems: 0,
    databaseBytes: null,
    historyShortened: false,
    longestTurnMs: 0,
  };
}

function site(view: HubState): SiteShown {
  const row = siteRow(view);
  return {
    channel: row.channel,
    rate: dataRatesInMask(row.rateMask).at(-1) ?? DataRate.DR5,
    countdownS: row.countdownDefaultS,
    autoStopS: row.autoStopS,
    wifiName: row.wifiName.length === 0 ? null : new TextDecoder().decode(row.wifiName),
    replyPowerDbm: row.replyPowerDbm,
    sirenPowerDbm: row.sirenPowerDbm,
  };
}

function deviceDetail(view: HubState, device: DeviceId): DeviceDetail {
  const known = knownDevice(view, device);
  const reading = known?.reading ?? null;
  const base = {
    lastSeenMs: known?.heardMs ?? null,
    reading: reading === null ? null : toHex(reading),
  };
  const sensor = sensorConfig(view, device);
  if (sensor !== undefined) {
    return {
      ...base,
      settings: {
        role: "sensor",
        version: sensor.version,
        countdownS: sensor.countdownS,
        heartbeatUnits: sensor.heartbeatUnits,
        linkCheckEvery: sensor.linkCheckEvery,
        sendRate: sensor.sendRate,
        replyRate: sensor.replyRate,
        replyRateFixed: sensor.replyRateFixed,
        correctionUnits: sensor.correctionUnits,
        correctionFixed: sensor.correctionFixed,
      },
    };
  }
  const siren = sirenSettings(view, device);
  if (siren !== undefined) {
    return {
      ...base,
      settings: {
        role: "siren",
        version: siren.version,
        wifiIntervalS: siren.wifiIntervalS,
        loraCheckUnits: siren.loraCheckUnits,
        maxSoundS: siren.maxSoundS,
        sendRate: siren.sendRate,
        commandRate: siren.commandRate,
      },
    };
  }
  const gateway = gatewayConfig(view, device);
  if (gateway !== undefined) {
    return {
      ...base,
      settings: {
        role: "gateway",
        version: gateway.version,
        statusIntervalS: gateway.statusIntervalS,
        interferenceDb: gateway.interferenceDb,
        interferenceS: gateway.interferenceS,
        defaultPowerDbm: gateway.defaultPowerDbm,
        sirenPowerDbm: gateway.sirenPowerDbm,
      },
    };
  }
  return { ...base, settings: null };
}

/** The sources over the modules' views. */
export const VIEW_SOURCES: ControlSources = { status, site, deviceDetail };
