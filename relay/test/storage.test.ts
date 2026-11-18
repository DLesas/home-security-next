/**
 * What the relay stores, and for how long (docs/m4-design.md section 3, "What the relay stores";
 * D142 "Identities that never settle"): the two tables and nothing else, drizzle-kit's migration
 * matching the schema, hubs and their presence kept across a restart, and retention: an identity
 * never established deleted 7 days after its last contact, an established one after 90, with its
 * targets, never while its link is up. The sweep runs at start and at every midnight UTC.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RETENTION_RULES } from "../src/core/rules.ts";
import { TIME, untilNextUtcDay } from "../src/core/time.ts";
import { JOURNAL_TAGS, MIGRATIONS } from "../src/shell/storage/migrate.ts";
import { hubs, targets } from "../src/shell/storage/schema.ts";
import { openStore } from "../src/shell/storage/store.ts";
import {
  cleanup,
  hubKey,
  ManualClock,
  must,
  StandInHub,
  startRelay,
  target,
  tempFolder,
  type TestRelay,
  until,
} from "./helpers.ts";

let folder: string;
let t: TestRelay;
/** Noon UTC, so a day's midnight is 12 hours away. */
const NOON = Date.UTC(2026, 10, 18, 12);

beforeEach(() => {
  folder = tempFolder();
  t = startRelay(folder, { clock: new ManualClock(NOON) });
});

afterEach(async () => {
  await t.stop();
  cleanup(folder);
});

describe("the schema", () => {
  test("the migrations make exactly the schema's tables and columns, and nothing else", () => {
    expect(JOURNAL_TAGS).toEqual(Object.keys(MIGRATIONS));
    const db = new Database(t.dbPath, { readonly: true });
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(["hubs", "relay_migrations", "targets"]);
    for (const table of [hubs, targets]) {
      const config = getTableConfig(table);
      const columns = db
        .query<{ name: string }, []>(`PRAGMA table_info(${config.name})`)
        .all()
        .map((r) => r.name)
        .sort();
      expect(columns).toEqual(config.columns.map((c) => c.name).sort());
    }
    db.close();
  });

  test("the migration file is drizzle-kit's, applied once", () => {
    const sql = readFileSync(
      join(import.meta.dir, "../src/shell/storage/migrations/0000_relay.sql"),
      "utf8",
    );
    expect(MIGRATIONS["0000_relay"]).toBe(sql);
    const again = must(openStore(t.dbPath));
    again.close();
    const db = new Database(t.dbPath, { readonly: true });
    expect(db.query("SELECT tag FROM relay_migrations").all()).toEqual([{ tag: "0000_relay" }]);
    db.close();
  });

  test("no address, no pseudonym, no content beyond the two sealed alerts is stored", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    hub.send({ t: "roster", rev: 1, targets: [target(1)] });
    await hub.next("rosterAck");
    hub.send({
      t: "push",
      items: [{ id: 1, key: target(1).key, h: `1.${target(1).key}.${"Z".repeat(1744)}` }],
    });
    await hub.next("pushResult");
    const bytes =
      readFileSync(t.dbPath).toString("latin1") +
      readFileSync(`${t.dbPath}-wal`).toString("latin1");
    expect(bytes).not.toContain("127.0.0.1");
    expect(bytes).not.toContain("relay-");
    expect(bytes).not.toContain("Z".repeat(64));
    expect(bytes).toContain(hub.identity);
  });
});

describe("across a restart", () => {
  test("hubs, their days, presence and targets are kept", async () => {
    const key = hubKey();
    const hub = await StandInHub.connect(t.url, { key });
    await hub.next("joined");
    hub.send({ t: "roster", rev: 1, targets: [target(1), target(2)] });
    await hub.next("rosterAck");
    hub.client.close();
    await until(() => t.relay.counts.joined === 0, "the link to close");
    t.clock.advance(200 * TIME.SECOND);
    await until(() => t.push.items.length === 2, "the alert");
    const dbPath = t.dbPath;
    await t.stop();
    t = startRelay(folder, { dbPath, clock: new ManualClock(NOON + TIME.HOUR) });
    expect(t.relay.recordOf(key.identity)).toEqual({
      identity: key.identity,
      firstSeenMs: NOON,
      daysSeen: 1,
      lastDay: Math.floor(NOON / TIME.DAY),
      seenMs: NOON,
    });
    expect(t.relay.presenceOf(key.identity)).toMatchObject({ state: "alerted", hasTargets: true });
    expect(t.store.targets(key.identity).unwrapOr([])).toEqual([target(1), target(2)]);
  });
});

