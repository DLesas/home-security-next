/**
 * The audit module's handler (hub-design.md section 2, module 13; sections 5, 6 and 10). It runs
 * last for every message.
 *
 * - Records: every `auditRecord` becomes a `record` effect, with the warning cap applied
 *   (section 5).
 * - Rejections: counted per source, reason and minute (HB15), each count a full-value upsert
 *   of its `rejects` row, routine.
 * - The start: a `restarted` hub event with how the last run ended and its cause, and, after an
 *   end that was not clean, that records after the last commit may be missing (HB34).
 * - Commits: a failed flush is a critical hub event; a recovery an info one (section 10).
 * - Retention: a round every 10 minutes ‡ while the wall clock is trusted (section 6).
 * - The record sequence: after every message it keeps the cursor's position, so no number a
 *   module took in this step is handed out again in the next (section 2).
 */
import { err, ok, type Result } from "neverthrow";
import type { AuditRecord } from "../model/audit.ts";
import type { Effect } from "../model/effects.ts";
import type { CoreFault } from "../model/errors.ts";
import type { DurableSnapshot, BootInfo, CommitOutcome, InputRejection } from "../model/events.ts";
import type { Context, Handled, Handler } from "../model/handler.ts";
import { HUB_DEVICE } from "../model/ids.ts";
import type { Internal, RejectSource } from "../model/messages.ts";
import type { HubEventLevel, HubEventRow, RejectRow } from "../model/rows.ts";
import type { Durability } from "../model/store.ts";
import type { RejectReason } from "../model/errors.ts";
import { monoAfterMs } from "../model/time.ts";
import { recordStamp, wallTrusted } from "../clock/view.ts";
import { cap, warningSource } from "./cap.ts";
import { retentionRound } from "./retention.ts";
import {
  type AuditSlice,
  D57_EVENT_DAYS,
  D57_ROUTINE_DAYS,
  EMPTY_AUDIT_SLICE,
  NOT_TRIMMING,
} from "./state.ts";

const ORIGIN = "core/audit";
/** Where commit failures arise (section 10). */
const WRITER_ORIGIN = "shell/storage/writer";
const MINUTE_MS = 60_000;
/** `rejects.sample` keeps the first rejected packet's first 16 bytes (section 6). */
const REJECT_SAMPLE_BYTES = 16;

type Out = (Internal | Effect)[];
type Step = Result<Handled<"audit">, CoreFault>;

function recordEffect(durability: Durability, record: AuditRecord): Effect {
  return { kind: "record", durability, record };
}

/** A hub event of this input, with the next sequence number, as a `record` effect. */
function hubEvent(
  ctx: Context,
  level: HubEventLevel,
  origin: string,
  code: string,
  message: string,
  detail: Readonly<Record<string, string | number | boolean | null>> | null,
): Result<AuditRecord, CoreFault> {
  return ctx.records.take().map((seq): AuditRecord => {
    const row: HubEventRow = {
      seq,
      ...recordStamp(ctx.view, ctx.now),
      level,
      origin,
      code,
      message,
      detail: detail === null ? null : JSON.stringify(detail),
    };
    return { kind: "hubEvent", row };
  });
}

/** Warnings and worse are written now, the rest with the routine batch (section 5). */
function durabilityOf(level: HubEventLevel): Durability {
  return level === "warning" || level === "critical" ? "now" : "routine";
}

/**
 * A record stamped with the time and trust the clock gives (section 6): `at_ms` never decreases,
 * and `clock_ok` says whether the wall clock was trusted. Every record passes here, so modules
 * need not stamp their own; a command's row keeps the stamp it took on arrival. A rejection count has no time of its own but its minute.
 */
function stamped(record: AuditRecord, ctx: Context): AuditRecord {
  if (record.kind === "reject") return record;
  const stamp = recordStamp(ctx.view, ctx.now);
  switch (record.kind) {
    case "rx":
      return { ...record, row: { ...record.row, ...stamp } };
    case "tx":
      return { ...record, row: { ...record.row, ...stamp } };
    case "decision":
      return { ...record, row: { ...record.row, ...stamp } };
    case "deviceLog":
      return { ...record, row: { ...record.row, ...stamp } };
    case "hubEvent":
      return { ...record, row: { ...record.row, ...stamp } };
    case "command":
      // Numbered and stamped by control when the command arrived, written when it was answered:
      // its own time keeps `seq` in time order (section 6).
      return record;
  }
}

