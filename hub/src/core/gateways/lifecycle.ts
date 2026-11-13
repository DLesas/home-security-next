/**
 * The gateways' lives outside their packets (hub-design.md sections 5, 7 and 8): restoring them
 * at boot, adding and removing one, the site move's switch (D115), a failed commit's resume
 * points (section 4), and silence (§7, D97).
 */
import { err, ok, type Result } from "neverthrow";
import { newSendCounter, ResumeStep, Role } from "@hsn/protocol";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot } from "../model/events.ts";
import type { Context } from "../model/handler.ts";
import type { BootId, DeviceId } from "../model/ids.ts";
import type { DomainMessage, Internal } from "../model/messages.ts";
import { DeviceState, TxOutcome } from "../model/rows.ts";
import { type Mono, monoAfterMs } from "../model/time.ts";
import { safeResumeSendCounter } from "../util/protocol-safe.ts";
import { asFault, clearTimer, done, type Outcome, setTimer, withGateway } from "./common.ts";
import { restoredNoise } from "./noise.ts";
import { restoredState } from "./persist.ts";
import { decision } from "./records.ts";
import { sensorsOnlyHeardBy } from "./routing.ts";
import { resumePointWrite } from "./seal.ts";
import { configFromRow, configWrite, firstConfig, rateMask, siteRadio } from "./settings.ts";
import { EMPTY_NOISE, type GatewayEntry, type GatewaysSlice } from "./state.ts";
import { resettle } from "./survey.ts";
import { resolveRequests } from "./transmit.ts";

type SiteMove = Extract<DomainMessage, { readonly kind: "siteMove" }>;

/** A gateway the hub knows but has not heard from in this boot. */
function newEntry(
  device: DeviceId,
  address: number,
  config: GatewayEntry["config"],
  counter: GatewayEntry["counter"],
): GatewayEntry {
  return {
    device,
    address,
    config,
    counter,
    highestAccepted: 0,
    live: undefined,
    candidates: [],
    requests: [],
    lastHeardAt: undefined,
    lastHeardMs: undefined,
    lastHeardTrusted: false,
    offline: false,
    status: undefined,
    uptimeS: undefined,
    noise: EMPTY_NOISE,
    reportedInterference: false,
  };
}

/** Its silence clock starts now: from its last packet or the hub's start (§7, D97). */
function offlineTimer(
  slice: GatewaysSlice,
  device: DeviceId,
  from: Mono,
  ctx: Context,
): GatewaysSlice {
  return setTimer(slice, {
    at: monoAfterMs(from, ctx.deps.rules.silence.gatewayOfflineMs),
    key: { module: "gateways", kind: "offline", gateway: device },
  });
}

/**
 * The boot event (section 7, "Hub restart"): every paired gateway with its settings, its hub
 * counter resumed from its saved resume point (§4), the highest counter it was accepted with,
 * its last uptime and its noise baseline. Sessions are memory only: gateways send a new hello.
 */
export function handleBoot(
  slice: GatewaysSlice,
  snapshot: DurableSnapshot,
  boot: BootId,
  ctx: Context,
): Outcome {
  const site = siteRadio(ctx, snapshot.site);
  if (site.isErr()) return err(site.error);
  let next: GatewaysSlice = {
    ...slice,
    boot,
    site: site.value,
    gateways: new Map(),
    heard: new Map(),
    sirenCopies: new Map(),
    timers: [],
  };
  for (const row of snapshot.devices) {
    if (row.role !== Role.Gateway || row.state === DeviceState.Removed) continue;
    const configRow = snapshot.gatewayConfig.find((c) => c.deviceId === row.id);
    const counterRow = snapshot.sendCounters.find((c) => c.deviceId === row.id);
    // SPEC-QUESTION: a paired gateway always has its resume point (section 9 writes it with the
    // device); one without is given a new counter, which the send gate holds back until its
    // first resume point is committed.
    const counter =
      counterRow === undefined
        ? ok(newSendCounter(ResumeStep.Hub))
        : safeResumeSendCounter(ResumeStep.Hub, counterRow.resumePoint).mapErr((e) =>
            asFault(ctx, e),
          );
    if (counter.isErr()) return err(counter.error);
    const restored = restoredState(snapshot.deviceState.find((d) => d.deviceId === row.id));
    const entry: GatewayEntry = {
      ...newEntry(
        row.id,
        row.address,
        configRow === undefined
          ? firstConfig(ctx.deps.rules, site.value)
          : configFromRow(configRow),
        counter.value,
      ),
      highestAccepted: restored.highestAccepted,
      uptimeS: restored.uptimeS,
      noise: restoredNoise(restored.baseline, ctx.now.mono, EMPTY_NOISE),
    };
    next = offlineTimer(withGateway(next, entry), row.id, ctx.now.mono, ctx);
  }
  return done(next);
}

