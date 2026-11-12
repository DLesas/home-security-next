import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { buildApp, type Db } from "./app";

const port = Number(process.env.PORT ?? 45901);
const sqlite = new Database(process.env.DB ?? ":memory:");
sqlite.pragma("journal_mode = WAL");
const db = drizzle(sqlite) as unknown as Db;
const app = buildApp(db, { name: "SQLite through Drizzle", ok: true, detail: "better-sqlite3 (native add-on)" });
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
app.get("/ws", upgradeWebSocket(() => ({ onMessage(evt, ws) { ws.send(String(evt.data)); } })));
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
injectWebSocket(server);
