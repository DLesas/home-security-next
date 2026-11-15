/**
 * The channel client against the real hub (the second pass): `hub/src/shell/main.ts` as a process,
 * reached on its console listener as the hub computer's browser reaches it, and on the home
 * network's HTTPS listener when this computer has an address there. Every behaviour first tested
 * against the test hub end runs here, except those a real hub cannot be made to show on demand,
 * which stay in `channel.test.ts` and say why there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  formatTypedCode,
  parseConsoleFragment,
  parseLinkFragment,
  parseTypedCode,
  typedSecretBytes,
} from "@hsn/protocol/app";
import { createHubClient, type HubClient } from "../src/hub/client";
import { linkBrowser } from "../src/hub/handshake";
import { memoryRecordStore, type RecordStore, type StoredClient } from "../src/platform/client-key";
import { type Connect, realTimers, type Wire } from "../src/hub/wire";
import { connectFrom, type RealHub, startRealHub, stopAllHubs } from "./support/real-hub";

const CONSOLE_NAME = { name: "The hub computer", kind: "web" } as const;
let hub: RealHub;
let consoleClient: HubClient;
let consoleRecords: RecordStore;

async function until(check: () => boolean, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

async function stored(records: RecordStore): Promise<StoredClient> {
  const read = await records.read();
  if (!read.ok || read.value === undefined) throw new Error("no record");
  return read.value;
}

function clientOn(connect: Connect, records: RecordStore = memoryRecordStore()): HubClient {
  return createHubClient({ connect, records, timers: realTimers, app: "0.1.0" });
}

/** A `Connect` that logs each send and can close a session's socket just after its next send. */
function watched(connect: Connect, log: string[]): Connect & { closeAfterNextSend(): void } {
  let closeNext = false;
  const wrapped = (async (path, handlers) => {
    const wire = await connect(path, handlers);
    if (wire === undefined) return undefined;
    const out: Wire = {
      send: (data) => {
        log.push(`send:${path}`);
        wire.send(data);
        if (closeNext && path === "session") {
          closeNext = false;
          // A close at a chosen instant: the request has left, its reply will find no socket.
          wire.close(1001);
        }
      },
      close: (code) => {
        wire.close(code);
      },
    };
    return out;
  }) as Connect & { closeAfterNextSend(): void };
  wrapped.closeAfterNextSend = () => {
    closeNext = true;
  };
  return wrapped;
}

beforeAll(async () => {
  hub = await startRealHub();
  consoleRecords = memoryRecordStore();
  consoleClient = clientOn(connectFrom(hub.consoleOrigin), consoleRecords);
  consoleClient.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  if (secret === undefined) throw new Error(`no console code in ${url}`);
  await consoleClient.link(
    { kind: "secret", secret, identity: undefined },
    "console",
    CONSOLE_NAME,
  );
  await until(() => consoleClient.live.getState().connection.kind === "open");
}, 60_000);

afterAll(async () => {
  await stopAllHubs();
});

