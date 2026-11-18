/**
 * Every wrapper of `shell/safe/` against its real library failing (hub-design.md section 10,
 * "Where library exceptions are wrapped"): each failure comes back as a typed `HubError` with
 * the library's message and code, and nothing is thrown.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { randomBytes, subtle } from "../../../src/shell/safe/crypto.ts";
import {
  appendDurably,
  ensureDir,
  fileSize,
  listenUnixSocket,
  pathExists,
  readStart,
  readTextIfExists,
} from "../../../src/shell/safe/fs.ts";
import { parseJson } from "../../../src/shell/safe/json.ts";
import { advertise, startMdns, stopMdns } from "../../../src/shell/safe/mdns.ts";
import { applyMigrations, readMigrations } from "../../../src/shell/safe/migrate.ts";
import { openTty } from "../../../src/shell/safe/serial.ts";
import { closeDatabase, openDatabase, sqlite } from "../../../src/shell/safe/sqlite.ts";
import { sendWebSocket } from "../../../src/shell/safe/websocket.ts";

const ORIGIN = "test/safe";
const temp = mkdtempSync(join(tmpdir(), "hsn-safe-"));
afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

describe("sqlite", () => {
  test("a failing statement is a storage error with SQLite's code", () => {
    const db = openDatabase(":memory:", ORIGIN, { create: true })._unsafeUnwrap();
    const result = sqlite(ORIGIN, "read", () => db.query("SELECT * FROM missing").all());
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      origin: ORIGIN,
      detail: { code: "SQLITE_ERROR" },
    });
    expect(result._unsafeUnwrapErr().message).toContain("no such table");
    expect(closeDatabase(db, ORIGIN).isOk()).toBe(true);
  });

  test("a database in a folder that does not exist cannot be opened", () => {
    const result = openDatabase(join(temp, "no", "such", "hub.db"), ORIGIN, { create: true });
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "SQLITE_CANTOPEN" },
    });
  });

  test("a full database fails its write and keeps what it had", () => {
    const db = openDatabase(join(temp, "full.db"), ORIGIN, { create: true })._unsafeUnwrap();
    db.run("CREATE TABLE t (b BLOB)");
    db.run("PRAGMA max_page_count = 3");
    const big = new Uint8Array(64 * 1024);
    const result = sqlite(ORIGIN, "insert", () =>
      db.transaction(() => db.query("INSERT INTO t VALUES (?)").run(big))(),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "SQLITE_FULL" },
    });
    expect(db.query("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
    db.close(true);
  });
});

describe("migrate", () => {
  test("a folder with no journal is an error, not a throw", () => {
    expect(readMigrations(join(temp, "nothing"))._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
    });
  });

  test("a failing migration is an error and is rolled back", () => {
    const folder = join(temp, "bad-migrations");
    mkdirSync(join(folder, "meta"), { recursive: true });
    writeFileSync(
      join(folder, "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "sqlite",
        entries: [{ idx: 0, version: "6", when: 1, tag: "0000_bad", breakpoints: true }],
      }),
    );
    writeFileSync(
      join(folder, "0000_bad.sql"),
      "CREATE TABLE a (x INTEGER);\n--> statement-breakpoint\nNOT SQL;",
    );
    const db = openDatabase(":memory:", ORIGIN, { create: true })._unsafeUnwrap();
    expect(applyMigrations(db, folder)._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "SQLITE_ERROR" },
    });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'a'").get()).toBeNull();
  });
});

describe("json", () => {
  test("malformed text is an error of the kind asked for", () => {
    expect(parseJson("{", "control", ORIGIN)._unsafeUnwrapErr()).toMatchObject({
      kind: "control",
      origin: ORIGIN,
    });
    expect(parseJson('{"a":1}', "control", ORIGIN)._unsafeUnwrap()).toEqual({ a: 1 });
  });
});

describe("crypto", () => {
  test("a length the generator cannot fill is a random error", () => {
    // Bun's generator has no 65,536-byte quota; a length that is not one is what fails.
    expect(randomBytes(-1, ORIGIN)._unsafeUnwrapErr()).toMatchObject({ kind: "random" });
    expect(randomBytes(32, ORIGIN)._unsafeUnwrap()).toHaveLength(32);
  });

  test("a subtle call that rejects, or throws, is a crypto error", async () => {
    const rejected = await subtle(ORIGIN, "import", (s) =>
      s.importKey("raw", new Uint8Array(3), { name: "AES-GCM" }, false, ["encrypt"]),
    );
    expect(rejected._unsafeUnwrapErr()).toMatchObject({ kind: "crypto", origin: ORIGIN });
    const thrown = await subtle(ORIGIN, "digest", () => {
      // A library that throws before it returns a promise.
      return JSON.parse("{") as Promise<never>;
    });
    expect(thrown._unsafeUnwrapErr()).toMatchObject({ kind: "crypto" });
  });
});

describe("fs", () => {
  const caller = { kind: "storage", origin: ORIGIN } as const;

  test("a folder under a file cannot be made", () => {
    writeFileSync(join(temp, "plain"), "x");
    expect(ensureDir(caller, join(temp, "plain", "sub"))._unsafeUnwrapErr()).toMatchObject({
      kind: "storage",
      detail: { code: "ENOTDIR" },
    });
  });

  test("a missing file is an answer, not an error; other failures are errors", () => {
    expect(pathExists(caller, join(temp, "missing"))._unsafeUnwrap()).toBe(false);
    expect(readTextIfExists(caller, join(temp, "missing"))._unsafeUnwrap()).toBeUndefined();
    expect(fileSize(caller, join(temp, "missing"))._unsafeUnwrap()).toBeUndefined();
    expect(readStart(caller, join(temp, "missing"), new Uint8Array(4))._unsafeUnwrap()).toBe(0);
    expect(readTextIfExists(caller, temp)._unsafeUnwrapErr()).toMatchObject({
      detail: { code: "EISDIR" },
    });
  });

  test("appending to a folder fails; appending to a file adds and keeps", () => {
    expect(appendDurably(caller, temp, "x")._unsafeUnwrapErr()).toMatchObject({ kind: "storage" });
    const path = join(temp, "log");
    expect(appendDurably(caller, path, "a\n").isOk()).toBe(true);
    expect(appendDurably(caller, path, "b\n").isOk()).toBe(true);
    expect(readTextIfExists(caller, path)._unsafeUnwrap()).toBe("a\nb\n");
  });

  test("a socket in a folder that does not exist cannot listen", async () => {
    const result = await listenUnixSocket(
      { kind: "control", origin: ORIGIN },
      join(temp, "no", "control.sock"),
      () => undefined,
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "control" });
  });
});

describe("serial", () => {
  test("a port that does not exist is a link error", () => {
    const result = openTty(join(temp, "ttyNONE"));
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "link", code: "writeFailed" });
  });
});

describe("websocket", () => {
  test("a send on a socket the far end closed is `closed`", async () => {
    let socket: ServerWebSocket<unknown> | undefined;
    const closed = Promise.withResolvers<undefined>();
    const server = Bun.serve({
      port: 0,
      fetch: (request, srv) =>
        srv.upgrade(request) ? undefined : new Response("no", { status: 400 }),
      websocket: {
        open: (ws) => {
          socket = ws;
          expect(sendWebSocket(ws, new Uint8Array([1, 2]), ORIGIN).isOk()).toBe(true);
        },
        message: () => undefined,
        close: () => {
          closed.resolve(undefined);
        },
      },
    });
    const client = new WebSocket(`ws://localhost:${server.port}`);
    const opened = Promise.withResolvers<undefined>();
    client.onmessage = () => {
      opened.resolve(undefined);
    };
    await opened.promise;
    client.close();
    await closed.promise;
    expect(socket).toBeDefined();
    if (socket !== undefined) {
      expect(sendWebSocket(socket, new Uint8Array([3]), ORIGIN)._unsafeUnwrapErr()).toMatchObject({
        kind: "link",
        code: "closed",
      });
    }
    await server.stop(true);
  });
});

describe("mdns", () => {
  test("a service with no name is a link error, not a throw", async () => {
    const errors: unknown[] = [];
    const mdns = startMdns(ORIGIN, (error) => errors.push(error))._unsafeUnwrap();
    const result = advertise(mdns, { name: "", type: "hsn-hub", port: 1 }, ORIGIN, (error) =>
      errors.push(error),
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({ kind: "link", origin: ORIGIN });
    expect(result._unsafeUnwrapErr().message).toContain("name");
    expect((await stopMdns(mdns, ORIGIN)).isOk()).toBe(true);
  });
});
