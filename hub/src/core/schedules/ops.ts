/**
 * The schedule operations (m2-design.md section 6: `schedule.create`, `schedule.update`,
 * `schedule.delete`, owner schedules by `OP_OWNERS`), as an `opRequest` from control or app,
 * which have already checked the shape, the client, its `seq` and *manage system* (section 2,
 * "Requests for M1a's modules"; section 5). Here: that the target fits the action and names a
 * sensor that exists, the revision (`ifRevision`, `conflict` with the entry as it is now, section
 * 5), the row written now, and the reply: the entry with its next time.
 *
 * A changed entry keeps its last run: it still runs at most once per local date (section 7), so
 * an entry that ran at 07:00 and is moved to 09:00 the same day next runs tomorrow.
 *
 * A target mode or group must exist (layout's view), as a sensor must (registry's): otherwise
 * `invalid`, `unknownReference` (section 11, "Step 1's questions, settled"). Layout refuses to
 * delete a mode or group an entry names, through `schedulesNaming` in this module's view.
 */
import { Role } from "@hsn/protocol";
import type { AppError, AppOp, AppOpBody } from "@hsn/protocol/app";
import { ok } from "neverthrow";
import { groupById, modeById } from "../layout/view.ts";
import { deviceById, isNamed } from "../registry/view.ts";
import type { Context } from "../model/handler.ts";
import { deviceId, groupId, modeId, scheduleId, type ScheduleId } from "../model/ids.ts";
import type { Actor, Internal, OpOutcome } from "../model/messages.ts";
import { ScheduleAction, type ScheduleRow } from "../model/rows.ts";
import { type Acc, deleteRow, emit, type Step, withEntry, withSlice, writeRow } from "./acc.ts";
import { warnWaiting } from "./clock.ts";
import { bitsOfWeekdays, dateOfText, daysFromCivil, minutesOfText } from "./days.ts";
import { nextAfter, scheduleObjectOf } from "./entries.ts";
import type { Entry } from "./state.ts";

type Request = Extract<Internal, { readonly kind: "opRequest" }>;
type Fields = AppOpBody<"schedule.create">;
/** A row's last miss: kept by an update, none for a new entry. */
type Missed = "missedDueMs" | "missedWhy" | "missedCount";

const ACTIONS = {
  switchMode: ScheduleAction.SwitchMode,
  arm: ScheduleAction.Arm,
  disarm: ScheduleAction.Disarm,
} as const satisfies Record<Fields["action"], ScheduleAction>;

function invalid(field: string, reason: "format" | "unknownReference"): AppError {
  return { code: "invalid", detail: { field, reason } };
}

function answer(request: Request, outcome: OpOutcome): Internal {
  return { kind: "opAnswer", answerTo: request.answerTo, outcome };
}

function refused(acc: Acc, request: Request, error: AppError): Step {
  return ok(emit(acc, answer(request, { ok: false, error })));
}

function actorName(actor: Actor): string {
  return actor.kind === "console" ? `console (client ${actor.client})` : actor.name;
}

/** The columns a create or update sets, or why the body cannot be stored. */
function columnsOf(
  ctx: Context,
  body: Fields,
):
  | Omit<ScheduleRow, "id" | "createdBy" | "lastRunMs" | "lastRunLocalDate" | Missed | "revision">
  | AppError {
  const action = ACTIONS[body.action];
  const { target } = body;
  let modeIdOf: ScheduleRow["modeId"] = null;
  let groupIdOf: ScheduleRow["groupId"] = null;
  let sensorIdOf: ScheduleRow["sensorId"] = null;
  if (action === ScheduleAction.SwitchMode) {
    if (!("mode" in target)) return invalid("target", "format");
    if (modeById(ctx.view, modeId(target.mode)) === undefined) {
      return invalid("target.mode", "unknownReference");
    }
    modeIdOf = modeId(target.mode);
  } else if ("mode" in target) {
    return invalid("target", "format");
  } else if ("group" in target) {
    if (groupById(ctx.view, groupId(target.group)) === undefined) {
      return invalid("target.group", "unknownReference");
    }
    groupIdOf = groupId(target.group);
  } else {
    const device = deviceById(ctx.view, deviceId(target.sensor));
    if (device?.role !== Role.Sensor || !isNamed(device.state)) {
      return invalid("target.sensor", "unknownReference");
    }
    sensorIdOf = device.id;
  }
  const localTime = minutesOfText(body.at);
  if (localTime === undefined) return invalid("at", "format");
  let days = 0;
  let date: number | null = null;
  if (typeof body.days === "object" && "date" in body.days) {
    const parsed = dateOfText(body.days.date);
    if (parsed === undefined) return invalid("days.date", "format");
    date = daysFromCivil(parsed);
  } else {
    days = body.days === "everyDay" ? 0b111_1111 : bitsOfWeekdays(body.days);
  }
  return {
    name: body.name,
    action,
    modeId: modeIdOf,
    groupId: groupIdOf,
    sensorId: sensorIdOf,
    localTime,
    days,
    date,
    enabled: body.enabled,
  };
}

