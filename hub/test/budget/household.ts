/**
 * M2's household on the whole hub (m2-design.md section 3, "The write budget with M2's records"):
 * four people with six linked browsers and the hub computer's console, added to a home of
 * `test/world/home.ts` before the hub starts, and the means to run their day: sessions as the app
 * channel gives them (`clientConnected`, `clientRequest`, `clientClosed`, already authenticated),
 * the shell's facts and time zone, and the shell's file jobs.
 *
 * The home's ports are the real ones (`homePorts`): the real calendar (`makeCalendar`), and the
 * shell's own file jobs (`startJob`, as `app-wiring.ts` runs them), which the loop drives a piece a
 * turn after the commit that started them.
 */
import { dirname, join } from "node:path";
import {
  APP_OPS,
  type AppMessage,
  type AppMessageV2,
  type AppOp,
  type AppReply,
  TOPICS,
} from "@hsn/protocol/app";
import { ok } from "neverthrow";
import type { Effect } from "../../src/core/model/effects.ts";
import { type ClientId, clientId, type ConnId, connId } from "../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { startJob } from "../../src/shell/backup/jobs.ts";
import { makeCalendar } from "../../src/shell/calendar/calendar.ts";
import type { JobStarted } from "../../src/shell/loop.ts";
import type { OpenedStore } from "../../src/shell/storage/store.ts";
import type { Home, HomeSpec } from "../world/home.ts";

const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");

/** The hub computer's console (client 1, no person). */
export const CONSOLE = clientId(1);
/** Section 3's household: 4 people with 6 linked clients (browsers in M2). */
export const PEOPLE = [
  { id: 1, name: "Anna", manageUsers: 1, manageSystem: 1 },
  { id: 2, name: "Ben", manageUsers: 0, manageSystem: 0 },
  { id: 3, name: "Cleo", manageUsers: 0, manageSystem: 0 },
  { id: 4, name: "Dan", manageUsers: 0, manageSystem: 0 },
] as const;
/** The six browsers: Anna and Ben two each, Cleo and Dan one. */
export const BROWSERS: readonly { readonly client: ClientId; readonly person: number }[] = [
  { client: clientId(7), person: 1 },
  { client: clientId(8), person: 1 },
  { client: clientId(9), person: 2 },
  { client: clientId(10), person: 2 },
  { client: clientId(11), person: 3 },
  { client: clientId(12), person: 4 },
];
export const ANNA_LAPTOP = clientId(7);

/** The household's rows, written before the first start (`Home.create`'s `prepare`). */
export function seedHousehold(store: OpenedStore): void {
  const at = Date.UTC(2026, 9, 1);
  const { db } = store;
  for (const p of PEOPLE) {
    db.run(`INSERT INTO people VALUES (?, ?, ?, NULL, 0)`, [p.id, p.name, at]);
    db.run(`INSERT INTO person_roles VALUES (?, ?, ?, 0)`, [p.id, p.manageUsers, p.manageSystem]);
  }
  // Everyone may manage and view every device: the household of section 3, no partial views.
  const devices = db.query<{ id: number }, []>(`SELECT id FROM devices`).all();
  for (const p of PEOPLE)
    for (const d of devices) db.run(`INSERT INTO permissions VALUES (?, ?, 1, 1)`, [p.id, d.id]);
  db.run(`DELETE FROM people_settings`);
  db.run(`INSERT INTO people_settings VALUES (1)`);
  const client = (id: number, person: number | null, kind: number, name: string): void => {
    db.run(
      `INSERT INTO clients (id, person_id, static_key, kind, name, linked_by_client, created_ms, removed_ms, last_seq, last_seen_ms, backup_key_epoch) VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL, NULL)`,
      [id, person, new Uint8Array(32).fill(id), kind, name, at],
    );
  };
  client(CONSOLE, null, 0, "The hub computer");
  for (const b of BROWSERS) client(b.client, b.person, 1, `browser ${b.client}`);
  // The app key, as `ensureAppKeys` makes it at start (the backup header's identity).
  db.run(`UPDATE hub_keys SET app_static_public = ?`, [new Uint8Array(32).fill(0x42)]);
}

/**
 * The real calendar and the shell's file jobs for a home (`HomeSpec.calendar`, `HomeSpec.files`):
 * a job runs on the store of the hub's run that started it, as `app-wiring.ts` runs it. `attach`
 * gives them the home once it is made (the spec is given before).
 */
export function homePorts(): Required<Pick<HomeSpec, "calendar" | "files">> & {
  attach(home: Home): void;
} {
  let attached: Home | undefined;
  return {
    calendar: makeCalendar()._unsafeUnwrap(),
    files: {
      perform: (job, work): JobStarted => {
        const store = attached?.store;
        if (attached === undefined || store === undefined)
          return {
            kind: "ready",
            outcome: { kind: "failed", reason: "io", message: "no store" },
          };
        const home = attached;
        const started = startJob(job, work, {
          db: store.db,
          dataDir: dirname(store.path),
          migrationsFolder: MIGRATIONS,
          rules: DEFAULT_RULES,
          uploads: { pathOf: () => undefined },
          exports: { send: () => ok(undefined) },
          prefix: undefined,
          switchBlockedBy: () => undefined,
          nowMs: () => home.clock.now().wall,
          salt: () => ok(new Uint8Array(8).fill(job)),
        });
        if (started.kind !== "pieces") return started;
        const pieces = started.pieces;
        return {
          kind: "pieces",
          pieces: {
            next: () => {
              const outcome = pieces.next();
              return outcome === undefined ? { done: false } : { done: true, outcome };
            },
            abort: () => {
              pieces.abort("the hub is stopping");
            },
          },
        };
      },
    },
    attach(home) {
      attached = home;
    },
  };
}

