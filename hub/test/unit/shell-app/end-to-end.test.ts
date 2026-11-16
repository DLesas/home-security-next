/**
 * The channel end to end on the real hub (m2-design.md section 11, step 2's "done when", first
 * part): the hub process started as `main.ts` starts it, with its listeners wired; a console
 * client linked with the one-time token `hsn open` asks for, over the console's plain listener;
 * its session, a `snapshot`, and one change (`link.create` for a new person); then that person's
 * client linked and in session over the home network's HTTPS listener, with a `snapshot` and a
 * change of its own. Every handshake is the real Noise code, every byte crosses a real socket.
 *
 * Then an export both ways (section 6, the wave 2 ruling): `hsn backup export` over the control
 * socket and `backup.export` over a session, each byte for byte the file `writeBackup` makes of the
 * same database with the export's own header; and each cut half-way, by the session closing after
 * its first chunk and by the hub killed under `hsn` after its first chunk, with nothing saved and
 * the hub (restarted, after the kill) exporting whole again.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import {
  appIdentityBytes,
  APP_PATHS,
  BACKUP_FORMAT,
  backupCodec,
  linkPrologue,
  NOISE_PATTERNS,
  parseConsoleFragment,
  parseLinkFragment,
  secretLookup,
  secretPsk,
  sessionPrologue,
  startHandshake,
  type StaticKey,
  type TransportSession,
  x25519StaticKey,
} from "@hsn/protocol/app";
import { sha256 } from "@noble/hashes/sha2.js";
import { ok } from "neverthrow";
import { exchange } from "../../../cli/client.ts";
import { writeBackup } from "../../../src/shell/backup/write.ts";
import { homeAddresses } from "../../../src/shell/hub-facts.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";

// The tests' entry: `main.ts`'s, with the clock synchronised on any Linux (`test/world`).
const MAIN = join(import.meta.dir, "..", "..", "world", "hub-entry.ts");
const HSN = join(import.meta.dir, "..", "..", "..", "cli", "hsn.ts");
const root = mkdtempSync("/tmp/hsn-e2e-");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});

function must<T>(
  result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string },
): T {
  expect(result.ok ? "ok" : result.error).toBe("ok");
  return (result as { readonly value: T }).value;
}

function json(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function parse(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes)) as Record<string, unknown>;
}

/** A free TCP port on this computer, by asking the system for one. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** A WebSocket with every binary message kept, read in order. */
class Socket {
  readonly #inbox: Uint8Array[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  private constructor(readonly ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string")
        this.#inbox.push(new Uint8Array(event.data as ArrayBuffer));
      this.#wake?.();
    };
    ws.onclose = () => {
      this.#closed = true;
      this.#wake?.();
    };
  }

  static open(url: string, origin: string): Promise<Socket> {
    const ws = new WebSocket(url, {
      headers: { Origin: origin },
      tls: { rejectUnauthorized: false },
    } as unknown as string[]);
    const socket = new Socket(ws);
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        resolve(socket);
      };
      ws.onerror = () => {
        reject(new Error(`${url} did not open`));
      };
    });
  }

  send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  async next(ms = 5000): Promise<Uint8Array> {
    const deadline = Date.now() + ms;
    for (;;) {
      const message = this.#inbox.shift();
      if (message !== undefined) return message;
      if (this.#closed || Date.now() > deadline) {
        expect("a message from the hub").toBe("none came");
        return new Uint8Array(0);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.#wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}

function staticKeyOf(seed: number): StaticKey {
  return must(x25519StaticKey(sha256(Uint8Array.of(seed, 0x2e))));
}

/** XXpsk3 as a new client: message 1 naming the token, 2 read, 3 with the link request, 4 read. */
async function link(
  socket: Socket,
  secret: Uint8Array,
  key: StaticKey,
  request: unknown,
): Promise<{
  readonly result: Record<string, unknown>;
  readonly hubKey: Uint8Array;
  readonly message2: Record<string, unknown>;
}> {
  const hs = must(
    startHandshake({
      pattern: NOISE_PATTERNS.link,
      initiator: true,
      prologue: linkPrologue("link"),
      staticKey: key,
      psk: secretPsk(sha256, secret),
    }),
  );
  socket.send(
    must(await hs.writeMessage(json({ proto: [1, 1], find: secretLookup(sha256, secret) }))),
  );
  const message2 = parse(must(await hs.readMessage(await socket.next())));
  socket.send(must(await hs.writeMessage(json(request))));
  const transport = must(hs.split());
  const result = parse(must(transport.decrypt(await socket.next())));
  const hubKey = hs.remoteStatic();
  expect(hubKey).toBeDefined();
  return { result, hubKey: hubKey ?? new Uint8Array(32), message2 };
}

/** A client's last `seq`, which its sessions share: it is per client, not per session. */
interface Seqs {
  last: number;
}

/** An IK session: message 1, `HubHello`, then requests and their replies, events skipped. */
class Session {
  #nextId = 1;

  private constructor(
    readonly socket: Socket,
    readonly transport: TransportSession,
    readonly hello: Record<string, unknown>,
    readonly seqs: Seqs,
  ) {}

  static async open(
    socket: Socket,
    key: StaticKey,
    hubKey: Uint8Array,
    seqs: Seqs = { last: 0 },
  ): Promise<Session> {
    const hs = must(
      startHandshake({
        pattern: NOISE_PATTERNS.session,
        initiator: true,
        prologue: sessionPrologue(appIdentityBytes(sha256, hubKey)),
        staticKey: key,
        remoteStatic: hubKey,
      }),
    );
    socket.send(must(await hs.writeMessage(json({ proto: [1, 1], app: "e2e" }))));
    const hello = parse(must(await hs.readMessage(await socket.next())));
    return new Session(socket, must(hs.split()), hello, seqs);
  }

  /** A request; a change takes the next `seq`. Resolves with its reply. */
  async request(op: string, body: unknown, change = false): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    const frame = { t: "req", id, ...(change ? { seq: ++this.seqs.last } : {}), op, body };
    this.socket.send(must(this.transport.encrypt(json(frame))));
    for (;;) {
      const message = parse(must(this.transport.decrypt(await this.socket.next())));
      if (message.t === "res" && message.id === id) return message;
    }
  }

  /**
   * `backup.export`: the reply `{job}` first, then that job's chunks in order of `n` to the end
   * mark (its count and SHA-256 checked) or `fileFailed`. With `cutAfter`, the session closes
   * after that many chunks: the file is not whole, and nothing is kept.
   */
  async export(
    cutAfter?: number,
    onReply?: () => void,
    history = false,
  ): Promise<{
    readonly bytes: Uint8Array | undefined;
    readonly chunks: number;
    readonly failed: string | undefined;
  }> {
    const id = this.#nextId++;
    const frame = {
      t: "req",
      id,
      seq: ++this.seqs.last,
      op: "backup.export",
      body: { history },
    };
    this.socket.send(must(this.transport.encrypt(json(frame))));
    let job: number | undefined;
    const parts: Uint8Array[] = [];
    for (;;) {
      const message = parse(must(this.transport.decrypt(await this.socket.next())));
      if (message.t === "res" && message.id === id) {
        // Read before any `expect`: Bun's `toMatchObject` writes its matchers into what it checks.
        job = (message.body as { job?: unknown } | undefined)?.job as number | undefined;
        expect(message.ok).toBe(true);
        expect(typeof job).toBe("number");
        onReply?.();
        continue;
      }
      if (message.ev === "fileFailed") {
        expect(job).toBeDefined();
        return {
          bytes: undefined,
          chunks: parts.length,
          failed: (message.body as { reason: string }).reason,
        };
      }
      if (message.ev !== "fileChunk") continue;
      // No chunk before the reply.
      expect(job).toBeDefined();
      const chunk = message.body as {
        job: number;
        n: number;
        data: string;
        end?: { chunks: number; sha256: string };
      };
      if (chunk.job !== job) continue;
      expect(chunk.n).toBe(parts.length);
      parts.push(new Uint8Array(Buffer.from(chunk.data, "base64url")));
      if (chunk.end !== undefined) {
        const bytes = new Uint8Array(Buffer.concat(parts));
        expect(chunk.end.chunks).toBe(parts.length);
        expect(chunk.end.sha256).toBe(Buffer.from(sha256(bytes)).toString("hex"));
        return { bytes, chunks: parts.length, failed: undefined };
      }
      if (cutAfter !== undefined && parts.length >= cutAfter) {
        this.socket.ws.close();
        return { bytes: undefined, chunks: parts.length, failed: undefined };
      }
    }
  }
}

/** The hub process on a data folder, with its app listeners on these ports. */
function startHub(
  dataDir: string,
  lanPort: number,
  consolePort: number,
): ReturnType<typeof Bun.spawn> {
  return spawnTracked(
    [
      "bun",
      MAIN,
      "--data",
      dataDir,
      "--port",
      "0",
      "--no-usb-watch",
      "--app-ports",
      `${lanPort},${consolePort}`,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
}

/** Until the hub answers on its control socket, then a moment for the listeners, which open last. */
async function answering(sock: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (existsSync(sock)) {
      const status = await exchange(
        sock,
        { id: 1, actor: "e2e", command: { kind: "status" } },
        1000,
      );
      if (status.isOk()) break;
    }
    await Bun.sleep(50);
  }
  await Bun.sleep(500);
}

/** `hsn` itself, as a person runs it. */
async function hsn(
  args: readonly string[],
): Promise<{ readonly code: number; readonly out: string; readonly err: string }> {
  const run = spawnTracked(["bun", HSN, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  return { code, out, err: errText };
}

/**
 * The file the hub would write of its database as it is now (`writeBackup`, the daily backup's
 * own code), with the export's header (its salt and time), into a folder of its own.
 */
function fileTheHubWouldWrite(dataDir: string, exported: Uint8Array): Uint8Array<ArrayBuffer> {
  const header = backupCodec.readHeader(exported.subarray(0, BACKUP_FORMAT.headerBytes));
  expect(header.ok).toBe(true);
  if (!header.ok) return new Uint8Array(0);
  const db = new Database(join(dataDir, "hub.db"));
  const key = db
    .query<{ key: Uint8Array; epoch: number }, []>("SELECT key, epoch FROM backup_key")
    .get();
  expect(key).not.toBeNull();
  const folder = mkdtempSync(join(root, "would-"));
  const written = writeBackup(
    db,
    { folder, keep: 1, key: new Uint8Array(key?.key ?? []), epoch: key?.epoch ?? 0 },
    { nowMs: () => header.value.madeMs, salt: () => ok(header.value.salt) },
  );
  db.close();
  expect(written.kind).toBe("backupWritten");
  return written.kind === "backupWritten"
    ? new Uint8Array(readFileSync(join(folder, written.name)))
    : new Uint8Array(0);
}

/** The audit tables whose rows carry a `seq` (section 6). */
const SEQ_TABLES = [
  "rx_routine",
  "rx_event",
  "tx_routine",
  "tx_event",
  "decisions",
  "device_log",
  "hub_events",
  "commands",
  "notifications",
  "notification_reads",
] as const;

/**
 * A history file holds every record the audit tables held up to its first line's `upToSeq`, in
 * `seq` order, none twice, and every reject and daily loss row then present.
 */
function expectWholeHistory(dataDir: string, file: Uint8Array): void {
  const lines = decoder
    .decode(file)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const head = lines[0] as { format?: string; upToSeq?: number } | undefined;
  expect(head?.format).toBe("hsn-history/1");
  const upTo = head?.upToSeq ?? 0;
  const seqs = lines.flatMap((line) => {
    const row = line.row as { seq?: unknown } | undefined;
    return typeof row?.seq === "number" ? [row.seq] : [];
  });
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual(seqs.toSorted((a, b) => a - b));
  const db = new Database(join(dataDir, "hub.db"));
  const held = SEQ_TABLES.flatMap((table) =>
    db
      .query<{ seq: number }, [number]>(`SELECT seq FROM "${table}" WHERE seq <= ?`)
      .all(upTo)
      .map((r) => r.seq),
  ).toSorted((a, b) => a - b);
  const rejects = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM rejects`).get()?.n ?? 0;
  const losses = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM loss_daily`).get()?.n ?? 0;
  db.close();
  expect(held.length).toBeGreaterThan(0);
  expect(seqs).toEqual(held);
  expect(lines.filter((line) => line.kind === "reject")).toHaveLength(rejects);
  expect(lines.filter((line) => line.kind === "lossDaily")).toHaveLength(losses);
}

/**
 * A control connection passed through as it is, but slow: after the first line that carries a
 * chunk it stops reading from the hub, `atFirstChunk` runs (the test kills the hub there), then it
 * passes on whatever the hub had sent before it went, and ends.
 */
async function slowControlLink(
  hubSocket: string,
  path: string,
  atFirstChunk: () => Promise<void>,
): Promise<{ close(): void }> {
  const server = createServer((client) => {
    const hub = connect(hubSocket);
    client.on("data", (bytes) => hub.write(bytes));
    client.on("close", () => hub.destroy());
    hub.on("close", () => client.end());
    hub.on("error", () => undefined);
    client.on("error", () => undefined);
    let held = false;
    let text = "";
    hub.on("data", (bytes: Buffer) => {
      if (held) {
        client.write(bytes);
        return;
      }
      text += bytes.toString("latin1");
      for (let at = text.indexOf("\n"); at >= 0 && !held; at = text.indexOf("\n")) {
        const line = text.slice(0, at + 1);
        text = text.slice(at + 1);
        client.write(Buffer.from(line, "latin1"));
        if (line.includes('"fileChunk"')) {
          held = true;
          hub.pause();
          void atFirstChunk().then(() => {
            if (text.length > 0) client.write(Buffer.from(text, "latin1"));
            hub.resume();
          });
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });
  return {
    close: () => {
      server.close();
    },
  };
}

/** The console linked on its own listener with `hsn open`'s token: its key and the hub's. */
async function linkConsole(
  sock: string,
  consolePort: number,
): Promise<{ readonly key: StaticKey; readonly hubKey: Uint8Array; readonly origin: string }> {
  const asked = await exchange(
    sock,
    { id: 1, actor: "e2e", command: { kind: "consoleToken" } },
    5000,
  );
  const reply = asked._unsafeUnwrap().reply.reply;
  const url = reply.ok && reply.result.kind === "consoleToken" ? reply.result.url : "";
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16);
  const origin = `http://127.0.0.1:${consolePort}`;
  const key = staticKeyOf(3);
  const linked = await link(
    await Socket.open(`ws://127.0.0.1:${consolePort}${APP_PATHS.link}`, origin),
    secret,
    key,
    { name: "The hub computer", kind: "web" },
  );
  return { key, hubKey: linked.hubKey, origin };
}

describe("the channel end to end on the real hub (m2-design.md section 11)", () => {
  test("hsn open's token links the console; its session links a person over HTTPS", async () => {
    const dataDir = mkdtempSync(join(root, "d"));
    const lanPort = await freePort();
    const consolePort = await freePort();
    spawnTracked(
      [
        "bun",
        MAIN,
        "--data",
        dataDir,
        "--port",
        "0",
        "--no-usb-watch",
        "--app-ports",
        `${lanPort},${consolePort}`,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    const sock = join(dataDir, "control.sock");
    for (let i = 0; i < 200 && !existsSync(sock); i++) await Bun.sleep(50);
    // The listeners open last; give them a moment after the socket.
    await Bun.sleep(500);

    // `hsn open`'s request on the control socket: a one-time console token.
    const asked = await exchange(
      sock,
      { id: 1, actor: "e2e", command: { kind: "consoleToken" } },
      5000,
    );
    const reply = asked._unsafeUnwrap().reply.reply;
    expect(reply.ok).toBe(true);
    const url = reply.ok && reply.result.kind === "consoleToken" ? reply.result.url : "";
    expect(url.startsWith(`http://127.0.0.1:${String(consolePort)}/#console=`)).toBe(true);
    const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16);

    // The console's link, on its own plain listener.
    const consoleOrigin = `http://127.0.0.1:${consolePort}`;
    const consoleKey = staticKeyOf(1);
    const linked = await link(
      await Socket.open(`ws://127.0.0.1:${consolePort}${APP_PATHS.link}`, consoleOrigin),
      secret,
      consoleKey,
      { name: "The hub computer", kind: "web" },
    );
    expect(linked.message2).toMatchObject({ proto: 1, askName: false });
    expect(linked.result).toMatchObject({ person: null });
    const hubKey = linked.hubKey;

    // Its session: the snapshot, then one change.
    const consoleSession = await Session.open(
      await Socket.open(`ws://127.0.0.1:${consolePort}${APP_PATHS.session}`, consoleOrigin),
      consoleKey,
      hubKey,
    );
    expect(consoleSession.hello).toMatchObject({
      proto: 1,
      client: { kind: "console", person: null },
    });
    const snapshot = await consoleSession.request("snapshot", {});
    expect(snapshot).toMatchObject({ ok: true, body: { mode: { mode: 2 } } });
    const made = await consoleSession.request(
      "link.create",
      { kind: { newPerson: { name: "Anna" } }, form: "url" },
      true,
    );
    expect(made.ok).toBe(true);
    // A history page (section 7): read by the shell, committed rows and staged ones, newest first.
    const history = await consoleSession.request("history.query", { limit: 50 });
    expect(history.ok).toBe(true);
    const rows = (history.body as { rows: { kind: string; row: { actor?: string } }[] }).rows;
    expect(rows.some((r) => r.kind === "command")).toBe(true);
    const address = (made.body as { url?: string }).url ?? "";
    const fragment = parseLinkFragment(address.slice(address.indexOf("#") + 1));
    expect(fragment).toBeDefined();

    // A person's browser on the home network: linked and in session over HTTPS.
    const home = homeAddresses().find((a) => !a.includes(":"));
    if (home === undefined) {
      console.log("end to end: this computer has no IPv4 address on a network; HTTPS part skipped");
      return;
    }
    const lanOrigin = `https://${home}:${lanPort}`;
    const annaKey = staticKeyOf(2);
    const anna = await link(
      await Socket.open(`wss://${home}:${lanPort}${APP_PATHS.link}`, lanOrigin),
      fragment?.secret ?? new Uint8Array(16),
      annaKey,
      { name: "Anna's laptop", kind: "web" },
    );
    expect(anna.result).toMatchObject({ person: expect.any(Number) as unknown as number });
    expect(anna.hubKey).toEqual(hubKey);
    const annaSession = await Session.open(
      await Socket.open(`wss://${home}:${lanPort}${APP_PATHS.session}`, lanOrigin),
      annaKey,
      hubKey,
    );
    expect(annaSession.hello).toMatchObject({ client: { kind: "web" } });
    expect(await annaSession.request("snapshot", {})).toMatchObject({ ok: true });
    const renamed = await annaSession.request(
      "client.rename",
      { client: anna.result.client, name: "Anna's work laptop" },
      true,
    );
    expect(renamed).toMatchObject({ ok: true });
  }, 60_000);

  test("an export over the control socket and over a session is the file the hub would write; cut half-way, nothing is saved", async () => {
    const dataDir = mkdtempSync(join(root, "x"));
    const lanPort = await freePort();
    const consolePort = await freePort();
    const sock = join(dataDir, "control.sock");
    const hub = startHub(dataDir, lanPort, consolePort);
    await answering(sock);

    // `hsn backup export` over the control socket: the whole file, byte for byte.
    const viaControl = join(root, "control.hsnb");
    const exported = await hsn(["--data", dataDir, "backup", "export", viaControl]);
    expect(exported.err).toBe("");
    expect(exported.code).toBe(0);
    const controlBytes = new Uint8Array(readFileSync(viaControl));
    expect(controlBytes.length).toBeGreaterThan(2 * 48_000);
    expect(controlBytes).toEqual(fileTheHubWouldWrite(dataDir, controlBytes));

    // Over a session (the console's): the whole file, byte for byte.
    const linkedConsole = await linkConsole(sock, consolePort);
    const consoleSeqs: Seqs = { last: 0 };
    const session = async (): Promise<Session> =>
      Session.open(
        await Socket.open(
          `ws://127.0.0.1:${consolePort}${APP_PATHS.session}`,
          linkedConsole.origin,
        ),
        linkedConsole.key,
        linkedConsole.hubKey,
        consoleSeqs,
      );
    const whole = await (await session()).export();
    expect(whole.failed).toBeUndefined();
    expect(whole.chunks).toBeGreaterThan(2);
    const sessionBytes = whole.bytes ?? new Uint8Array(0);
    expect(sessionBytes).toEqual(fileTheHubWouldWrite(dataDir, sessionBytes));

    // With history (`hsn-history/1`, section 9), both ways: every record the audit tables held
    // when it began, none twice.
    const historyFile = join(root, "history.jsonl");
    const viaHsn = await hsn(["--data", dataDir, "backup", "export", historyFile, "--history"]);
    expect(viaHsn.err).toBe("");
    expectWholeHistory(dataDir, new Uint8Array(readFileSync(historyFile)));
    // A history export is not a backup: restore refuses it as badFile (section 9).
    const restored = await hsn(["--data", dataDir, "restore", historyFile]);
    expect(restored.code).not.toBe(0);
    expect(restored.err).toContain("badFile");
    console.log(`end to end: hsn restore of a history export: ${restored.err.trim()}`);
    const overSession = await (await session()).export(undefined, undefined, true);
    expect(overSession.failed).toBeUndefined();
    expectWholeHistory(dataDir, overSession.bytes ?? new Uint8Array(0));

    // The session stops half-way: closed after its first chunk. Nothing whole was had; the hub
    // goes on, and the next session's export is whole.
    const cut = await (await session()).export(1);
    expect(cut).toEqual({ bytes: undefined, chunks: 1, failed: undefined });
    const after = await (await session()).export();
    expect(after.bytes).toEqual(fileTheHubWouldWrite(dataDir, after.bytes ?? new Uint8Array(0)));

    // The hub stops half-way under `hsn backup export`: killed after its first chunk. `hsn` says
    // nothing was saved, and neither the file nor its temporary one is there.
    const slowPath = join(root, "slow.sock");
    let killedAt = "";
    const slow = await slowControlLink(sock, slowPath, async () => {
      killedAt = "after its first chunk";
      hub.kill(9);
      await hub.exited;
    });
    const viaKilled = join(root, "killed.hsnb");
    const killed = await hsn(["--socket", slowPath, "backup", "export", viaKilled]);
    slow.close();
    console.log(`end to end: hsn when the hub was killed half-way: ${killed.err.trim()}`);
    expect(killedAt).toBe("after its first chunk");
    expect(hub.signalCode).toBe("SIGKILL");
    expect(killed.code).not.toBe(0);
    expect(existsSync(viaKilled)).toBe(false);
    expect(existsSync(`${viaKilled}.part`)).toBe(false);

    // Started again on the same folder: the export is whole again, over a session and over `hsn`.
    const second = startHub(dataDir, lanPort, consolePort);
    await answering(sock);
    const again = await (await session()).export();
    expect(again.bytes).toEqual(fileTheHubWouldWrite(dataDir, again.bytes ?? new Uint8Array(0)));
    const viaAgain = join(root, "again.hsnb");
    expect((await hsn(["--data", dataDir, "backup", "export", viaAgain])).code).toBe(0);
    const againBytes = new Uint8Array(readFileSync(viaAgain));
    expect(againBytes).toEqual(fileTheHubWouldWrite(dataDir, againBytes));

    // A clean stop (SIGTERM) as soon as an export's reply came, its pieces under way: the hub stops
    // cleanly, and the session has either the whole file or `fileFailed {stopping}`, never a cut.
    const stopped = await (
      await session()
    ).export(undefined, () => {
      second.kill("SIGTERM");
    });
    console.log(
      `end to end: an export when the hub stopped: ${stopped.failed === undefined ? `whole, ${String(stopped.chunks)} chunks` : `fileFailed ${stopped.failed} after ${String(stopped.chunks)} chunks`}`,
    );
    expect(stopped.failed === "stopping" || stopped.bytes !== undefined).toBe(true);
    expect(await second.exited).toBe(0);
  }, 90_000);
});
