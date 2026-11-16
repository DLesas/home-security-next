/**
 * Session records (m2-design.md section 3, "Session records", corrected in wave 3; section 4): not
 * one record per session but one `client_sessions` hub event per client per day, info, routine,
 * `{client, sessions, firstMs, lastMs}`. `app` keeps the day's count per client in memory; a
 * connection adds a session, its close moves `lastMs`; nothing here is written now, so a connect,
 * a close, a snapshot or a subscription never causes a commit of its own (section 3's budget).
 *
 * The day is the hub's local date, in its time zone (`schedules`' view; UTC until the shell has
 * given one). The design writes the day's records "at local midnight in the hub's zone and at a
 * clean stop". FROZEN-CHANGE: the model gives `app` no timer (`TimerKey` has no `app` kind) and the
 * core no clean-stop input, so the records are written at the first input of the new local day
 * (inputs come every few seconds on a working hub: heartbeats, statuses, ticks), and a clean stop
 * loses the day's count as a crash does. A restart in the middle of a day starts the count again:
 * the sessions before it are lost (section 3 accepts it: `clients.last_seen_ms` makes it good),
 * those after it are written at the day's end; nothing is ever counted twice.
 */
import type { Result } from "neverthrow";
import { ok } from "neverthrow";
import { EVERY_DAY } from "../model/calendar.ts";
import type { CoreFault } from "../model/errors.ts";
import type { Context } from "../model/handler.ts";
import type { ClientId } from "../model/ids.ts";
import type { Internal } from "../model/messages.ts";
import { hubEventRecord } from "../registry/view.ts";
import { timeZone } from "../schedules/view.ts";
import type { Sending } from "./events.ts";
import type { ClientDay } from "./state.ts";

/** The hub's local date of a wall instant, as `YYYY-MM-DD`. */
function localDate(ctx: Context, wallMs: number): string {
  const { date } = ctx.deps.calendar.local(wallMs, timeZone(ctx.view) ?? "UTC");
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${two(date.month)}-${two(date.day)}`;
}

/** The day's records, one per client that connected, in client order. */
function dayRecords(
  ctx: Context,
  date: string,
  counts: ReadonlyMap<ClientId, ClientDay>,
): Result<readonly Internal[], CoreFault> {
  const out: Internal[] = [];
  for (const [client, day] of [...counts].toSorted(([a], [b]) => a - b)) {
    const record = hubEventRecord(ctx, {
      level: "info",
      origin: "core/app",
      code: "client_sessions",
      message: `client ${client}: ${day.sessions} sessions on ${date}`,
      detail: JSON.stringify({
        client,
        sessions: day.sessions,
        firstMs: day.firstMs,
        lastMs: day.lastMs,
      }),
      durability: "routine",
    });
    if (record.isErr()) return record.map(() => []);
    out.push(record.value);
  }
  return ok(out);
}

/** The next local midnight after `wallMs`, when the calendar can tell (the real one can). */
function nextMidnight(ctx: Context, wallMs: number): number | undefined {
  const zone = timeZone(ctx.view) ?? "UTC";
  return ctx.deps.calendar.next({ at: { hour: 0, minute: 0 }, days: EVERY_DAY }, zone, wallMs + 1);
}

/** Whether the day the count is for is over: by its midnight, or else by the local date. */
function dayOver(
  ctx: Context,
  day: { readonly date: string; readonly endsMs: number | undefined },
) {
  return day.endsMs === undefined
    ? localDate(ctx, ctx.now.wall) !== day.date
    : ctx.now.wall >= day.endsMs;
}

/** At the first message of a new local day: the last day's records, and an empty count. */
export function closeDayIfOver(sending: Sending, ctx: Context): Result<void, CoreFault> {
  const day = sending.slice.sessionDay;
  if (day === undefined || !dayOver(ctx, day)) return ok(undefined);
  sending.slice = { ...sending.slice, sessionDay: undefined };
  return dayRecords(ctx, day.date, day.counts).map((records) => {
    sending.out.push(...records);
  });
}

/** A session proven (`clientConnected`): one more for its client today. */
export function sessionOpened(sending: Sending, ctx: Context, client: ClientId): void {
  const day = sending.slice.sessionDay ?? {
    date: localDate(ctx, ctx.now.wall),
    endsMs: nextMidnight(ctx, ctx.now.wall),
    counts: new Map<ClientId, ClientDay>(),
  };
  const counts = new Map(day.counts);
  const was = counts.get(client);
  counts.set(client, {
    sessions: (was?.sessions ?? 0) + 1,
    firstMs: was?.firstMs ?? ctx.now.wall,
    lastMs: ctx.now.wall,
  });
  sending.slice = { ...sending.slice, sessionDay: { ...day, counts } };
}

/** A session closed: its client's last moment today moves. */
export function sessionClosed(sending: Sending, ctx: Context, client: ClientId): void {
  const day = sending.slice.sessionDay;
  const was = day?.counts.get(client);
  if (day === undefined || was === undefined) return;
  const counts = new Map(day.counts);
  counts.set(client, { ...was, lastMs: Math.max(was.lastMs, ctx.now.wall) });
  sending.slice = { ...sending.slice, sessionDay: { ...day, counts } };
}