describe("linking and the session, on the real hub", () => {
  test("hsn open's code links a console client; its session opens and the snapshot is applied", async () => {
    expect(consoleClient.local.getState().link).toEqual({ kind: "linked", from: "console" });
    const live = consoleClient.live.getState();
    expect(live.session?.kind).toBe("console");
    expect(live.session?.person).toBeNull();
    expect(live.mode).toEqual({ mode: 2, modified: false });
    expect(
      Object.values(live.modes)
        .map((m) => m.fixed)
        .sort(),
    ).toEqual(["away", "disarmed"]);
    expect(live.notificationPrefs?.categories.length).toBe(6);
    const record = await stored(consoleRecords);
    expect(record.key.privateKey.extractable).toBe(false);
    expect(record.lastSeq).toBeGreaterThanOrEqual(0);
  }, 20_000);

  test("a used console code is refused before message 2", async () => {
    const url = await hub.consoleCode();
    const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16);
    const first = await linkBrowser(
      connectFrom(hub.consoleOrigin),
      { kind: "secret", secret, identity: undefined },
      CONSOLE_NAME,
      realTimers,
    );
    expect(first.ok).toBe(true);
    const again = await linkBrowser(
      connectFrom(hub.consoleOrigin),
      { kind: "secret", secret, identity: undefined },
      CONSOLE_NAME,
      realTimers,
    );
    expect(again).toEqual({ ok: false, fault: "refused" });
  });

  test("a link address whose identity is not the hub's stops before message 3; the code still works after", async () => {
    const made = await consoleClient.request("link.create", {
      kind: { newPerson: { name: "Cara" } },
      form: "url",
    });
    if (!made.ok || made.body.url === undefined) throw new Error(JSON.stringify(made));
    const link = parseLinkFragment(made.body.url.slice(made.body.url.indexOf("#") + 1));
    if (link === undefined) throw new Error(made.body.url);
    const origin = hub.lanOrigin ?? hub.consoleOrigin;
    const wrong = await linkBrowser(
      connectFrom(origin),
      { kind: "secret", secret: link.secret, identity: "a".repeat(26) },
      { name: "Cara's laptop", kind: "web" },
      realTimers,
    );
    expect(wrong).toEqual({ ok: false, fault: "wrongHub" });
    const right = await linkBrowser(
      connectFrom(origin),
      { kind: "secret", secret: link.secret, identity: link.identity },
      { name: "Cara's laptop", kind: "web" },
      realTimers,
    );
    expect(right.ok && right.value.hub.person !== null).toBe(true);
  });

  test("a typed code for a new person: the hub asks for the name (askName), the link is made with it", async () => {
    const made = await consoleClient.request("link.create", {
      kind: { newPerson: {} },
      form: "code",
    });
    if (!made.ok || made.body.code === undefined) throw new Error(JSON.stringify(made));
    const code = parseTypedCode(made.body.code);
    if (code === undefined) throw new Error(made.body.code);
    const records = memoryRecordStore();
    const ben = clientOn(connectFrom(hub.lanOrigin ?? hub.consoleOrigin), records);
    await ben.link({ kind: "typed", code }, "typed", { name: "Ben's browser", kind: "web" });
    expect(ben.local.getState().link).toEqual({ kind: "askingName", from: "typed" });
    await ben.giveName("Ben");
    expect(ben.local.getState().link).toEqual({ kind: "linked", from: "typed" });
    const people = await consoleClient.request("people.list", {});
    expect(people.ok && people.body.people.map((p) => p.name)).toContain("Ben");
    expect((await stored(records)).hub.person).not.toBeNull();
  });

  test("a mistyped code is not accepted; after five, the code is void", async () => {
    await Bun.sleep(1100);
    const made = await consoleClient.request("link.create", {
      kind: { newPerson: { name: "Dev" } },
      form: "code",
    });
    if (!made.ok || made.body.code === undefined) throw new Error(JSON.stringify(made));
    const code = parseTypedCode(made.body.code);
    if (code === undefined) throw new Error(made.body.code);
    const mistyped = parseTypedCode(
      formatTypedCode({ tokenId: code.tokenId, secret: code.secret ^ 1n }) ?? "",
    );
    if (mistyped === undefined) throw new Error("code");
    const connect = connectFrom(hub.lanOrigin ?? hub.consoleOrigin);
    const tries = [];
    for (let i = 0; i < 5; i++) {
      // Spaced, under the hub's 10 handshakes a second from one address, which it refuses unread.
      await Bun.sleep(150);
      tries.push(
        (
          await linkBrowser(
            connect,
            { kind: "typed", code: mistyped },
            { name: "x", kind: "web" },
            realTimers,
          )
        ).ok,
      );
    }
    // A second's pause, so the try below is not refused as one handshake too many (section 5).
    await Bun.sleep(1100);
    const after = await linkBrowser(
      connect,
      { kind: "typed", code },
      { name: "Dev's browser", kind: "web" },
      realTimers,
    );
    expect(tries).toEqual([false, false, false, false, false]);
    expect(after).toEqual({ ok: false, fault: "refused" });
  });
});