/** Commits counted around one input of the app side, for "reads never commit". */
export interface ReadCost {
  readonly op: string;
  readonly commits: number;
}

/** A household's day on a home: its sessions, requests, and the backups the core starts. */
export class Household {
  readonly home: Home;
  /** Commits caused by reads and sessions (each must be 0). */
  readonly readCosts: ReadCost[] = [];
  readonly #seqs = new Map<ClientId, number>();
  #ids = 0;
  #conns = 5000;

  constructor(home: Home) {
    this.home = home;
  }

  /** The shell's facts and the time zone, as `startupInputs` gives them before any session. */
  facts(zone = "Europe/London"): void {
    this.home.input({
      kind: "hubFacts",
      version: "0.1.0",
      addresses: ["192.168.1.20"],
      appsPort: 8444,
      consolePort: 8445,
      certificateSha256: new Uint8Array(32),
    });
    this.home.input({ kind: "timeZone", zone });
  }

  #commits(): number {
    return this.home.store?.writer.stats.commits ?? 0;
  }

  /** A session opened (proven), as the channel gives it. */
  connect(client: ClientId): ConnId {
    const conn = connId(this.#conns++);
    const before = this.#commits();
    this.home.input({
      kind: "clientConnected",
      conn,
      client,
      listener: client === CONSOLE ? "console" : "lan",
      proto: 1,
      app: "1.0.0",
    });
    this.readCosts.push({ op: "clientConnected", commits: this.#commits() - before });
    return conn;
  }

  close(conn: ConnId): void {
    const before = this.#commits();
    this.home.input({ kind: "clientClosed", conn, reason: "remote" });
    this.readCosts.push({ op: "clientClosed", commits: this.#commits() - before });
  }

  /** A request; a change takes the client's next `seq` (section 5). Returns the request's id. */
  request(conn: ConnId, client: ClientId, op: AppOp, seq?: number): number {
    const change = APP_OPS[op.op].change;
    const next = seq ?? (change ? (this.#seqs.get(client) ?? 0) + 1 : undefined);
    if (change && next !== undefined)
      this.#seqs.set(client, Math.max(next, this.#seqs.get(client) ?? 0));
    const id = ++this.#ids;
    const before = this.#commits();
    this.home.input({ kind: "clientRequest", conn, client, request: { id, seq: next, op } });
    if (!change) this.readCosts.push({ op: op.op, commits: this.#commits() - before });
    return id;
  }

  /** The client's last `seq` taken. */
  seqOf(client: ClientId): number {
    return this.#seqs.get(client) ?? 0;
  }

  /** The reply to request `id` on `conn`, if it left the hub. */
  reply(conn: ConnId, id: number): AppReply | undefined {
    for (const e of this.home.app)
      if (e.kind === "appSend" && e.conn === conn && isReply(e.message) && e.message.id === id)
        return e.message;
    return undefined;
  }

  /** Every reply to request `id` on `conn` that left the hub. */
  replies(conn: ConnId, id: number): readonly AppReply[] {
    return this.home.app.flatMap((e) =>
      e.kind === "appSend" && e.conn === conn && isReply(e.message) && e.message.id === id
        ? [e.message]
        : [],
    );
  }

  /** The notifications sent to `conn` as events. */
  notificationsTo(conn: ConnId): readonly number[] {
    return this.home.app.flatMap((e) => {
      if (e.kind !== "appSend" || e.conn !== conn) return [];
      const m = e.message;
      if (!("t" in m) || m.t !== "evt" || m.ev !== "notification") return [];
      const body = m.body as { readonly seq?: number };
      return body.seq === undefined ? [] : [body.seq];
    });
  }

  /** Effects of a kind the loop handed the app side (e.g. `historyRead`). */
  channel(kind: Effect["kind"]): number {
    return this.home.app.filter((e) => e.kind === kind).length;
  }

  /**
   * A session's usual visit: snapshot, subscribe, the newest history, its notifications read
   * (routine), and for Anna `hub.status`; then closed.
   */
  visit(client: ClientId, read: (conn: ConnId) => readonly number[] = () => []): void {
    const conn = this.connect(client);
    this.request(conn, client, { op: "snapshot", body: {} });
    this.request(conn, client, { op: "subscribe", body: { topics: [...TOPICS] } });
    this.request(conn, client, { op: "history.query", body: { limit: 50 } });
    this.request(conn, client, { op: "notifications.list", body: { limit: 50 } });
    const seqs = read(conn);
    if (seqs.length > 0)
      this.request(conn, client, { op: "notifications.read", body: { seqs: [...seqs] } });
    if (client === ANNA_LAPTOP) this.request(conn, client, { op: "hub.status", body: {} });
    this.close(conn);
  }

  /** The backups written and failed, by the hub's own records. */
  backups(): { readonly written: number; readonly failed: number } {
    return {
      written: this.home.hubEvents("backup_written").length,
      failed: this.home.hubEvents("backup_failed").length,
    };
  }
}

function isReply(message: AppMessage | AppMessageV2): message is AppReply {
  return "t" in message && message.t === "res";
}
