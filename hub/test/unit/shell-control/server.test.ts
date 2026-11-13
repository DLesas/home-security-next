/**
 * The control socket (hub-design.md sections 3 and 9): its permissions checked on the file
 * itself, an old socket removed and a running hub's kept, one JSON request and reply per line
 * checked with the frozen schemas, one request at a time per connection, malformed, oversized
 * and partial lines answered where possible, never executed, and recorded without their content,
 * and `--follow` streamed from the records handed to it, never by polling.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { err } from "neverthrow";
import type { AuditRecord } from "../../../src/core/model/audit.ts";
import { deviceId, seq } from "../../../src/core/model/ids.ts";
import { LineReader, MAX_REQUEST_LINE_BYTES } from "../../../src/shell/control/lines.ts";
import { recordJson } from "../../../src/shell/control/records.ts";
import {
  MAX_WAITING_REQUESTS,
  UNREAD_REQUEST_ID,
  UnixControlServer,
} from "../../../src/shell/control/server.ts";
import {
  MAX_SOCKET_PATH_BYTES,
  ownUid,
  prepareSocketPath,
  secureFolder,
  secureSocket,
} from "../../../src/shell/control/socket-file.ts";
import { openWindowsControl } from "../../../src/shell/control/windows.ts";
import { expectNoKeyLeaks, noteKey } from "../setup/support/leak-guard.ts";
import { openServer, RawClient, settle, type TestFolder, testFolder } from "./support.ts";

const folders: TestFolder[] = [];
const servers: UnixControlServer[] = [];

function folder(): TestFolder {
  const made = testFolder();
  folders.push(made);
  return made;
}

async function server(options: Parameters<typeof openServer>[1] = {}) {
  const where = folder();
  const opened = await openServer(where.socket, options);
  servers.push(opened.server);
  return { ...opened, where };
}

afterEach(async () => {
  for (const s of servers.splice(0)) expect((await s.close()).isOk()).toBe(true);
  for (const f of folders.splice(0)) f.remove();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const STATUS = { id: 7, actor: "dimitri", command: { kind: "status" } };

function rx(device: number, atMs: number): AuditRecord {
  return {
    kind: "rx",
    table: "routine",
    row: {
      seq: seq(2 ** 32 + atMs),
      atMs,
      clockOk: true,
      deviceId: deviceId(device),
      type: 1,
      counter: 9,
      path: 0,
      gatewayId: deviceId(2),
      gwUs: 5,
      rssi: -90,
      snrQ: 20,
      rate: 5,
      body: new Uint8Array([1, 2]),
    },
  };
}

function hubEvent(atMs: number): AuditRecord {
  return {
    kind: "hubEvent",
    row: {
      seq: seq(2 ** 32 + atMs),
      atMs,
      clockOk: true,
      level: "info",
      origin: "core/setup",
      code: "usb_identity",
      message: "m",
      detail: null,
    },
  };
}

describe("the socket file (section 9, D61, D62)", () => {
  test("the socket is 0600 and its folder 0700, checked on the files themselves", async () => {
    const { where } = await server();
    expect(statSync(where.socket).isSocket()).toBe(true);
    expect(statSync(where.socket).mode & 0o777).toBe(0o600);
    expect(statSync(where.folder).mode & 0o777).toBe(0o700);
  });

  test("a data folder open to others is closed to them before the socket is made", async () => {
    const where = folder();
    mkdirSync(where.folder, { recursive: true, mode: 0o755 });
    chmodSync(where.folder, 0o755);
    const opened = await openServer(where.socket);
    servers.push(opened.server);
    expect(statSync(where.folder).mode & 0o777).toBe(0o700);
  });

  test("an old socket file with no hub behind it is removed and replaced", async () => {
    const where = folder();
    mkdirSync(where.folder, { recursive: true, mode: 0o700 });
    // A process that listens and is killed leaves its socket file behind.
    const script = `require("net").createServer().listen(${JSON.stringify(where.socket)}, () => process.kill(process.pid, "SIGKILL"))`;
    spawnSync("bun", ["-e", script]);
    expect(existsSync(where.socket)).toBe(true);
    const opened = await openServer(where.socket);
    servers.push(opened.server);
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    expect(await client.until(() => opened.recorded.events.length === 1)).toBe(true);
  });

  test("a socket a running hub answers on is not taken over", async () => {
    const { where } = await server();
    const second = await prepareSocketPath(where.socket);
    expect(second.isErr() ? second.error.message : "taken").toContain("another hub is running");
    expect(statSync(where.socket).isSocket()).toBe(true);
  });

  test("something that is not a socket at the path is left alone and refused", async () => {
    const where = folder();
    mkdirSync(where.folder, { recursive: true, mode: 0o700 });
    writeFileSync(where.socket, "not a socket");
    const prepared = await prepareSocketPath(where.socket);
    expect(prepared.isErr()).toBe(true);
    expect(existsSync(where.socket)).toBe(true);
  });

  test(`a path longer than ${MAX_SOCKET_PATH_BYTES} bytes is refused with a reason`, async () => {
    const prepared = await prepareSocketPath(
      `/tmp/${"x".repeat(MAX_SOCKET_PATH_BYTES)}/control.sock`,
    );
    expect(prepared.isErr() ? prepared.error.message : "").toContain("longer than");
  });

  test("a data folder that belongs to another account is refused, and left as it was", async () => {
    const where = folder();
    mkdirSync(where.folder, { recursive: true, mode: 0o700 });
    const other = (statSync(where.folder).uid + 1) >>> 0;
    const checked = secureFolder(where.folder, other);
    expect(checked.isErr() ? checked.error.message : "accepted").toContain(
      "belongs to another account",
    );
    const prepared = await prepareSocketPath(where.socket, other);
    expect(prepared.isErr()).toBe(true);
    expect(secureFolder(where.folder, statSync(where.folder).uid).isOk()).toBe(true);
    expect(statSync(where.folder).mode & 0o777).toBe(0o700);
  });

  test("a socket that belongs to another account is refused; one of the hub's account is taken", async () => {
    const { where } = await server();
    const owner = statSync(where.socket).uid;
    const checked = secureSocket(where.socket, (owner + 1) >>> 0);
    expect(checked.isErr() ? checked.error.message : "accepted").toContain(
      "belongs to another account",
    );
    expect(secureSocket(where.socket, owner).isOk()).toBe(true);
    expect(ownUid()).toBe(owner);
  });

  test("closing removes the socket file", async () => {
    const { server: s, where } = await server();
    servers.splice(servers.indexOf(s), 1);
    expect((await s.close()).isOk()).toBe(true);
    expect(existsSync(where.socket)).toBe(false);
  });

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  test.skipIf(!root)(
    "another account cannot connect (shown only when the tests run as root)",
    async () => {
      const { where } = await server();
      const script = `const s=require("net").connect(${JSON.stringify(where.socket)});s.on("connect",()=>process.exit(0));s.on("error",e=>process.exit(e.code==="EACCES"?3:4))`;
      const nobody = spawnSync("bun", ["-e", script], { uid: 65534, gid: 65534 });
      expect(nobody.status).toBe(3);
    },
  );

  test("Windows: the pipe is not opened until it can be limited to the hub's account (WAITING)", async () => {
    const opened = await openWindowsControl();
    expect(opened.isErr() ? opened.error.message : "").toContain("WAITING");
  });
});

describe("requests and replies", () => {
  test("a request becomes a command input; its reply goes back with the client's id", async () => {
    const { server: s, recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(
      `${JSON.stringify({ id: 41, actor: "dimitri", command: { kind: "arm", sensors: ["front"], continue: false } })}\n`,
    );
    await client.until(() => recorded.events.length === 1);
    const event = recorded.events[0];
    expect(event).toMatchObject({
      kind: "command",
      actor: "dimitri",
      command: { kind: "arm", sensors: ["front"], continue: false },
    });
    if (event?.kind !== "command") return;
    s.respond(event.request, {
      ok: true,
      result: { kind: "arm", armed: ["front"], waitsForDoorToClose: [] },
    });
    await client.until(() => client.lines.length === 1);
    expect(client.json()).toEqual([
      {
        id: 41,
        reply: { ok: true, result: { kind: "arm", armed: ["front"], waitsForDoorToClose: [] } },
      },
    ]);
  });

  test("an answer the core makes at once, inside the input, still reaches its client", async () => {
    const { server: s, where } = await server();
    s.listen((event) => {
      if (event.kind === "command")
        s.respond(event.request, { ok: true, result: { kind: "siteWifi" } });
    });
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => client.lines.length === 1);
    expect(client.json()).toEqual([{ id: 7, reply: { ok: true, result: { kind: "siteWifi" } } }]);
  });

  test("one request at a time per connection: the second waits for the first's reply", async () => {
    const { server: s, recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(
      `${JSON.stringify({ ...STATUS, id: 1 })}\n${JSON.stringify({ ...STATUS, id: 2 })}\n`,
    );
    await client.until(() => recorded.events.length >= 1);
    await settle();
    expect(recorded.events).toHaveLength(1);
    const first = recorded.events[0];
    if (first?.kind !== "command") return;
    s.respond(first.request, { ok: false, error: { code: "failed", message: "x" } });
    await client.until(() => recorded.events.length === 2);
    expect(recorded.events).toHaveLength(2);
  });

  test("a status reply gets the writer's last commit and staged items", async () => {
    const {
      server: s,
      recorded,
      where,
    } = await server({
      writerStatus: () => ({
        lastCommitMs: 123,
        stagedItems: 9,
        databaseBytes: 5_000_000,
        historyShortened: true,
      }),
    });
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => recorded.events.length === 1);
    const event = recorded.events[0];
    if (event?.kind !== "command") return;
    s.respond(event.request, {
      ok: true,
      result: {
        kind: "status",
        sensors: [],
        alarm: null,
        sirens: [],
        gateways: [],
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
      },
    });
    await client.until(() => client.lines.length === 1);
    expect(client.json()[0]).toMatchObject({
      reply: {
        result: {
          lastCommitMs: 123,
          stagedItems: 9,
          databaseBytes: 5_000_000,
          historyShortened: true,
        },
      },
    });
  });

  test("a reply the schema refuses is not sent as it is: the client hears 'failed', and it is recorded", async () => {
    const { server: s, recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => recorded.events.length === 1);
    const event = recorded.events[0];
    if (event?.kind !== "command") return;
    s.respond(event.request, { ok: true, result: { kind: "deviceRename", name: "has space" } });
    await client.until(() => client.lines.length === 1);
    expect(client.json()[0]).toMatchObject({
      id: 7,
      reply: { ok: false, error: { code: "failed" } },
    });
    expect(recorded.rejections.map((r) => r.reason)).toEqual(["badReply"]);
  });

  test("a request before the core listens is answered 'the hub is starting'", async () => {
    const where = folder();
    const opened = await UnixControlServer.open({
      socketPath: where.socket,
      logQuery: () => err({ kind: "storage", origin: "t", message: "x" }),
      deviceIdOf: () => undefined,
      writerStatus: () => ({
        lastCommitMs: null,
        stagedItems: 0,
        databaseBytes: null,
        historyShortened: false,
      }),
      onRejected: () => undefined,
    });
    const s = opened._unsafeUnwrap();
    servers.push(s);
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => client.lines.length === 1);
    expect(client.json()[0]).toMatchObject({
      id: 7,
      reply: { ok: false, error: { code: "failed" } },
    });
  });

  test("a reply for a client that has gone is dropped", async () => {
    const { server: s, recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => recorded.events.length === 1);
    client.end();
    await client.until(() => client.closed);
    const event = recorded.events[0];
    if (event?.kind === "command")
      s.respond(event.request, { ok: false, error: { code: "failed", message: "late" } });
    expect(client.lines).toEqual([]);
  });
});

describe("lines that are not requests", () => {
  test("not JSON: answered with id 0 and recorded, never executed", async () => {
    const { recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write("{not json\n");
    await client.until(() => client.lines.length === 1);
    expect(client.json()).toEqual([
      {
        id: UNREAD_REQUEST_ID,
        reply: {
          ok: false,
          error: { code: "badRequest", message: "a request is one line of JSON" },
        },
      },
    ]);
    expect(recorded.rejections).toEqual([{ reason: "notJson", bytes: 9, issues: [] }]);
    expect(recorded.events).toEqual([]);
  });

  test("JSON that is not a request: answered with its id when it has one, recorded without its values", async () => {
    const { recorded, where } = await server();
    const client = new RawClient(where.socket);
    const secret = "my-wifi-password-123";
    client.write(
      `${JSON.stringify({ id: 5, actor: "a", command: { kind: "siteWifi", name: "home", password: [secret] } })}\n`,
    );
    client.write(
      `${JSON.stringify({ id: 6, actor: "a", command: { kind: "arm", sensors: [], continue: false } })}\n`,
    );
    await client.until(() => client.lines.length === 2);
    expect(client.json()).toMatchObject([
      { id: 5, reply: { ok: false, error: { code: "badRequest" } } },
      { id: 6, reply: { ok: false, error: { code: "badRequest" } } },
    ]);
    expect(recorded.events).toEqual([]);
    expect(JSON.stringify(recorded.rejections).includes(secret)).toBe(false);
    expect(recorded.rejections.map((r) => r.reason)).toEqual(["badShape", "badShape"]);
  });

  test(`a line of exactly ${MAX_REQUEST_LINE_BYTES} bytes is read; one byte more is refused and the connection closed`, async () => {
    const { recorded, where } = await server();
    const exact = JSON.stringify(STATUS).padEnd(MAX_REQUEST_LINE_BYTES, " ");
    const client = new RawClient(where.socket);
    client.write(`${exact}\n`);
    await client.until(() => recorded.events.length === 1);
    expect(recorded.events).toHaveLength(1);
    const long = new RawClient(where.socket);
    long.write(JSON.stringify(STATUS).padEnd(MAX_REQUEST_LINE_BYTES + 1, " "));
    await long.until(() => long.closed);
    expect(long.json()).toMatchObject([
      { id: UNREAD_REQUEST_ID, reply: { ok: false, error: { code: "badRequest" } } },
    ]);
    expect(recorded.rejections).toEqual([
      { reason: "tooLong", bytes: MAX_REQUEST_LINE_BYTES + 1, issues: [] },
    ]);
    // The core is told, so the refusal reaches the audit record (section 9).
    expect(recorded.refused).toEqual([
      {
        kind: "inputRejected",
        rejection: {
          source: "control",
          reason: "tooLong",
          bytes: MAX_REQUEST_LINE_BYTES + 1,
          issues: [],
        },
      },
    ]);
    expect(recorded.events).toHaveLength(1);
  });

  test("a request split across writes, even inside a character, is read whole", async () => {
    const { recorded, where } = await server();
    const bytes = new TextEncoder().encode(
      `${JSON.stringify({ id: 3, actor: "Zoë", command: { kind: "status" } })}\n`,
    );
    const client = new RawClient(where.socket);
    const split = bytes.indexOf(0xc3) + 1;
    client.write(bytes.slice(0, split));
    await settle(20);
    client.write(bytes.slice(split));
    await client.until(() => recorded.events.length === 1);
    expect(recorded.events[0]).toMatchObject({ actor: "Zoë" });
  });

  test("a partial line when the client hangs up is recorded and never executed", async () => {
    const { recorded, where } = await server();
    const client = new RawClient(where.socket);
    await client.connected();
    client.write(JSON.stringify(STATUS));
    client.end();
    await client.until(() => client.closed);
    await settle();
    expect(recorded.events).toEqual([]);
    expect(recorded.rejections).toEqual([
      { reason: "partial", bytes: JSON.stringify(STATUS).length, issues: [] },
    ]);
  });

  test(`more than ${MAX_WAITING_REQUESTS} requests waiting on one connection close it`, async () => {
    const { recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(
      Array.from(
        { length: MAX_WAITING_REQUESTS + 3 },
        (_, i) => `${JSON.stringify({ ...STATUS, id: i })}\n`,
      ).join(""),
    );
    await client.until(() => client.closed);
    expect(recorded.rejections.map((r) => r.reason)).toEqual(["tooMany"]);
  });
});

describe("hsn log and --follow (section 3: never polled)", () => {
  const LOG = {
    id: 9,
    actor: "dimitri",
    command: { kind: "log", follow: true, logKind: "rx", device: "front" },
  };

  test("the log command goes to the core to be recorded, is read once, and streams what is published", async () => {
    const { server: s, recorded, where } = await server({ records: [rx(3, 10)] });
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify(LOG)}\n`);
    await client.until(() => client.lines.length === 1);
    expect(recorded.events.map((e) => e.kind)).toEqual(["command"]);
    expect(recorded.queries).toEqual([{ device: "front", logKind: "rx" }]);
    expect(client.json()[0]).toEqual({
      id: 9,
      reply: { ok: true, result: { kind: "log", records: [recordJson(rx(3, 10))] } },
    });
    s.publish(rx(3, 20));
    s.publish(rx(4, 21));
    s.publish(hubEvent(22));
    s.publish(rx(3, 23));
    await client.until(() => client.lines.length === 3);
    expect(client.json().slice(1)).toEqual([
      { id: 9, record: recordJson(rx(3, 20)) },
      { id: 9, record: recordJson(rx(3, 23)) },
    ]);
    expect(recorded.queries).toHaveLength(1);
    expect(s.followers()).toHaveLength(1);
  });

  test("a follower that hangs up is forgotten", async () => {
    const { server: s, where } = await server();
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify({ ...LOG, command: { kind: "log", follow: true } })}\n`);
    await client.until(() => client.lines.length === 1);
    client.end();
    await client.until(() => client.closed);
    await settle();
    expect(s.followers()).toEqual([]);
  });

  test("a line sent on a following connection is not executed", async () => {
    const { recorded, where } = await server();
    const client = new RawClient(where.socket);
    client.write(`${JSON.stringify({ ...LOG, command: { kind: "log", follow: true } })}\n`);
    await client.until(() => client.lines.length === 1);
    client.write(`${JSON.stringify(STATUS)}\n`);
    await client.until(() => recorded.rejections.length === 1);
    expect(recorded.rejections.map((r) => r.reason)).toEqual(["following"]);
    expect(recorded.events).toHaveLength(1);
  });

  test("an unknown device, or a log that cannot be read, is answered with the reason", async () => {
    const { where } = await server({
      logQuery: () => err({ kind: "storage", origin: "t", message: "disk" }),
    });
    const client = new RawClient(where.socket);
    client.write(
      `${JSON.stringify({ ...LOG, command: { kind: "log", follow: false, device: "nobody" } })}\n`,
    );
    client.write(
      `${JSON.stringify({ ...LOG, id: 10, command: { kind: "log", follow: false } })}\n`,
    );
    await client.until(() => client.lines.length === 2);
    expect(client.json()).toMatchObject([
      { id: 9, reply: { ok: false, error: { code: "unknownDevice" } } },
      { id: 10, reply: { ok: false, error: { code: "failed" } } },
    ]);
  });

  test("--since applies to streamed records too", async () => {
    const { server: s, where } = await server();
    const client = new RawClient(where.socket);
    client.write(
      `${JSON.stringify({ ...LOG, command: { kind: "log", follow: true, since: 100 } })}\n`,
    );
    await client.until(() => client.lines.length === 1);
    s.publish(hubEvent(99));
    s.publish(hubEvent(100));
    await client.until(() => client.lines.length === 2);
    await settle();
    expect(client.lines).toHaveLength(2);
  });
});

describe("the line reader", () => {
  test("lines across chunks, an empty line, and the limit exactly", () => {
    const reader = new LineReader(5);
    const enc = new TextEncoder();
    expect(reader.push(enc.encode("ab"))).toEqual([]);
    expect(reader.push(enc.encode("c\n\nhello\nxy"))).toEqual([
      { kind: "line", text: "abc" },
      { kind: "line", text: "" },
      { kind: "line", text: "hello" },
    ]);
    expect(reader.end()).toBe(2);
    expect(reader.push(enc.encode("123456"))).toEqual([{ kind: "tooLong", bytes: 6 }]);
    expect(reader.push(enc.encode("\n"))).toEqual([]);
  });
});

test("keys the server never sees cannot leak through it", () => {
  noteKey(new Uint8Array(16).fill(0x5a));
  expectNoKeyLeaks();
});