describe("retention", () => {
  /** A hub that joins on each of `days` UTC days (at noon), and leaves. */
  async function hubOnDays(days: number): Promise<string> {
    const key = hubKey();
    for (let d = 0; d < days; d++) {
      if (d > 0) t.clock.to(NOON + d * TIME.DAY);
      const hub = await StandInHub.connect(t.url, { key });
      await hub.next("joined");
      if (d === 0) {
        hub.send({ t: "roster", rev: 1, targets: [target(1)] });
        await hub.next("rosterAck");
      }
      hub.client.close();
      await until(() => t.relay.counts.joined === 0, "the link to close");
    }
    return key.identity;
  }

  test("an identity never established goes, with its targets, at the first midnight 7 days after its last contact", async () => {
    const identity = await hubOnDays(RETENTION_RULES.settledAfterDays - 1);
    const last = t.relay.recordOf(identity)?.seenMs ?? 0;
    expect(t.relay.recordOf(identity)?.daysSeen).toBe(RETENTION_RULES.settledAfterDays - 1);
    const edge = last + RETENTION_RULES.unsettledHubMs;
    // The midnight before the edge: kept.
    t.clock.to(edge + untilNextUtcDay(edge) - TIME.DAY);
    expect(t.relay.recordOf(identity)).toBeDefined();
    // The first midnight at or after it: gone, with its targets.
    t.clock.to(edge + untilNextUtcDay(edge));
    expect(t.relay.recordOf(identity)).toBeUndefined();
    expect(t.store.targets(identity).unwrapOr([target(9)])).toEqual([]);
    const db = new Database(t.dbPath, { readonly: true });
    expect(db.query("SELECT count(*) AS n FROM targets").get()).toEqual({ n: 0 });
    db.close();
  });

  test("an established identity outlives 7 days and goes after 90", async () => {
    const identity = await hubOnDays(RETENTION_RULES.settledAfterDays);
    const last = t.relay.recordOf(identity)?.seenMs ?? 0;
    t.clock.to(last + RETENTION_RULES.unsettledHubMs + TIME.DAY);
    expect(t.relay.recordOf(identity)).toBeDefined();
    const edge = last + RETENTION_RULES.establishedHubMs;
    t.clock.to(edge - TIME.DAY);
    expect(t.relay.recordOf(identity)).toBeDefined();
    t.clock.to(edge + untilNextUtcDay(edge));
    expect(t.relay.recordOf(identity)).toBeUndefined();
  });

  test("a hub linked across midnight counts the new day and keeps its record", async () => {
    const hub = await StandInHub.connect(t.url);
    await hub.next("joined");
    const midnight = NOON + untilNextUtcDay(NOON);
    t.clock.to(midnight - 60 * TIME.SECOND);
    // Silent since noon: the presence clock closed that link; a new one, kept alive by pings.
    const again = await StandInHub.connect(t.url, {
      key: { key: hub.key, identity: hub.identity },
    });
    await again.next("joined");
    for (let i = 0; i < 4; i++) {
      t.clock.advance(30 * TIME.SECOND);
      again.send({ t: "ping", n: i });
      await again.next("pong");
    }
    expect(t.relay.recordOf(hub.identity)).toMatchObject({
      daysSeen: 2,
      lastDay: Math.floor(midnight / TIME.DAY),
    });
    expect((t.relay.recordOf(hub.identity)?.seenMs ?? 0) >= midnight).toBe(true);
  });

  test("the sweep at start deletes what expired while the relay was stopped", async () => {
    const identity = await hubOnDays(1);
    const dbPath = t.dbPath;
    await t.stop();
    t = startRelay(folder, {
      dbPath,
      clock: new ManualClock(NOON + RETENTION_RULES.unsettledHubMs),
    });
    expect(t.relay.recordOf(identity)).toBeUndefined();
  });

  test("a relay restart does not count as contact", async () => {
    const identity = await hubOnDays(1);
    const dbPath = t.dbPath;
    for (let d = 1; d < 7; d++) {
      await t.stop();
      t = startRelay(folder, { dbPath, clock: new ManualClock(NOON + d * TIME.DAY) });
      expect(t.relay.recordOf(identity)?.seenMs).toBe(NOON);
    }
    await t.stop();
    t = startRelay(folder, { dbPath, clock: new ManualClock(NOON + 7 * TIME.DAY) });
    expect(t.relay.recordOf(identity)).toBeUndefined();
  });
});
