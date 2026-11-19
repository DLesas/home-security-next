/**
 * The writer's staged batch (hub-design.md section 5, "The commit mechanism"). Records are kept
 * in order. Writes to one row are kept by row: a later write of the row replaces the earlier one
 * and moves to its place in the order, so a reading updated ten times in five minutes is written
 * once, and the last write of every row still lands after everything staged before it. The
 * rejection count of one source, reason and minute, and each table's retention delete, fold the
 * same way. An item folded into one that was written "now" stays "now".
 */
import type { AuditRecord } from "../../core/model/audit.ts";
import type {
  Durability,
  StateTable,
  StateTableKeys,
  StateTables,
  StoreOp,
} from "../../core/model/store.ts";
import type { Mono } from "../../core/model/time.ts";
import type { StagedEffect } from "../../ports/writer.ts";
import { STATE_SPECS } from "./tables.ts";

/** Fixed cost of an item in the size estimate: the row's header and key, about 16 bytes (section 6). */
const ITEM_OVERHEAD_BYTES = 16;
/** An integer column is stored in at most 8 bytes. */
const NUMBER_BYTES = 8;

/** An estimate of the bytes a value takes in a row, for the 512 KB ‡ flush limit (section 5). */
function valueBytes(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof value === "string") return value.length;
  if (typeof value === "number") return NUMBER_BYTES;
  return 1;
}

function rowBytes(row: object | undefined): number {
  if (row === undefined) return ITEM_OVERHEAD_BYTES;
  return Object.values(row).reduce<number>(
    (sum, value) => sum + valueBytes(value),
    ITEM_OVERHEAD_BYTES,
  );
}

/** The key that names one row of a state table, as one string. */
function stateKey<T extends StateTable>(table: T, key: StateTableKeys[T] | StateTables[T]): string {
  const values = STATE_SPECS[table].key.map((column) =>
    key === undefined ? "" : String((key as Readonly<Record<string, unknown>>)[column.prop]),
  );
  return `${table}|${values.join("|")}`;
}

function opKey(op: StoreOp): string {
  switch (op.op) {
    case "upsert":
      return stateKey(op.table, op.row);
    case "delete":
      return stateKey(op.table, op.key);
    case "prune":
      return `prune|${op.table}|${"levels" in op ? op.levels.join(",") : ""}`;
    case "pendingKey":
      // Its own key: it folds only into the device's earlier pending key, never into a whole row's
      // write, which it must not replace (the last write of each kind keeps its place in order).
      return `pendingKey|${op.key.deviceId}`;
  }
}

function recordKey(record: AuditRecord, n: number): string {
  if (record.kind !== "reject") return `#${n}`;
  const { minute, via, reason } = record.row;
  return `rejects|${minute}|${via}|${reason}`;
}

/** A staged item and its size estimate. */
interface Entry {
  readonly item: StagedEffect;
  readonly bytes: number;
}

function withDurability(item: StagedEffect, durability: Durability): StagedEffect {
  return item.durability === durability ? item : { ...item, durability };
}

function isRetention(item: StagedEffect): boolean {
  return item.kind === "write" && item.op.op === "prune";
}

export class Batch {
  #entries = new Map<string, Entry>();
  #bytes = 0;
  #inserted = 0;
  #routineSince: Mono | undefined;

  /** Items held, after folding. */
  get size(): number {
    return this.#entries.size;
  }

  /** The estimated bytes held. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Whether anything held was written "now". */
  get hasNow(): boolean {
    for (const { item } of this.#entries.values()) if (item.durability === "now") return true;
    return false;
  }

  /**
   * When the first routine item entered the empty batch, or undefined. Retention's deletes do
   * not start the five minutes: they go with the next commit, never forcing one (section 6).
   */
  get routineSince(): Mono | undefined {
    return this.#routineSince;
  }

  /** The items, in the order they will be applied. */
  items(): readonly StagedEffect[] {
    return [...this.#entries.values()].map((entry) => entry.item);
  }

  stage(item: StagedEffect, at: Mono): void {
    const key = item.kind === "write" ? opKey(item.op) : recordKey(item.record, this.#inserted++);
    const earlier = this.#entries.get(key);
    const durability = earlier?.item.durability === "now" ? "now" : item.durability;
    const bytes = rowBytes(
      item.kind === "write" ? ("row" in item.op ? item.op.row : undefined) : item.record.row,
    );
    if (earlier !== undefined) {
      this.#entries.delete(key);
      this.#bytes -= earlier.bytes;
    }
    this.#entries.set(key, { item: withDurability(item, durability), bytes });
    this.#bytes += bytes;
    if (this.#routineSince === undefined && item.durability === "routine" && !isRetention(item)) {
      this.#routineSince = at;
    }
  }

  /**
   * Drops the oldest records until at most `cap` items are held: routine records first, then
   * any. Writes are never dropped. Returns how many records went (section 5, "A failed flush").
   */
  dropOldestRecords(cap: number): number {
    let dropped = 0;
    for (const durability of ["routine", "now"] as const) {
      for (const [key, { item, bytes }] of this.#entries) {
        if (this.#entries.size <= cap) return dropped;
        if (item.kind !== "record" || item.durability !== durability) continue;
        this.#entries.delete(key);
        this.#bytes -= bytes;
        dropped++;
      }
    }
    return dropped;
  }

  clear(): void {
    this.#entries = new Map();
    this.#bytes = 0;
    this.#routineSince = undefined;
  }
}