describe("requests and seq, on the real hub", () => {
  test("a change's seq is on storage before its request leaves", async () => {
    const log: string[] = [];
    const base = memoryRecordStore();
    const records: RecordStore = {
      ...base,
      update: async (change) => {
        const out = await base.update(change);
        if (out.ok && out.value !== undefined) log.push(`stored:${String(out.value.lastSeq)}`);
        return out;
      },
    };
    const url = await hub.consoleCode();
    const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16);
    const client = clientOn(watched(connectFrom(hub.consoleOrigin), log), records);
    client.start();
    await client.link({ kind: "secret", secret, identity: undefined }, "console", CONSOLE_NAME);
    await until(() => client.live.getState().connection.kind === "open");
    await Bun.sleep(200);
    log.length = 0;
    const outcome = await client.request("notifications.prefs", { categories: ["batteryLow"] });
    expect(outcome.ok).toBe(true);
    expect(log.slice(0, 2)).toEqual(["stored:1", "send:session"]);
  });

  test("a change whose reply was lost goes again with the same seq, and the hub answers it as a repeat", async () => {
    const log: string[] = [];
    const connect = watched(connectFrom(hub.consoleOrigin), log);
    const records = memoryRecordStore();
    const client = clientOn(connect, records);
    client.start();
    const url = await hub.consoleCode();
    await client.link(
      {
        kind: "secret",
        secret: parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16),
        identity: undefined,
      },
      "console",
      CONSOLE_NAME,
    );
    await until(() => client.live.getState().connection.kind === "open");
    await Bun.sleep(200);
    connect.closeAfterNextSend();
    const outcome = await client.request("site.set", { countdown: 31 });
    expect(outcome).toMatchObject({ ok: true, repeat: true, body: { countdownS: 31 } });
    expect((await stored(records)).lastSeq).toBe(1);
  }, 20_000);

  test("seqTooLow: past the 16 replies the hub keeps, the client moves its seq up and the change is made", async () => {
    for (let i = 0; i < 17; i++)
      expect((await consoleClient.request("site.set", { countdown: 20 + i })).ok).toBe(true);
    const before = (await stored(consoleRecords)).lastSeq;
    await consoleRecords.update((r) => ({ ...r, lastSeq: 0 }));
    const outcome = await consoleClient.request("site.set", { countdown: 45 });
    expect(outcome).toMatchObject({ ok: true, body: { countdownS: 45 } });
    expect((await stored(consoleRecords)).lastSeq).toBe(before + 1);
  }, 30_000);

  test("a refusal from the hub is passed on as it came, in its schema", async () => {
    const outcome = await consoleClient.request("mode.delete", { mode: 1, ifRevision: 0 });
    expect(outcome.ok).toBe(false);
    expect("error" in outcome && outcome.error.code).toBe("invalid");
  });
});