/** Passes a record on, stamped, capping warnings written now per source and hour (section 5). */
function onRecord(
  slice: AuditSlice,
  unstamped: AuditRecord,
  durability: Durability,
  ctx: Context,
): Step {
  const record = stamped(unstamped, ctx);
  const source = warningSource(record);
  if (source === undefined) return ok({ slice, out: [recordEffect(durability, record)] });
  const capped = cap(
    slice.warnings.get(source),
    durability,
    ctx.now.mono,
    ctx.deps.rules.persistence.warningsPerHourPerSource,
  );
  const warnings = new Map(slice.warnings);
  if (capped.window !== undefined) warnings.set(source, capped.window);
  const out: Out = [recordEffect(capped.durability, record)];
  if (capped.reached) {
    const notice = hubEvent(
      ctx,
      "warning",
      ORIGIN,
      "warning_cap_reached",
      `more than ${ctx.deps.rules.persistence.warningsPerHourPerSource} warnings within an hour from ${source}; the rest of the hour's go with the routine batch`,
      { source },
    );
    if (notice.isErr()) return err(notice.error);
    out.push(recordEffect("now", notice.value));
  }
  return ok({ slice: { ...slice, warnings }, out });
}

/** `rejects.via`: the gateway, or the link by its label when no device is known (section 6). */
function viaOf(slice: AuditSlice, source: RejectSource): string {
  if ("device" in source) return `device:${source.device}`;
  return `link:${slice.links.get(source.link) ?? `#${source.link}`}`;
}

/** Counts one rejection into its source's and reason's row of this minute (HB15). */
function onRejected(
  slice: AuditSlice,
  rejected: {
    readonly source: RejectSource;
    readonly reason: RejectReason;
    readonly address: number | undefined;
    readonly sample: Uint8Array;
  },
  ctx: Context,
): Step {
  const minute = Math.floor(recordStamp(ctx.view, ctx.now).atMs / MINUTE_MS);
  const counts = slice.rejectMinute === minute ? slice.rejects : new Map<string, RejectRow>();
  const via = viaOf(slice, rejected.source);
  const key = `${via}|${rejected.reason}`;
  const earlier = counts.get(key);
  const row: RejectRow =
    earlier === undefined
      ? {
          minute,
          via,
          reason: rejected.reason,
          count: 1,
          address: rejected.address ?? null,
          sample: rejected.sample.slice(0, REJECT_SAMPLE_BYTES),
        }
      : { ...earlier, count: earlier.count + 1 };
  const rejects = new Map(counts);
  rejects.set(key, row);
  return ok({
    slice: { ...slice, rejectMinute: minute, rejects },
    out: [recordEffect("routine", { kind: "reject", row })],
  });
}

/** The `restarted` event (section 10, "The top-level handler"; HB34). */
function restarted(
  snapshot: DurableSnapshot,
  boot: BootInfo,
  ctx: Context,
): Result<Effect, CoreFault> {
  if (snapshot.previousBoot === undefined) {
    return hubEvent(
      ctx,
      "info",
      ORIGIN,
      "first_start",
      "the hub started for the first time",
      null,
    ).map((record) => recordEffect("routine", record));
  }
  const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
  const cause = boot.cause ?? null;
  if (boot.previousExit === "clean") {
    return hubEvent(ctx, "info", ORIGIN, "restarted", "restarted after a clean stop", {
      previousExit: "clean",
      cause,
    }).map((record) => recordEffect("routine", record));
  }
  const how =
    boot.previousExit === "crash"
      ? `a crash (${cause ?? "no cause recorded"})`
      : "a stop that was not clean: a power cut or a kill";
  const after =
    mark === undefined
      ? "the previous start"
      : `${mark.lastSeenMs} ms${mark.clockOk ? "" : " (an untrusted wall time)"}`;
  const level: HubEventLevel = "warning";
  return hubEvent(
    ctx,
    level,
    ORIGIN,
    "restarted",
    `restarted after ${how}; records after ${after} may be missing`,
    {
      previousExit: boot.previousExit,
      cause,
      missingAfterMs: mark?.lastSeenMs ?? null,
      missingAfterTrusted: mark?.clockOk ?? false,
    },
  ).map((record) => recordEffect(durabilityOf(level), record));
}

