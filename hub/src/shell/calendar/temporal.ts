/**
 * The part of the Temporal API the calendar uses (m2-design.md section 2, "Calendar arithmetic is
 * a dependency"; stack.md, "Schedules": "the Temporal API, built in or polyfilled"), typed here
 * rather than through TypeScript's `esnext.temporal` library, which would declare `Temporal` for
 * the whole program, the core included: the core must not be able to reach a clock
 * (`Temporal.Now`) or a time-zone database except through `deps.calendar`.
 *
 * The runtime's built-in Temporal (Bun 1.4.2), as section 11 settles it; no polyfill. The
 * calendar takes the API as a parameter (`temporalCalendar`) all the same.
 */
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";

/** A plain calendar date. */
export interface TemporalPlainDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** 1 Monday to 7 Sunday (ISO 8601). */
  readonly dayOfWeek: number;
  add(duration: { readonly days: number }): TemporalPlainDate;
}

/** An instant in a time zone. */
export interface TemporalZonedDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
  readonly offsetNanoseconds: number;
  readonly epochMilliseconds: number;
  toPlainDate(): TemporalPlainDate;
  /** The zone's next or previous change of offset, or null when there is none. */
  getTimeZoneTransition(direction: "next" | "previous"): TemporalZonedDateTime | null;
}

/** An exact instant. */
export interface TemporalInstant {
  toZonedDateTimeISO(timeZone: string): TemporalZonedDateTime;
}

/** The three constructors the calendar needs. */
export interface TemporalApi {
  readonly Instant: { fromEpochMilliseconds(ms: number): TemporalInstant };
  readonly ZonedDateTime: {
    from(
      fields: {
        readonly year: number;
        readonly month: number;
        readonly day: number;
        readonly hour: number;
        readonly minute: number;
        readonly timeZone: string;
      },
      options: { readonly disambiguation: "earlier"; readonly overflow: "reject" },
    ): TemporalZonedDateTime;
  };
  readonly PlainDate: {
    from(
      fields: { readonly year: number; readonly month: number; readonly day: number },
      options: { readonly overflow: "constrain" },
    ): TemporalPlainDate;
  };
}

function hasMember(value: object, name: string): boolean {
  const member: unknown = Reflect.get(value, name);
  return (typeof member === "function" || typeof member === "object") && member !== null;
}

/** The runtime's own Temporal, or an error when it has none. */
export function builtInTemporal(): Result<TemporalApi, HubError> {
  const value: unknown = Reflect.get(globalThis, "Temporal");
  if (
    typeof value === "object" &&
    value !== null &&
    hasMember(value, "Instant") &&
    hasMember(value, "ZonedDateTime") &&
    hasMember(value, "PlainDate")
  ) {
    // Checked above for the three constructors this file declares.
    return ok(value as TemporalApi);
  }
  return err({
    kind: "config",
    origin: "shell/calendar",
    message: "this runtime has no Temporal API: schedules cannot be computed",
  });
}