describe("events, removal and reconnection, on the real hub", () => {
  test("a change reaches the store as an event: a schedule entry, a mode switch", async () => {
    const entry = await consoleClient.request("schedule.create", {
      name: "Bedtime",
      action: "switchMode",
      target: { mode: 1 },
      at: "22:00",
      days: "everyDay",
      enabled: true,
    });
    if (!entry.ok) throw new Error(JSON.stringify(entry));
    expect(
      await until(() => consoleClient.live.getState().schedules[entry.body.id]?.name === "Bedtime"),
    ).toBe(true);
  }, 20_000);

  test("a removed browser is told (the session event), stops, and is refused before message 2 after", async () => {
    const made = await consoleClient.request("link.create", {
      kind: { newPerson: { name: "Eve" } },
      form: "url",
    });
    if (!made.ok || made.body.url === undefined) throw new Error(JSON.stringify(made));
    const link = parseLinkFragment(made.body.url.slice(made.body.url.indexOf("#") + 1));
    if (link === undefined) throw new Error("url");
    const connect = connectFrom(hub.lanOrigin ?? hub.consoleOrigin);
    const records = memoryRecordStore();
    const eve = clientOn(connect, records);
    eve.start();
    await eve.link(
      { kind: "secret", secret: link.secret, identity: link.identity },
      "linkAddress",
      { name: "Eve's laptop", kind: "web" },
    );
    expect(await until(() => eve.live.getState().connection.kind === "open")).toBe(true);
    const id = (await stored(records)).hub.client;
    expect((await consoleClient.request("client.remove", { client: id, also: [] })).ok).toBe(true);
    expect(await until(() => eve.live.getState().connection.kind === "removed")).toBe(true);
    // Removed: nothing more is sent, and a request says so (not "offline").
    expect(await eve.request("site.set", { countdown: 30 })).toEqual({
      ok: false,
      local: "removed",
    });
    const again = clientOn(connect, memoryRecordStore(await stored(records)));
    again.start();
    expect(
      await until(() => {
        const c = again.live.getState().connection;
        return c.kind === "waiting" && c.failure === "refused";
      }),
    ).toBe(true);
  }, 30_000);

  test("out of touch while the hub is stopped: requests fail at once and take no seq; it reconnects to the new boot", async () => {
    const before = consoleClient.live.getState().session?.boot ?? 0;
    const seq = (await stored(consoleRecords)).lastSeq;
    await hub.stop();
    expect(await until(() => consoleClient.live.getState().connection.kind === "waiting")).toBe(
      true,
    );
    expect(await consoleClient.request("site.set", { countdown: 30 })).toEqual({
      ok: false,
      local: "offline",
    });
    expect((await stored(consoleRecords)).lastSeq).toBe(seq);
    await hub.start();
    expect(
      await until(() => consoleClient.live.getState().session?.boot === before + 1, 20_000),
    ).toBe(true);
    expect(consoleClient.live.getState().connection.kind).toBe("open");
    // The new boot's snapshot carries the configuration made before (a schedule entry, above).
    expect(Object.values(consoleClient.live.getState().schedules).map((e) => e.name)).toContain(
      "Bedtime",
    );
  }, 60_000);

  test("a read whose session closes before its reply fails, in words", async () => {
    const log: string[] = [];
    const connect = watched(connectFrom(hub.consoleOrigin), log);
    const client = clientOn(connect);
    client.start();
    const url = await hub.consoleCode();
    await client.link(
      {
        kind: "secret",
        secret: parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16),
        identity: undefined,
      },
      "console",
      CONSOLE_NAME,
    );
    await until(() => client.live.getState().connection.kind === "open");
    await Bun.sleep(200);
    connect.closeAfterNextSend();
    expect(await client.request("people.list", {})).toEqual({ ok: false, local: "lost" });
  }, 20_000);

  test("the hub's ping, after 20 s quiet, is answered: the session is still open past it", async () => {
    const log: string[] = [];
    const client = clientOn(watched(connectFrom(hub.consoleOrigin), log));
    client.start();
    const url = await hub.consoleCode();
    await client.link(
      {
        kind: "secret",
        secret: parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16),
        identity: undefined,
      },
      "console",
      CONSOLE_NAME,
    );
    await until(() => client.live.getState().connection.kind === "open");
    await Bun.sleep(500);
    log.length = 0;
    await Bun.sleep(23_000);
    expect(log).toContain("send:session");
    expect(client.live.getState().connection.kind).toBe("open");
  }, 40_000);
});

