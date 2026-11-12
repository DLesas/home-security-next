import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { upgradeWebSocket, websocket } from "hono/bun";
import { buildApp, type Db } from "./app";

const port = Number(process.env.PORT ?? 45902);
const sqlite = new Database(process.env.DB ?? ":memory:");
sqlite.exec("pragma journal_mode = WAL");
const db = drizzle(sqlite) as unknown as Db;
const app = buildApp(db, { name: "SQLite through Drizzle", ok: true, detail: "bun:sqlite (built in)" });
app.get("/ws", upgradeWebSocket(() => ({ onMessage(evt, ws) { ws.send(String(evt.data)); } })));
Bun.serve({ fetch: app.fetch, websocket, port, hostname: "127.0.0.1" });
