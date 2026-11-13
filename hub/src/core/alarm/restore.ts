/**
 * The restart rule (hub-design.md section 5, "How long was the hub down?" and "What the hub does
 * on a start where it cannot know how long it was down"; section 7, "Hub restart"; D80, D113,
 * HB30).
 *
 * At boot every saved countdown and the alarm are re-expressed on this boot's clock with the time
 * they had left at the last commit, counted from the start, as if the hub had not been down at all,
 * and written again now. That is D113's rule while the downtime is unknown: a countdown can end up
 * to one countdown late, never early and never lost; a saved alarm's sirens are asked to report
 * (the sirens module's "report now") and only believed. The moment the downtime is known
 * (`downtimeKnown`), everything restored is moved back by it and judged again as if restored with
 * it: a countdown that ran out while the hub was down follows D106, and a siren that should still
 * sound is sounded.
 *
 * SPEC-QUESTION: `downtimeKnown.downtimeMs` is read as the time from the last commit to this
 * boot's start, not to the moment it became known; the clock module (E4) must subtract the time
 * since the boot when it measures later.
 */
import { ok } from "neverthrow";
import { decodeMessage, MessageType, Role, SirenState } from "@hsn/protocol";
import type { Context } from "../model/handler.ts";
import { type DeviceId, HUB_DEVICE } from "../model/ids.ts";
import type { DomainMessage, Internal } from "../model/messages.ts";
import type { DurableSnapshot, HubEvent } from "../model/events.ts";
import { AlarmTriggerKind, ArmState, DeviceState, type DeviceStateRow } from "../model/rows.ts";
import { type Mono, mono, MICROS_PER_MILLISECOND } from "../model/time.ts";
import { sirenRow, triggerRow } from "./alarm.ts";
import { countdownRow, judgeEnded } from "./doors.ts";
import { type Changing, decide, each, type Out, then, unchanged, writeNow } from "./out.ts";
import type {
  AlarmRun,
  AlarmSiren,
  AlarmSlice,
  Countdown,
  DoorReport,
  SensorArming,
  SirenRestore,
  Trigger,
} from "./state.ts";
import { afterSeconds, secondsUntil } from "./time.ts";

type Boot = Extract<HubEvent, { readonly kind: "boot" }>;
type Accepted = Extract<DomainMessage, { readonly kind: "accepted" }>;

/** ESP-IDF's reset reason for a power-on (`ESP_RST_POWERON`), as Started carries it (§6). */
export const RESET_CAUSE_POWER_ON = 1;

/**
 * A time saved in an earlier run, on this boot's clock with no downtime counted: `bootAt` plus
 * what was left of it at the last commit. Undefined when it was saved in a run other than the one
 * of the last commit mark, or with no mark at all.
 */
function reexpress(
  mark: DeviceStateRow | undefined,
  bootAt: Mono,
  boot: number,
  saved: Mono,
): Mono | undefined {
  return mark?.boot === boot ? mono(bootAt + (saved - mark.lastSeenMono)) : undefined;
}

/** The door state a saved reading shows: the latest status body, raw (section 6, `reading`). */
function savedDoor(reading: Uint8Array | null): DoorReport | undefined {
  if (reading === null) return undefined;
  const decoded = decodeMessage(new Uint8Array([MessageType.Heartbeat, ...reading]));
  if (!decoded.ok || decoded.value.type !== MessageType.Heartbeat) return undefined;
  return { open: decoded.value.flags.doorOpen, changeCount: decoded.value.doorChangeCount };
}

function restoredSensors(
  snapshot: DurableSnapshot,
  countdownDefaultS: number,
): ReadonlyMap<DeviceId, SensorArming> {
  const configs = new Map(snapshot.sensorConfig.map((row) => [row.deviceId, row]));
  const readings = new Map(snapshot.deviceState.map((row) => [row.deviceId, row.reading]));
  return new Map(
    snapshot.devices
      .filter((device) => device.role === Role.Sensor && device.state !== DeviceState.Removed)
      .map((device): [DeviceId, SensorArming] => {
        const config = configs.get(device.id);
        const door = savedDoor(readings.get(device.id) ?? null);
        return [
          device.id,
          {
            arm: config?.arm ?? ArmState.Disarmed,
            armedBoot: config?.armedBoot ?? null,
            armedMono: config?.armedMono ?? null,
            countdownS: config?.countdownS ?? countdownDefaultS,
            door,
            doorNow: door?.open,
            doorWarned: false,
            changesWarned: undefined,
          },
        ];
      }),
  );
}

/** A new sensor, disarmed, with the site's default countdown (D40, D86). */
export function newSensor(countdownS: number): SensorArming {
  return {
    arm: ArmState.Disarmed,
    armedBoot: null,
    armedMono: null,
    countdownS,
    door: undefined,
    doorNow: undefined,
    doorWarned: false,
    changesWarned: undefined,
  };
}

/**
 * The boot event: arming states, countdowns and the alarm, re-expressed on this boot's clock and
 * written again now with this boot's id, before anything is sent (section 7, "Hub restart").
 */