describe("files and reads, on the real hub", () => {
  test("hub.info and hub.status read as their schemas say", async () => {
    expect((await consoleClient.request("hub.info", {})).ok).toBe(true);
    expect((await consoleClient.request("hub.status", {})).ok).toBe(true);
  });

  test("an export comes as chunks after its reply, checked by count and hash: a backup file", async () => {
    const { downloadFile } = await import("../src/hub/files");
    const got = await downloadFile(consoleClient, false, realTimers);
    if (!got.ok || !("bytes" in got)) throw new Error(JSON.stringify(got));
    expect(new TextDecoder().decode(got.bytes.subarray(0, 4))).toBe("HSNB");
  }, 30_000);

  test("a history export is a readable JSON Lines file, hsn-history/1; restore refuses it as badFile", async () => {
    const { downloadFile, sendFile, uploadJob } = await import("../src/hub/files");
    const { isHistoryExport } = await import("../src/ui/backup");
    const got = await downloadFile(consoleClient, true, realTimers);
    if (!got.ok || !("bytes" in got)) throw new Error(JSON.stringify(got));
    const first = new TextDecoder().decode(got.bytes).split("\n")[0] ?? "";
    expect((JSON.parse(first) as { format?: string }).format).toBe("hsn-history/1");
    expect(isHistoryExport(got.bytes)).toBe(true);
    const job = uploadJob();
    expect((await sendFile(consoleClient, job, got.bytes)).ok).toBe(true);
    expect(await consoleClient.request("restore.start", { job })).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { reason: "badFile" } },
    });
  }, 60_000);

  test("a group with an empty list of sirens is refused (section 7)", async () => {
    expect(
      await consoleClient.request("group.create", { name: "Silent", sensors: [], sirens: [] }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { field: "sirens" } },
    });
  });

  test("an upload goes in chunks the shell takes, each answered", async () => {
    const { sendFile, uploadJob } = await import("../src/hub/files");
    const sent = await sendFile(
      consoleClient,
      uploadJob(),
      crypto.getRandomValues(new Uint8Array(100_000)),
    );
    expect(sent.ok).toBe(true);
  }, 30_000);
});

/**
 * Five answers the real hub first gave otherwise than m2-design.md says (the second pass), now
 * as the design says: kept as plain tests, so a return of any of them fails.
 */
describe("the real hub as the design says (once differences)", () => {
  test("group.create and mode.create are made (section 6: MS)", async () => {
    const group = await consoleClient.request("group.create", {
      name: "Upstairs",
      sensors: [],
      sirens: "all",
    });
    expect(group.ok).toBe(true);
    // Its config event reaches the store.
    if (group.ok)
      expect(
        await until(() => consoleClient.live.getState().groups[group.body.id]?.name === "Upstairs"),
      ).toBe(true);
    const mode = await consoleClient.request("mode.create", { name: "Night", groups: [] });
    expect(mode.ok).toBe(true);
  });

  test("a mode switch sends an arming event with the new mode (section 6)", async () => {
    expect((await consoleClient.request("mode.switch", { mode: 1 })).ok).toBe(true);
    const seen = await until(() => consoleClient.live.getState().mode?.mode === 1, 3000);
    await consoleClient.request("mode.switch", { mode: 2 });
    expect(seen).toBe(true);
  }, 15_000);

  test("history.query is answered (sections 5 and 7: every request is), with the requests made", async () => {
    const history = await Promise.race([
      consoleClient.request("history.query", { limit: 50 }),
      Bun.sleep(4000).then(() => "no reply in 4 s"),
    ]);
    expect(typeof history === "object" && history.ok).toBe(true);
    if (typeof history === "object" && history.ok)
      expect(history.body.rows.some((r) => r.kind === "command")).toBe(true);
    if (typeof history === "object" && history.ok)
      expect(history.body.rows.some((r) => r.kind === "command")).toBe(true);
  }, 10_000);

  test("a file that is not a release is refused invalid {badFile} (section 9)", async () => {
    const { sendFile, uploadJob } = await import("../src/hub/files");
    const job = uploadJob();
    expect((await sendFile(consoleClient, job, new Uint8Array(1000))).ok).toBe(true);
    const staged = await consoleClient.request("update.upload", { job });
    expect(staged).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { reason: "badFile" } },
    });
  }, 30_000);

  test("a file that is not a backup is refused invalid {badFile} (section 9)", async () => {
    const { sendFile, uploadJob } = await import("../src/hub/files");
    const job = uploadJob();
    expect((await sendFile(consoleClient, job, new Uint8Array(1000))).ok).toBe(true);
    const read = await consoleClient.request("restore.start", { job });
    expect(read).toMatchObject({
      ok: false,
      error: { code: "invalid", detail: { reason: "badFile" } },
    });
  }, 30_000);
});