/** A gateway was added (section 9, D100): settings version 1, written now; counters from 1. */
export function handleAdded(
  slice: GatewaysSlice,
  message: Extract<DomainMessage, { readonly kind: "deviceAdded" }>,
  ctx: Context,
): Outcome {
  if (message.role !== Role.Gateway) return done(slice);
  const config = firstConfig(ctx.deps.rules, slice.site);
  const entry = newEntry(message.device, message.address, config, newSendCounter(ResumeStep.Hub));
  const next = offlineTimer(withGateway(slice, entry), message.device, ctx.now.mono, ctx);
  return done(next, [configWrite(message.device, config)]);
}

/** A gateway was removed: its key is gone, so its sessions end and its links close. */
export function handleRemoved(slice: GatewaysSlice, device: DeviceId): Outcome {
  const entry = slice.gateways.get(device);
  if (entry === undefined) return done(slice);
  const resolved = resolveRequests(slice, entry, () => true, TxOutcome.NoResult);
  const links = new Set([
    ...(entry.live === undefined ? [] : [entry.live.link]),
    ...entry.candidates.map((c) => c.link),
  ]);
  const gateways = new Map(resolved.slice.gateways);
  gateways.delete(device);
  let next: GatewaysSlice = { ...resolved.slice, gateways };
  next = clearTimer(next, { module: "gateways", kind: "offline", gateway: device });
  const closes: Effect[] = [];
  for (const link of links) {
    next = clearTimer(next, { module: "gateways", kind: "unprovenSession", link });
    closes.push({ kind: "close", link, reason: "gateway removed" });
  }
  const down: Internal[] =
    entry.live === undefined ? [] : [{ kind: "gatewayDown", gateway: device }];
  return done(next, [...resolved.out, ...closes, ...down]);
}

/**
 * The site move's switch (D115, section 8): every gateway gets a new settings version carrying
 * the new channel and rate, written now in the switch's step, and the connected ones are sent
 * it at once; an offline one gets it at its next welcome, as always.
 */
export function handleSiteMove(slice: GatewaysSlice, message: SiteMove, ctx: Context): Outcome {
  if (message.stage !== "switched" || message.move === slice.site.appliedMove) return done(slice);
  const mask: Result<number | undefined, CoreFault> =
    message.rate === undefined ? ok(undefined) : rateMask(ctx, message.rate);
  if (mask.isErr()) return err(mask.error);
  const moved: GatewaysSlice = {
    ...slice,
    site: {
      ...slice.site,
      channel: message.channel ?? slice.site.channel,
      rateMask: mask.value ?? slice.site.rateMask,
      appliedMove: message.move,
    },
  };
  return resettle(slice, moved.site, ctx);
}

/**
 * A commit failed (section 4): the resume point of every gateway key is emitted again, now, so
 * the next successful commit carries it and the send gate lets its packets go.
 */
export function handleCommitFailed(slice: GatewaysSlice): Outcome {
  return done(slice, [...slice.gateways.values()].map(resumePointWrite));
}

/**
 * Nothing from a gateway for 60 s (§7, D97): it is offline, a warning written now that names
 * the sensors no other gateway heard in the last hour, whose own silence is then held back.
 */
export function handleOffline(slice: GatewaysSlice, device: DeviceId, ctx: Context): Outcome {
  const cleared = clearTimer(slice, { module: "gateways", kind: "offline", gateway: device });
  const entry = cleared.gateways.get(device);
  if (entry === undefined || entry.offline) return done(cleared);
  const sensors = sensorsOnlyHeardBy(cleared, device, ctx.deps.rules);
  const next = withGateway(cleared, { ...entry, offline: true });
  return decision(ctx, {
    kind: "gateway_offline",
    device,
    cause: null,
    value: sensors.length,
    detail: deviceList(sensors),
    durability: "now",
  }).andThen((record) =>
    done(next, [
      record,
      ...(entry.live === undefined ? [] : [{ kind: "gatewayDown" as const, gateway: device }]),
    ]),
  );
}

/** Device ids as u32 LE, one after another, for a decision's detail. */
function deviceList(devices: readonly DeviceId[]): Uint8Array {
  const bytes = new Uint8Array(4 * devices.length);
  const view = new DataView(bytes.buffer);
  devices.forEach((device, i) => {
    view.setUint32(4 * i, device, true);
  });
  return bytes;
}
