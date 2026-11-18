/**
 * The relay's tables (docs/m4-design.md section 3, "What the relay stores"), and nothing else:
 *
 * | Table | Holds | Kept |
 * | --- | --- | --- |
 * | `hubs` | each hub's identity, first seen, days seen, last contact, presence state, grace end | until 90 days without contact (7 for an identity not yet established), then deleted with its targets |
 * | `targets` | the phone's key id, platform, environment, token, and the hub's two sealed alerts | until the hub's roster drops it, the push service reports its token refused, or the hub's row goes |
 *
 * No address, no pseudonym, no roster revision, no push content beyond the two sealed alerts the
 * relay must send itself. Rate counters, the pseudonym secret and open streams are in memory only.
 * Migrations are drizzle-kit's (`bun run db:generate` in `relay/`), applied by `migrate.ts`.
 */
import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const hubs = sqliteTable(
  "hubs",
  {
    /** The hub's app identity, 26 characters. */
    identity: text("identity").primaryKey(),
    firstSeenMs: integer("first_seen_ms").notNull(),
    /** Different UTC days it connected on, up to `RETENTION_RULES.settledAfterDays`. */
    daysSeen: integer("days_seen").notNull(),
    /** The UTC day of `seen_ms`. */
    lastDay: integer("last_day").notNull(),
    /** Its last contact: a day's first frame, or its link's last frame. */
    seenMs: integer("seen_ms").notNull(),
    /** `online`, `quiet` or `alerted`. */
    state: text("state", { enum: ["online", "quiet", "alerted"] }).notNull(),
    /** An announced restart's grace end; 0 for none. */
    graceEndMs: integer("grace_end_ms").notNull(),
  },
  (table) => [check("hubs_state", sql`${table.state} in ('online', 'quiet', 'alerted')`)],
);

export const targets = sqliteTable(
  "targets",
  {
    hub: text("hub")
      .notNull()
      .references(() => hubs.identity, { onDelete: "cascade" }),
    /** The phone's push key id, 16 hex digits. */
    key: text("key").notNull(),
    platform: text("platform", { enum: ["apns", "fcm"] }).notNull(),
    env: text("env", { enum: ["production", "development"] }).notNull(),
    token: text("token").notNull(),
    /** The hub's sealed `unreachable` and `back` for this phone (D127). */
    unreachable: text("unreachable").notNull(),
    back: text("back").notNull(),
  },
  (table) => [primaryKey({ columns: [table.hub, table.key] })],
);