export function onBoot(slice: AlarmSlice, ctx: Context, event: Boot): Changing {
  const { snapshot } = event;
  const rules = ctx.deps.rules.arming;
  const bootAt = ctx.now.mono;
  const autoStopS = snapshot.site?.autoStopS ?? rules.autoStopS;
  const countdownDefaultS = snapshot.site?.countdownDefaultS ?? rules.countdownDefaultS;
  const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
  const sensors = restoredSensors(snapshot, countdownDefaultS);
  const at = (boot: number, saved: Mono, fallback: Mono): Mono =>
    reexpress(mark, bootAt, boot, saved) ?? fallback;

  const countdowns = new Map(
    snapshot.countdowns.flatMap((row): [DeviceId, Countdown][] => {
      const sensor = sensors.get(row.sensorId);
      if (sensor === undefined) return [];
      return [
        [
          row.sensorId,
          {
            openedAt: at(row.boot, row.openedMono, bootAt),
            deadline: at(row.boot, row.deadlineMono, afterSeconds(bootAt, sensor.countdownS)),
            newestCounter: row.newestCounter,
            replyGateway: row.replyGatewayId ?? undefined,
            replyRate: row.replyRate,
            cause: row.causeSeq,
            restored: true,
          },
        ],
      ];
    }),
  );

  const saved = snapshot.alarm;
  const triggers = new Map(
    snapshot.alarmTriggers.map((row): [DeviceId, Trigger] => [
      row.sensorId,
      { kind: row.kind, at: at(row.boot, row.atMono, bootAt), restored: true },
    ]),
  );
  const alarm: AlarmRun | undefined =
    saved === undefined
      ? undefined
      : {
          startedAt: at(saved.boot, saved.startedMono, bootAt),
          cause: saved.causeSeq,
          triggers,
          sirens: new Map(
            snapshot.alarmSirens.map((row): [DeviceId, AlarmSiren] => [
              row.sirenId,
              {
                until: at(row.boot, row.untilMono, afterSeconds(bootAt, autoStopS)),
                commanded: row.commanded,
                // A siren never seen sounding is sounded by the correction rule: the alarm was
                // never heard, so sounding it cannot re-trigger one that ended (D80).
                restore: row.commanded ? "awaitReport" : "check",
              },
            ]),
          ),
          quietEnd: afterSeconds(
            mono(Math.max(bootAt, ...[...triggers.values()].map((t) => t.at))),
            autoStopS,
          ),
        };

  const next: AlarmSlice = {
    ...slice,
    boot: event.boot.id,
    bootAt,
    autoStopS,
    countdownDefaultS,
    sensors,
    countdowns,
    alarm,
    tests: new Map(),
    downtimeJudged: countdowns.size === 0 && alarm === undefined,
  };
  return ok({ slice: next, out: restoredRows(next) });
}

/** Every countdown and alarm row of the slice, written now with this boot's id. */
function restoredRows(slice: AlarmSlice): Out {
  const run = slice.alarm;
  return [
    ...[...slice.countdowns].map(([sensor, countdown]) => countdownRow(slice, sensor, countdown)),
    ...(run === undefined
      ? []
      : [
          writeNow({
            table: "alarm",
            op: "upsert",
            row: { boot: slice.boot, startedMono: run.startedAt, causeSeq: run.cause },
          }),
          ...[...run.triggers].flatMap(([sensor, t]) => triggerRow(slice, sensor, t.kind, t.at)),
          ...[...run.sirens].flatMap(([siren, entry]) => sirenRow(slice, siren, entry)),
        ]),
  ];
}

/**
 * The downtime became known (section 5, D113): everything restored moves back by it and is judged
 * again, once. A countdown that ran out while the hub was down sounds the sirens for what is left
 * of their time from its end, or only records it (D106's rule); a siren whose report was not
 * believed is sounded for what is left when that is at least the correction threshold.
 */