function isError(value: object): value is AppError {
  return "code" in value;
}

/** The entry with its next time, as the module finds it while it runs. */
function placed(acc: Acc, ctx: Context, row: ScheduleRow): Entry {
  const running = acc.slice.anchor !== undefined;
  return {
    row,
    dueMs: running ? nextAfter(ctx.deps.calendar, row, acc.slice.zone, ctx.now.wall) : undefined,
  };
}

function stored(acc: Acc, ctx: Context, request: Request, entry: Entry): Step {
  const next = emit(
    withSlice(acc, withEntry(acc.slice, entry)),
    writeRow(entry.row),
    answer(request, { ok: true, body: scheduleObjectOf(entry) }),
  );
  return warnWaiting(next, ctx);
}

function create(acc: Acc, ctx: Context, request: Request, body: Fields): Step {
  const columns = columnsOf(ctx, body);
  if (isError(columns)) return refused(acc, request, columns);
  const id = scheduleId(acc.slice.nextId);
  const row: ScheduleRow = {
    id,
    ...columns,
    createdBy: actorName(request.actor),
    lastRunMs: null,
    lastRunLocalDate: null,
    missedDueMs: null,
    missedWhy: null,
    missedCount: 0,
    revision: 1,
  };
  const entry = placed(acc, ctx, row);
  return stored(withSlice(acc, { ...acc.slice, nextId: id + 1 }), ctx, request, entry);
}

/** The entry an update or delete names, or the refusal: `notFound`, or `conflict` (section 5). */
function existing(
  acc: Acc,
  schedule: number,
  ifRevision: number,
): { readonly entry: Entry } | { readonly error: AppError } {
  const entry = acc.slice.entries.get(scheduleId(schedule));
  if (entry === undefined)
    return { error: { code: "notFound", detail: { what: "schedule", id: schedule } } };
  if (entry.row.revision !== ifRevision) {
    return {
      error: {
        code: "conflict",
        detail: { revision: entry.row.revision, object: scheduleObjectOf(entry) },
      },
    };
  }
  return { entry };
}

function update(
  acc: Acc,
  ctx: Context,
  request: Request,
  body: AppOpBody<"schedule.update">,
): Step {
  const found = existing(acc, body.schedule, body.ifRevision);
  if ("error" in found) return refused(acc, request, found.error);
  const columns = columnsOf(ctx, body);
  if (isError(columns)) return refused(acc, request, columns);
  const row: ScheduleRow = {
    ...found.entry.row,
    ...columns,
    revision: found.entry.row.revision + 1,
  };
  return stored(acc, ctx, request, placed(acc, ctx, row));
}

function remove(acc: Acc, request: Request, body: AppOpBody<"schedule.delete">): Step {
  const found = existing(acc, body.schedule, body.ifRevision);
  if ("error" in found) return refused(acc, request, found.error);
  const id: ScheduleId = found.entry.row.id;
  const entries = new Map(acc.slice.entries);
  entries.delete(id);
  return ok(
    emit(
      withSlice(acc, { ...acc.slice, entries }),
      deleteRow(id),
      answer(request, { ok: true, body: {} }),
    ),
  );
}

/** An operation this module owns. */
export function onOpRequest(acc: Acc, ctx: Context, request: Request): Step {
  const op: AppOp = request.op;
  switch (op.op) {
    case "schedule.create":
      return create(acc, ctx, request, op.body);
    case "schedule.update":
      return update(acc, ctx, request, op.body);
    case "schedule.delete":
      return remove(acc, request, op.body);
    default:
      // OP_OWNERS gives schedules these three only.
      return refused(acc, request, invalid("op", "format"));
  }
}