function onBoot(snapshot: DurableSnapshot, boot: BootInfo, ctx: Context): Step {
  const site = snapshot.site;
  const slice: AuditSlice = {
    ...EMPTY_AUDIT_SLICE,
    boot: boot.id,
    retention: {
      routineDays: site?.retentionRoutineDays ?? D57_ROUTINE_DAYS,
      eventDays: site?.retentionEventDays ?? D57_EVENT_DAYS,
    },
    timers: [
      {
        at: monoAfterMs(ctx.now.mono, ctx.deps.rules.retention.everyMs),
        key: { module: "audit", kind: "retention" },
      },
    ],
  };
  return restarted(snapshot, boot, ctx).map((effect) => ({ slice, out: [effect] }));
}

const DAY_MS = 86_400_000;

/** A wall time as ISO 8601 in UTC, without `Date` (the core's time is the input's, section 2). */
function isoUtc(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const inDay = ms - days * DAY_MS;
  // Howard Hinnant's days-to-civil, for the proleptic Gregorian calendar.
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  const two = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(inDay / 3_600_000);
  const minutes = Math.floor((inDay % 3_600_000) / 60_000);
  const seconds = Math.floor((inDay % 60_000) / 1000);
  const millis = String(inDay % 1000).padStart(3, "0");
  return `${String(year).padStart(4, "0")}-${two(month)}-${two(day)}T${two(hours)}:${two(minutes)}:${two(seconds)}.${millis}Z`;
}

function when(ms: number | null): string {
  return ms === null ? "nothing older left" : isoUtc(ms);
}

/** Records one hub event after another, each through `onRecord`. */
function recordAll(
  slice: AuditSlice,
  events: readonly {
    readonly level: HubEventLevel;
    readonly code: string;
    readonly message: string;
    readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  }[],
  ctx: Context,
): Step {
  return events.reduce<Step>(
    (step, e) =>
      step.andThen((done) =>
        hubEvent(ctx, e.level, WRITER_ORIGIN, e.code, e.message, e.detail).andThen((record) =>
          onRecord(done.slice, record, durabilityOf(e.level), ctx).map((next) => ({
            slice: next.slice,
            out: [...done.out, ...next.out],
          })),
        ),
      ),
    ok({ slice, out: [] }),
  );
}

/**
 * The size guard's outcomes (section 6, D110): a warning when trimming starts and once a day
 * while it goes on, a critical event the first time event rows go, a notice when it ends; never
 * one per commit.
 */
function onTrim(slice: AuditSlice, outcome: CommitOutcome, ctx: Context): Step {
  const { history } = slice;
  const day = Math.floor(ctx.now.wall / DAY_MS);
  if (outcome.kind === "trimEnded") {
    if (!history.trimming) return ok({ slice, out: [] });
    return recordAll(
      { ...slice, history: NOT_TRIMMING },
      [
        {
          level: "info",
          code: "history_trim_ended",
          message:
            "history is no longer being shortened: the database is back under its lower mark",
          detail: { inUseBytes: outcome.inUseBytes },
        },
      ],
      ctx,
    );
  }
  if (outcome.kind === "trimExhausted") {
    return recordAll(
      { ...slice, history: { ...history, trimming: true } },
      [
        {
          level: "warning",
          code: "history_trim_exhausted",
          message: "the database is near its limit and nothing more can be trimmed",
          detail: { inUseBytes: outcome.inUseBytes },
        },
      ],
      ctx,
    );
  }
  if (outcome.kind !== "trimmed") return ok({ slice, out: [] });
  const { report } = outcome;
  const detail = {
    routineRows: report.routineRows,
    eventRows: report.eventRows,
    oldestRoutineMs: report.oldestRoutineMs,
    oldestEventMs: report.oldestEventMs,
    inUseBytes: report.inUseBytes,
  };
  const events = [];
  const warnNow = !history.trimming || history.warnedDay === undefined || day > history.warnedDay;
  if (warnNow) {
    events.push({
      level: "warning" as const,
      code: "history_shortened",
      message: `history shortened to stay within the disk limit; routine history now starts at ${when(report.oldestRoutineMs)}`,
      detail,
    });
  }
  const eventsNow = report.eventRows > 0 && !history.eventsGone;
  if (eventsNow) {
    events.push({
      level: "critical" as const,
      code: "event_history_shortened",
      message: `event history deleted to stay within the disk limit; event history now starts at ${when(report.oldestEventMs)}`,
      detail,
    });
  }
  const next: AuditSlice = {
    ...slice,
    history: {
      trimming: true,
      warnedDay: warnNow ? day : history.warnedDay,
      eventsGone: history.eventsGone || eventsNow,
    },
  };
  return recordAll(next, events, ctx);
}

