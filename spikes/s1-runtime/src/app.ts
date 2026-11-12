// The hub-shaped part shared by both runtimes: web server routes and database work.
import { Hono } from "hono";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { runChecks, type Check } from "./checks";

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id").notNull(),
  kind: text("kind").notNull(),
  at: integer("at").notNull(),
});

// Both Drizzle drivers used here are synchronous and share this surface.
export type Db = {
  run: (q: ReturnType<typeof sql>) => unknown;
  insert: (t: typeof events) => { values: (v: { deviceId: string; kind: string; at: number }[]) => { run: () => unknown } };
  select: (f: { n: ReturnType<typeof sql<number>> }) => { from: (t: typeof events) => { get: () => { n: number } | undefined } };
  transaction: (fn: (tx: Db) => void) => void;
};

export function buildApp(db: Db, dbCheck: Check) {
  db.run(sql`create table if not exists events (id integer primary key autoincrement, device_id text not null, kind text not null, at integer not null)`);
  const app = new Hono();
  app.get("/health", (c) => c.text("ok"));
  app.get("/checks", async (c) => c.json([dbCheck, ...(await runChecks())]));
  app.post("/load", (c) => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ deviceId: `sensor-${i % 20}`, kind: "heartbeat", at: Date.now() }));
    db.transaction((tx) => { for (let i = 0; i < 20; i++) tx.insert(events).values(rows).run(); });
    const count = db.select({ n: sql<number>`count(*)` }).from(events).get();
    return c.json({ rows: count?.n ?? 0 });
  });
  return app;
}
