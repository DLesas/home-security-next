/**
 * The relay's stored state (docs/m4-design.md section 3, "What the relay stores"), behind one
 * small interface so a relay split across servers can put it elsewhere: `bun:sqlite` with Drizzle
 * on one server.
 *
 * **Durability, write by write.** Every write is committed at once with a full sync (WAL,
 * `synchronous = FULL`), because every write here is rare and each matters after a restart:
 *
 * | Write | When | Lost by a power cut, it would |
 * | --- | --- | --- |
 * | A hub first heard | once per identity | let the identity count as new again (the new-identity limits) |
 * | A hub's day, or its link's last frame | at most once a UTC day, and at each link close | shorten its retention by a day at most |
 * | Presence state, grace end | at a change: an outage, a return, an announced restart | send an `unreachable` or `back` twice, or miss the grace |
 * | Targets | at each roster, and a token the push service refused | push to a phone the hub dropped, until its next roster |
 * | Deletions | the daily retention sweep | keep a row a day longer |
 *
 * Last contact is not written at every frame (one every 30 s per hub): presence's clock starts
 * afresh at a restart anyway (D96).
 */
import { Database } from "bun:sqlite";
import type { RosterTarget } from "@hsn/protocol/relay";
import { count, eq, and, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { err, ok, type Result } from "neverthrow";
import type { HubRecord } from "../../core/identities.ts";
import type { HubPresence } from "../../core/presence.ts";
import type { RelayError } from "../errors.ts";
import { attempt } from "../safe/attempt.ts";
import { migrate } from "./migrate.ts";
import { hubs, targets } from "./schema.ts";

const ORIGIN = "shell/storage/store";

/** A hub as stored: its record and its presence. */
export interface StoredHub {
  readonly record: HubRecord;
  readonly presence: HubPresence;
}

export interface RelayStore {
  /** Every hub, with whether it has targets. */
  load(): Result<readonly StoredHub[], RelayError>;
  /** A hub first heard: its record and presence. */
  addHub(record: HubRecord, presence: HubPresence): Result<void, RelayError>;
  putRecord(record: HubRecord): Result<void, RelayError>;
  putPresence(presence: HubPresence): Result<void, RelayError>;
  /** A roster: the hub's whole set of targets, replacing the last. */
  replaceTargets(identity: string, list: readonly RosterTarget[]): Result<void, RelayError>;
  targets(identity: string): Result<readonly RosterTarget[], RelayError>;
  /** A target whose token the push service refused. */
  dropTarget(identity: string, key: string): Result<void, RelayError>;
  /** Deletes hubs, with their targets. */
  deleteHubs(identities: readonly string[]): Result<number, RelayError>;
  close(): void;
}

type Db = ReturnType<typeof drizzle>;

class SqliteStore implements RelayStore {
  constructor(
    private readonly raw: Database,
    private readonly db: Db,
  ) {}

  private run<T>(what: string, body: () => T): Result<T, RelayError> {
    return attempt("storage", ORIGIN, what, body);
  }

  load(): Result<readonly StoredHub[], RelayError> {
    return this.run("load hubs", () => {
      const withTargets = new Set(
        this.db
          .select({ hub: targets.hub, n: count() })
          .from(targets)
          .groupBy(targets.hub)
          .all()
          .filter((row) => row.n > 0)
          .map((row) => row.hub),
      );
      return this.db
        .select()
        .from(hubs)
        .all()
        .map((row) => ({
          record: {
            identity: row.identity,
            firstSeenMs: row.firstSeenMs,
            daysSeen: row.daysSeen,
            lastDay: row.lastDay,
            seenMs: row.seenMs,
          },
          presence: {
            identity: row.identity,
            lastContactMs: row.seenMs,
            state: row.state,
            graceEndMs: row.graceEndMs,
            hasTargets: withTargets.has(row.identity),
          },
        }));
    });
  }

  addHub(record: HubRecord, presence: HubPresence): Result<void, RelayError> {
    return this.run("add a hub", () => {
      this.db
        .insert(hubs)
        .values({ ...record, state: presence.state, graceEndMs: presence.graceEndMs })
        .onConflictDoNothing()
        .run();
    });
  }

  putRecord(record: HubRecord): Result<void, RelayError> {
    return this.run("write a hub's days", () => {
      this.db
        .update(hubs)
        .set({ daysSeen: record.daysSeen, lastDay: record.lastDay, seenMs: record.seenMs })
        .where(eq(hubs.identity, record.identity))
        .run();
    });
  }

  putPresence(presence: HubPresence): Result<void, RelayError> {
    return this.run("write a hub's presence", () => {
      this.db
        .update(hubs)
        .set({ state: presence.state, graceEndMs: presence.graceEndMs })
        .where(eq(hubs.identity, presence.identity))
        .run();
    });
  }

  replaceTargets(identity: string, list: readonly RosterTarget[]): Result<void, RelayError> {
    return this.run("replace a hub's targets", () => {
      this.db.transaction((tx) => {
        tx.delete(targets).where(eq(targets.hub, identity)).run();
        if (list.length > 0) {
          tx.insert(targets)
            .values(list.map((target) => ({ hub: identity, ...target })))
            .run();
        }
      });
    });
  }

  targets(identity: string): Result<readonly RosterTarget[], RelayError> {
    return this.run("read a hub's targets", () =>
      this.db
        .select({
          key: targets.key,
          platform: targets.platform,
          env: targets.env,
          token: targets.token,
          unreachable: targets.unreachable,
          back: targets.back,
        })
        .from(targets)
        .where(eq(targets.hub, identity))
        .all(),
    );
  }

  dropTarget(identity: string, key: string): Result<void, RelayError> {
    return this.run("drop a target", () => {
      this.db
        .delete(targets)
        .where(and(eq(targets.hub, identity), eq(targets.key, key)))
        .run();
    });
  }

  deleteHubs(identities: readonly string[]): Result<number, RelayError> {
    if (identities.length === 0) return ok(0);
    return this.run("delete hubs", () => {
      let deleted = 0;
      this.db.transaction((tx) => {
        // In slices, under SQLite's limit on bound values.
        for (let at = 0; at < identities.length; at += 500) {
          const slice = identities.slice(at, at + 500);
          deleted += tx
            .delete(hubs)
            .where(inArray(hubs.identity, slice))
            .returning({ identity: hubs.identity })
            .all().length;
        }
      });
      return deleted;
    });
  }

  /** Finalizes Drizzle's prepared statements so the database files are released synchronously. */
  close(): void {
    this.run("close", () => {
      this.raw.close(true);
    }).unwrapOr(undefined);
  }
}

/** Opens (and makes, and migrates) the database at `path`; `:memory:` for a store that is not kept. */
export function openStore(path: string): Result<RelayStore, RelayError> {
  const opened = attempt(
    "storage",
    ORIGIN,
    "open the database",
    () => new Database(path, { create: true, strict: true }),
  );
  if (opened.isErr()) return err(opened.error);
  const raw = opened.value;
  const configured = attempt("storage", ORIGIN, "configure the database", () => {
    raw.run("PRAGMA journal_mode = WAL");
    raw.run("PRAGMA synchronous = FULL");
    raw.run("PRAGMA foreign_keys = ON");
    raw.run("PRAGMA busy_timeout = 0");
    if (process.platform === "darwin") raw.run("PRAGMA fullfsync = ON");
  });
  const migrated = configured.andThen(() => migrate(raw));
  if (migrated.isErr()) {
    attempt("storage", ORIGIN, "close", () => {
      raw.close(true);
    }).unwrapOr(undefined);
    return err(migrated.error);
  }
  return ok(new SqliteStore(raw, drizzle(raw)));
}