function onCommit(slice: AuditSlice, outcome: CommitOutcome, ctx: Context): Step {
  if (
    outcome.kind === "trimmed" ||
    outcome.kind === "trimEnded" ||
    outcome.kind === "trimExhausted"
  )
    return onTrim(slice, outcome, ctx);
  const event =
    outcome.kind === "failed"
      ? hubEvent(
          ctx,
          "critical",
          WRITER_ORIGIN,
          "commit_failed",
          `a commit failed: ${outcome.message}`,
          null,
        )
      : hubEvent(ctx, "info", WRITER_ORIGIN, "commit_recovered", "commits work again", null);
  if (event.isErr()) return err(event.error);
  const level = outcome.kind === "failed" ? "critical" : "info";
  return onRecord(slice, event.value, durabilityOf(level), ctx);
}

/** A fault the loop handed back (section 10): a critical hub event, written now. */
function onFault(
  slice: AuditSlice,
  fault: Extract<InputRejection, { readonly source: "core" }>,
  ctx: Context,
): Step {
  const event = hubEvent(ctx, "critical", fault.origin, "core_fault", fault.message, {
    event: fault.event,
    ...fault.detail,
  });
  if (event.isErr()) return err(event.error);
  return onRecord(slice, event.value, durabilityOf("critical"), ctx);
}

/** One retention round, then the next in 10 minutes ‡ (section 6). */
function onRetention(slice: AuditSlice, ctx: Context): Step {
  const { everyMs, rowsPerRound } = ctx.deps.rules.retention;
  const timers = [
    {
      at: monoAfterMs(ctx.now.mono, everyMs),
      key: { module: "audit", kind: "retention" },
    } as const,
  ];
  if (!wallTrusted(ctx.view, ctx.now)) return ok({ slice: { ...slice, timers }, out: [] });
  const { atMs } = recordStamp(ctx.view, ctx.now);
  const out: Out = retentionRound(slice.retention, atMs, rowsPerRound).map((op): Effect => ({
    kind: "write",
    durability: "routine",
    op,
  }));
  return ok({ slice: { ...slice, timers }, out });
}

function handle(slice: AuditSlice, message: Internal, ctx: Context): Step {
  switch (message.kind) {
    case "boot":
      return onBoot(message.snapshot, message.boot, ctx);
    case "auditRecord":
      return onRecord(slice, message.record, message.durability, ctx);
    case "rejected":
      return onRejected(slice, message, ctx);
    case "commit":
      return onCommit(slice, message.outcome, ctx);
    case "inputRejected":
      return message.rejection.source === "core"
        ? onFault(slice, message.rejection, ctx)
        : ok({ slice, out: [] });
    case "linkOpened": {
      const links = new Map(slice.links);
      links.set(message.link, message.label);
      return ok({ slice: { ...slice, links }, out: [] });
    }
    case "linkClosed": {
      const links = new Map(slice.links);
      links.delete(message.link);
      return ok({ slice: { ...slice, links }, out: [] });
    }
    case "timer":
      return message.key.module === "audit" ? onRetention(slice, ctx) : ok({ slice, out: [] });
    default:
      return ok({ slice, out: [] });
  }
}

export const handleAudit: Handler<"audit"> = (slice, message, ctx) =>
  handle(slice, message, ctx).andThen(({ slice: next, out }) =>
    // The cursor's position after this message: no number below it is handed out again. The
    // number probed is not used, and the next step starts from it.
    ctx.records.take().map((nextRecord) => ({
      slice: next === slice && nextRecord === slice.nextRecord ? slice : { ...next, nextRecord },
      out,
    })),
  );