describe("the store and the tabs, on the real hub", () => {
  test("its state is plain data and holds nothing secret, at every step of linking, the name asked included", async () => {
    const made = await consoleClient.request("link.create", {
      kind: { newPerson: {} },
      form: "code",
    });
    if (!made.ok || made.body.code === undefined) throw new Error(JSON.stringify(made));
    const code = parseTypedCode(made.body.code);
    if (code === undefined) throw new Error(made.body.code);
    const records = memoryRecordStore();
    const client = clientOn(connectFrom(hub.lanOrigin ?? hub.consoleOrigin), records);
    const seen: unknown[] = [];
    client.live.subscribe((s) => seen.push(s));
    client.local.subscribe((s) => seen.push(s));
    client.start();
    await client.link({ kind: "typed", code }, "typed", { name: "Fay's browser", kind: "web" });
    await client.giveName("Fay");
    expect(await until(() => client.live.getState().connection.kind === "open")).toBe(true);
    await Bun.sleep(300);
    const state = client.live.getState();
    expect(structuredClone(state)).toEqual(state);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const text = JSON.stringify(seen);
    const record = await stored(records);
    const secret = typedSecretBytes(code.secret);
    for (const bytes of [secret, record.key.publicKey]) {
      expect(text).not.toContain(Buffer.from(bytes).toString("hex"));
      expect(text).not.toContain(Buffer.from(bytes).toString("base64url"));
    }
    expect(text).not.toContain(made.body.code);
    expect(text).not.toContain(made.body.code.replaceAll("-", ""));
    const walk = (value: unknown): boolean =>
      value instanceof Uint8Array ||
      value instanceof CryptoKey ||
      (typeof value === "object" && value !== null && Object.values(value).some(walk));
    expect(seen.some(walk)).toBe(false);
    client.stop();
  }, 20_000);

  test("two tabs, one session; the other sees the state and sends through it; a new holder takes over", async () => {
    const url = await hub.consoleCode();
    const records = memoryRecordStore();
    const linked = await linkBrowser(
      connectFrom(hub.consoleOrigin),
      {
        kind: "secret",
        secret: parseConsoleFragment(url.slice(url.indexOf("#") + 1)) ?? new Uint8Array(16),
        identity: undefined,
      },
      CONSOLE_NAME,
      realTimers,
    );
    if (!linked.ok) throw new Error(linked.fault);
    await records.write(linked.value);
    const log: string[] = [];
    const sessions = () => log.filter((l) => l === "open:session").length;
    const counted: Connect = async (path, handlers) => {
      const wire = await connectFrom(hub.consoleOrigin)(path, handlers);
      if (wire !== undefined) log.push(`open:${path}`);
      return wire;
    };
    const { busHub, lockManager } = await import("./support/tabs");
    const locks = lockManager();
    const bus = busHub();
    const aLocks = locks();
    const aBus = bus("a");
    const a = createHubClient({
      connect: counted,
      records,
      timers: realTimers,
      app: "0.1.0",
      tabs: { id: "a", locks: aLocks, bus: aBus },
    });
    a.start();
    expect(await until(() => a.live.getState().connection.kind === "open")).toBe(true);
    const b = createHubClient({
      connect: counted,
      records,
      timers: realTimers,
      app: "0.1.0",
      tabs: { id: "b", locks: locks(), bus: bus("b") },
    });
    b.start();
    expect(
      await until(
        () => b.live.getState().connection.kind === "open" && b.live.getState().session !== null,
      ),
    ).toBe(true);
    expect(sessions()).toBe(1);
    const sent = await b.request("site.set", { countdown: 33 });
    expect(sent).toMatchObject({ ok: true, body: { countdownS: 33 } });
    expect((await stored(records)).lastSeq).toBe(1);
    // Tab a closes: its session goes, and b opens its own.
    a.stop();
    aBus.close();
    expect(await until(() => sessions() === 2)).toBe(true);
    expect(await until(() => b.live.getState().connection.kind === "open")).toBe(true);
    expect((await b.request("site.set", { countdown: 34 })).ok).toBe(true);
    expect((await stored(records)).lastSeq).toBe(2);
    b.stop();
  }, 30_000);
});
