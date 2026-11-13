/**
 * What an accepted sensor packet tells the sensors module besides its reply (hub-design.md
 * section 8; protocol.md §6, §7; D107, D108, D114): its SNR for the reply rate, its loss for
 * D107, flag bit 7 (two faster replies lost: one step slower at once), the version and listening
 * rate of its newest status, and the clock correction slots measured. Only the newest packet
 * changes these (section 8). A heartbeat never starts a countdown or changes arming (D114):
 * nothing here emits either. Flag bit 5 and the door warnings (`local_alarm_reported`,
 * `door_changes_missed`, `door_state_unexpected`) are the alarm module's records, made from the
 * same `accepted` message, so they are not recorded here twice.
 */
import { ok, type Result } from "neverthrow";
import { type Message, MessageType } from "@hsn/protocol";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { Arrival, Internal } from "../model/messages.ts";
import { monoAfterMs } from "../model/time.ts";
import { siteRow } from "../site/view.ts";
import { correctionProposal } from "../slots/view.ts";
import { orFault } from "./records.ts";
import { chooseReplyRate, fallBackReplyRate } from "./reply-rate.ts";
import { changeConfig } from "./entries.ts";
import type { ConfigChange } from "./settings.ts";
import { dayOf } from "./silence.ts";
import type { SensorEntry } from "./state.ts";

/** SNR on the wire is quarter decibels (§6, forwarded packet). */
const QUARTERS_PER_DB = 4;

/** A sensor status packet: heartbeat, door, cover, button (§6). */
export type StatusMessage = Extract<Message, { readonly type: 1 | 2 | 3 | 4 }>;

/** True for a sensor status packet. */
export function isStatus(message: Message): message is StatusMessage {
  return (
    message.type === MessageType.Heartbeat ||
    message.type === MessageType.DoorChanged ||
    message.type === MessageType.CoverChanged ||
    message.type === MessageType.Button
  );
}

/** The settings version a packet names, if its type names one (§6): status packets, Started, siren reports. */
export function versionNamed(message: Message): number | undefined {
  switch (message.type) {
    case MessageType.Heartbeat:
    case MessageType.DoorChanged:
    case MessageType.CoverChanged:
    case MessageType.Button:
    case MessageType.Started:
    case MessageType.SirenReport:
      return message.settingsVersion;
    default:
      return undefined;
  }
}

/** What observing one packet did. */
export interface Observed {
  readonly entry: SensorEntry;
  readonly out: readonly Internal[];
  /** True when the settings row changed, to be written now (section 5). */
  readonly changed: boolean;
}

/** D107's counts: received one more; expected the counter's advance, but not a Started's jump. */
function countLoss(
  ctx: Context,
  entry: SensorEntry,
  counter: number,
  newest: boolean,
  started: boolean,
): SensorEntry {
  const day = dayOf(ctx.now.wall);
  const today = entry.loss.get(day) ?? { received: 0, expected: 0 };
  const advance =
    !newest || entry.lastCounter === 0 || started ? (newest ? 1 : 0) : counter - entry.lastCounter;
  return {
    ...entry,
    lastCounter: newest ? counter : entry.lastCounter,
    loss: new Map(entry.loss).set(day, {
      received: today.received + 1,
      expected: today.expected + Math.max(0, advance),
    }),
  };
}

/** The reply rate and the clock correction, as the rules of section 8 now choose them. */
function settingsChange(
  ctx: Context,
  entry: SensorEntry,
  status: StatusMessage | undefined,
  arrival: Arrival,
  following: boolean,
): Result<
  { readonly change: ConfigChange; readonly fasterFrom: SensorEntry["fasterFrom"] },
  CoreFault
> {
  const rules = ctx.deps.rules;
  const { config } = entry;
  let change: ConfigChange = {};
  let fasterFrom = entry.fasterFrom;
  if (!config.replyRateFixed) {
    if (status?.flags.listeningAtSendRate === true && !following) {
      // Flag bit 7: two faster replies just lost (§7): one step slower at once ‡. Not when the
      // sensor follows a site move: its bit 7 then says the old settings went unanswered (§7).
      change = { replyRate: fallBackReplyRate(rules, config.sendRate, config.replyRate) };
      fasterFrom = monoAfterMs(ctx.now.mono, rules.replyRate.minIntervalMs);
    } else if (arrival.path === "lora") {
      const best = arrival.gateway;
      const chosen = chooseReplyRate(rules, {
        snrDb: entry.snr
          .filter((s) => s.gateway === best)
          .map((s) => s.snrQuarterDb / QUARTERS_PER_DB),
        sendRate: config.sendRate,
        current: config.replyRate,
        replyPowerDbm: siteRow(ctx.view).replyPowerDbm,
        fasterAllowed: fasterFrom === undefined || ctx.now.mono >= fasterFrom,
      });
      if (chosen > config.replyRate)
        fasterFrom = monoAfterMs(ctx.now.mono, rules.replyRate.minIntervalMs);
      change = { replyRate: chosen };
    }
  }
  if (config.correctionFixed) return ok({ change, fasterFrom });
  return orFault(ctx, correctionProposal(ctx.view, entry.device, ctx.now.mono, rules)).map(
    (units) => ({
      change: units === undefined ? change : { ...change, correctionUnits: units },
      fasterFrom,
    }),
  );
}

/** Observes one accepted packet of a sensor. */
export function observe(
  ctx: Context,
  entry: SensorEntry,
  accepted: Extract<Internal, { kind: "accepted" }>,
  following: boolean,
): Result<Observed, CoreFault> {
  const { message, arrival, counter, newest } = accepted;
  const rules = ctx.deps.rules;
  const counted = countLoss(ctx, entry, counter, newest, message.type === MessageType.Started);
  if (!newest) return ok({ entry: counted, out: [], changed: false });
  const status = isStatus(message) ? message : undefined;
  const snr =
    arrival.path === "lora"
      ? [...counted.snr, { gateway: arrival.gateway, snrQuarterDb: arrival.snrQuarterDb }].slice(
          -rules.replyRate.snrSamples,
        )
      : counted.snr;
  const heard: SensorEntry = {
    ...counted,
    snr,
    heardAt: ctx.now.mono,
    heardRate: arrival.path === "lora" ? arrival.dataRate : counted.heardRate,
    silent: false,
    // A restarted sensor has lost its slot until a reply gives it one again (section 8).
    slotFrom: message.type === MessageType.Started ? undefined : counted.slotFrom,
    status:
      status === undefined
        ? counted.status
        : {
            version: status.settingsVersion,
            listeningAtSendRate: status.flags.listeningAtSendRate,
          },
  };
  return settingsChange(ctx, heard, status, arrival, following).map(({ change, fasterFrom }) => {
    const applied = changeConfig(ctx, heard.config, change);
    return {
      entry: { ...heard, config: applied.config, fasterFrom },
      out: [],
      changed: applied.changed,
    };
  });
}
