/**
 * Layer 1's rate tables (docs/m4-design.md section 3, D142, "Memory per connection"): counts per
 * key over a window, held for at most `maxKeys` keys. When the table is full, the keys idle for a
 * whole window are dropped, oldest use first; when none is idle, every unknown key shares one
 * strict bucket (`SHARED_BUCKET`), so a flood of fresh addresses cannot grow the table nor reset
 * anyone's count. Pure: time is an input, nothing here does input or output.
 *
 * Two windows: a sliding one (a minute, an hour, a second), and the UTC day ("a day", as the
 * traffic row has it: until midnight UTC). Only what is let through is counted, so a refused
 * flood does not lengthen its own wait.
 */
import { untilNextUtcDay, utcDay } from "./time.ts";

/** The bucket every unknown key shares while a table is full. */
export const SHARED_BUCKET = "*shared*";

/** Taken, or refused with how long until the same take would pass. */
export type Take = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

const TAKEN: Take = { ok: true };

/**
 * At most `limit` takes per key in any `windowMs`: the times of the takes still inside the
 * window, oldest first.
 */
export class SlidingRate {
  private readonly table = new Map<string, number[]>();
  private shared: number[] = [];

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly maxKeys: number,
  ) {}

  private bucket(key: string, nowMs: number): string {
    if (this.table.has(key) || this.table.size < this.maxKeys) return key;
    // Ordered by last use: the first is the idlest. Drop those idle for a whole window.
    for (const [old, times] of this.table) {
      const newest = times[times.length - 1] ?? 0;
      if (newest > nowMs - this.windowMs) break;
      this.table.delete(old);
      if (this.table.size < this.maxKeys) break;
    }
    return this.table.size < this.maxKeys ? key : SHARED_BUCKET;
  }

  private live(times: readonly number[], nowMs: number): number[] {
    const from = times.findIndex((t) => t > nowMs - this.windowMs);
    return from === -1 ? [] : times.slice(from);
  }

  /** One take for `key` at `nowMs`. */
  take(key: string, nowMs: number): Take {
    const bucket = this.bucket(key, nowMs);
    const times = this.live(
      bucket === SHARED_BUCKET ? this.shared : (this.table.get(bucket) ?? []),
      nowMs,
    );
    const answer: Take =
      times.length >= this.limit
        ? { ok: false, retryAfterMs: (times[0] ?? nowMs) + this.windowMs - nowMs }
        : TAKEN;
    if (answer.ok) times.push(nowMs);
    if (bucket === SHARED_BUCKET) {
      this.shared = times;
    } else {
      // Re-inserted, so the table's order is by last use.
      this.table.delete(bucket);
      this.table.set(bucket, times);
    }
    return answer;
  }

  /** Keys held, for the tests. */
  get size(): number {
    return this.table.size;
  }
}

/**
 * At most `budget` per key per UTC day, each take of `amount` (bytes, files, identities). A take
 * that would pass the budget is refused whole, until midnight UTC.
 */
export class DayBudget {
  private readonly table = new Map<string, { day: number; used: number }>();
  private shared = { day: -1, used: 0 };

  constructor(readonly maxKeys: number) {}

  private bucket(key: string, today: number): string {
    if (this.table.has(key) || this.table.size < this.maxKeys) return key;
    for (const [old, entry] of this.table) {
      if (entry.day >= today) break;
      this.table.delete(old);
      if (this.table.size < this.maxKeys) break;
    }
    return this.table.size < this.maxKeys ? key : SHARED_BUCKET;
  }

  private entry(bucket: string, today: number): { day: number; used: number } {
    const held = bucket === SHARED_BUCKET ? this.shared : this.table.get(bucket);
    return held?.day === today ? held : { day: today, used: 0 };
  }

  /** Whether `amount` more fits `budget` for `key` today, without taking it. */
  check(key: string, nowMs: number, amount: number, budget: number): Take {
    const today = utcDay(nowMs);
    const entry = this.entry(this.bucket(key, today), today);
    return entry.used + amount > budget
      ? { ok: false, retryAfterMs: untilNextUtcDay(nowMs) }
      : TAKEN;
  }

  /** Takes `amount` for `key` today if it fits `budget`. */
  take(key: string, nowMs: number, amount: number, budget: number): Take {
    const today = utcDay(nowMs);
    const bucket = this.bucket(key, today);
    const entry = this.entry(bucket, today);
    if (entry.used + amount > budget) return { ok: false, retryAfterMs: untilNextUtcDay(nowMs) };
    const next = { day: today, used: entry.used + amount };
    if (bucket === SHARED_BUCKET) {
      this.shared = next;
    } else {
      this.table.delete(bucket);
      this.table.set(bucket, next);
    }
    return TAKEN;
  }

  /** What `key` has used today. */
  used(key: string, nowMs: number): number {
    const held = this.table.get(key);
    return held?.day === utcDay(nowMs) ? held.used : 0;
  }

  /** Keys held, for the tests. */
  get size(): number {
    return this.table.size;
  }
}

/** Counts of things open now (connections, streams), per key and in all. Entries at zero go. */
export class OpenCounts {
  private readonly table = new Map<string, number>();
  private all = 0;

  /** Whether one more fits `perKey` for `key` (null: counted in all only) and `inAll`. */
  fits(key: string | null, perKey: number, inAll: number): boolean {
    if (this.all >= inAll) return false;
    return key === null || (this.table.get(key) ?? 0) < perKey;
  }

  add(key: string | null): void {
    this.all += 1;
    if (key !== null) this.table.set(key, (this.table.get(key) ?? 0) + 1);
  }

  remove(key: string | null): void {
    this.all = Math.max(0, this.all - 1);
    if (key === null) return;
    const left = (this.table.get(key) ?? 1) - 1;
    if (left <= 0) this.table.delete(key);
    else this.table.set(key, left);
  }

  of(key: string): number {
    return this.table.get(key) ?? 0;
  }

  get total(): number {
    return this.all;
  }

  /** Keys held: only keys with something open, so bounded by what is open. */
  get size(): number {
    return this.table.size;
  }
}