export function onDowntimeKnown(slice: AlarmSlice, ctx: Context, downtimeMs: number): Changing {
  if (slice.downtimeJudged) return unchanged(slice);
  const back = (at: Mono): Mono => mono(at - downtimeMs * MICROS_PER_MILLISECOND);
  const now = ctx.now.mono;
  const minLeft = ctx.deps.rules.sirens.correctionMinLeftMs * MICROS_PER_MILLISECOND;
  const run = slice.alarm;
  const shifted: AlarmRun | undefined =
    run === undefined
      ? undefined
      : {
          ...run,
          startedAt: back(run.startedAt),
          quietEnd: back(run.quietEnd),
          triggers: new Map(
            [...run.triggers].map(([sensor, t]): [DeviceId, Trigger] => [
              sensor,
              t.restored ? { ...t, at: back(t.at), restored: false } : t,
            ]),
          ),
          sirens: new Map(
            [...run.sirens].map(([siren, entry]): [DeviceId, AlarmSiren] => {
              if (entry.restore === "fresh") return [siren, entry];
              const until = back(entry.until);
              return [
                siren,
                { ...entry, until, restore: judgedRestore(entry, until, now, minLeft) },
              ];
            }),
          ),
        };
  const resounded: Internal[] =
    run === undefined || shifted === undefined
      ? []
      : [...shifted.sirens]
          .filter(
            ([siren, entry]) =>
              run.sirens.get(siren)?.restore === "cutShort" && entry.restore === "fresh",
          )
          .map(([siren, entry]) => ({
            kind: "sirenIntent",
            siren,
            should: { kind: "sound", until: entry.until },
            cause: shifted.cause,
          }));
  const judged: AlarmSlice = { ...slice, alarm: shifted, downtimeJudged: true };
  const start = ok({
    slice: judged,
    out: [...restoredAlarmRows(judged), ...resounded],
  });
  const restored = [...slice.countdowns].filter(([, countdown]) => countdown.restored);
  return then(start, (current) =>
    each(current, restored, (s, [sensor, countdown]) => {
      const moved: Countdown = {
        ...countdown,
        openedAt: back(countdown.openedAt),
        deadline: back(countdown.deadline),
        restored: false,
      };
      if (moved.deadline > now) {
        const next = { ...s, countdowns: new Map(s.countdowns).set(sensor, moved) };
        return ok({ slice: next, out: [countdownRow(next, sensor, moved)] });
      }
      const countdowns = new Map(s.countdowns);
      countdowns.delete(sensor);
      const removed = ok({
        slice: { ...s, countdowns },
        out: [writeNow({ table: "countdowns", op: "delete", key: { sensorId: sensor } })],
      });
      return then(removed, (r) =>
        judgeEnded(r, ctx, {
          sensor,
          opened: moved.openedAt,
          end: moved.deadline,
          cause: moved.cause,
          kind: AlarmTriggerKind.CountdownEnd,
        }),
      );
    }),
  );
}

/**
 * A restored siren once the downtime is known: one cut short is sounded again (`fresh`) when what
 * is left reaches the correction threshold; every other is left to the correction rule (`check`).
 */
function judgedRestore(entry: AlarmSiren, until: Mono, now: Mono, minLeft: number): SirenRestore {
  if (entry.restore !== "cutShort") return "check";
  return until - now >= minLeft ? "fresh" : "cutShort";
}

/** The alarm's rows after a re-judgement. */
function restoredAlarmRows(slice: AlarmSlice): Out {
  return restoredRows({ ...slice, countdowns: new Map() });
}

/**
 * A siren of a restored alarm is heard from (section 5, D80, D113). One that reports sounding is
 * believed and adopted, not commanded again; with the downtime unknown its time left becomes what
 * the alarm expects of it. One that reports off, or sent Started after a power-on, while the
 * downtime is unknown is left off, and the alarm may have been cut short (critical). A siren seen
 * sounding for the first time in an alarm is marked commanded, now.
 */
export function onSirenHeard(slice: AlarmSlice, ctx: Context, accepted: Accepted): Changing {
  const run = slice.alarm;
  const entry = run?.sirens.get(accepted.device);
  if (run === undefined || entry === undefined || !accepted.newest) return unchanged(slice);
  const { message } = accepted;
  const report = message.type === MessageType.SirenReport ? message : undefined;
  const sounding = report?.state === SirenState.SoundingAlarm;
  const silent =
    report?.state === SirenState.Off ||
    report?.state === SirenState.Testing ||
    (message.type === MessageType.Started && message.resetCause === RESET_CAUSE_POWER_ON);
  const now = ctx.now.mono;
  const update = (next: AlarmSiren): AlarmSlice => ({
    ...slice,
    alarm: { ...run, sirens: new Map(run.sirens).set(accepted.device, next) },
  });

  if (report !== undefined && sounding && entry.restore !== "fresh") {
    const until =
      entry.restore === "awaitReport" ? afterSeconds(now, report.soundingSecondsLeft) : entry.until;
    const next: AlarmSiren = { until, commanded: true, restore: "fresh" };
    const changed = update(next);
    return decide(ctx, "routine", {
      kind: "siren_adopted",
      device: accepted.device,
      cause: accepted.record,
      value: secondsUntil(now, until),
    }).map((d) => ({
      slice: changed,
      out: [d.message, ...sirenRow(changed, accepted.device, next)],
    }));
  }
  if (sounding && !entry.commanded) {
    const next: AlarmSiren = { ...entry, commanded: true };
    const changed = update(next);
    return ok({ slice: changed, out: sirenRow(changed, accepted.device, next) });
  }
  if (silent && entry.restore === "awaitReport") {
    const changed = update({ ...entry, restore: "cutShort" });
    return decide(ctx, "now", {
      kind: "alarm_may_be_cut_short",
      device: accepted.device,
      cause: accepted.record,
    }).map((d) => ({ slice: changed, out: [d.message] }));
  }
  if (silent && entry.restore === "check") {
    return ok({ slice: update({ ...entry, restore: "fresh" }), out: [] });
  }
  return unchanged(slice);
}
