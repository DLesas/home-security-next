/**
 * The channel client against the test hub end, for what the real hub cannot be made to do on
 * demand (the second pass): each test says what it needs. Everything else about the channel runs
 * against the real hub, in `real-hub.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { APP_RECONNECT_MS } from "@hsn/protocol/app";
import { HubEnd } from "./support/hub-end";
import { manualTimers, settle } from "./support/timers";
import { CLIENT_LIVENESS_MS, RETRY_WINDOW_MS } from "../src/hub/channel";
import { createHubClient } from "../src/hub/client";
import { memoryRecordStore, type RecordStore, type StoredClient } from "../src/platform/client-key";

const NAME = { name: "Hub computer", kind: "web" } as const;

async function linked(hub: HubEnd, records: RecordStore = memoryRecordStore()) {
  const timers = manualTimers();
  const client = createHubClient({ connect: hub.connect, records, timers, app: "0.1.0" });
  client.start();
  await settle();
  const secret = hub.tokenWithSecret("console");
  await client.link({ kind: "secret", secret, identity: undefined }, "console", NAME);
  await settle();
  return { client, records, timers };
}

async function stored(records: RecordStore): Promise<StoredClient> {
  const read = await records.read();
  if (!read.ok || read.value === undefined) throw new Error("no record");
  return read.value;
}

describe("requests and seq", () => {
  // Hub end: Needs a reply the hub makes but never sends, and 30 s on a hand-moved clock: the real hub always sends its replies.
  test("a lost change is not sent again after 30 s: the hub did not confirm it, and the next snapshot shows the house", async () => {
    const hub = new HubEnd();
    let done = 0;
    hub.handle("mode.switch", () => {
      done += 1;
      return {
        ok: true,
        body: { armed: [], disarmed: [], waiting: [], lowBattery: [], heldBack: [] },
      };
    });
    const { client, timers } = await linked(hub);
    hub.dropReplies = true;
    const outcome = client.request("mode.switch", { mode: 1 });
    await settle();
    hub.reachable = false;
    hub.dropAll();
    await settle();
    timers.advance(RETRY_WINDOW_MS);
    expect(await outcome).toEqual({ ok: false, local: "unconfirmed" });
    hub.reachable = true;
    hub.dropReplies = false;
    timers.advance(10_000);
    await settle();
    expect(client.live.getState().connection.kind).toBe("open");
    expect(hub.seen.filter((r) => r.op === "mode.switch")).toHaveLength(1);
    expect(hub.seen.filter((r) => r.op === "snapshot")).toHaveLength(2);
    expect(done).toBe(1);
  });

  // Hub end: Needs a hub that answers seqTooLow to the retry too: the real hub cannot be made to.
  test("a second seqTooLow is shown, not retried again", async () => {
    const hub = new HubEnd();
    hub.handle("site.set", (_body, c) => {
      c.lastSeq += 100;
      return { ok: false, error: { code: "seqTooLow", detail: { last: c.lastSeq } } };
    });
    const { client } = await linked(hub);
    const outcome = await client.request("site.set", { rate: 3 });
    expect(outcome.ok).toBe(false);
    expect(hub.seen.filter((r) => r.op === "site.set")).toHaveLength(2);
  });

  // Hub end: Needs a malformed answer, which the real hub never gives.
  test("a reply that does not match its operation's schema is refused", async () => {
    const hub = new HubEnd();
    // A deliberately wrong body, to see the client refuse it.
    hub.handle("hub.info", () => ({ ok: true, body: { wrong: true } as never }));
    const { client } = await linked(hub);
    expect(await client.request("hub.info", {})).toEqual({ ok: false, local: "badReply" });
  });
});

describe("identity", () => {
  // Hub end: needs a hub whose HubHello names another client's number, which the real hub never does.
  test("a session whose HubHello names another client's number is refused", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    expect(client.live.getState().connection.kind).toBe("open");
    hub.helloClientOverride = 99;
    hub.dropAll();
    await settle();
    timers.advance(APP_RECONNECT_MS[0]);
    await settle();
    expect(client.live.getState().connection).toMatchObject({
      kind: "waiting",
      failure: "protocol",
    });
    expect(client.live.getState().session?.client).not.toBe(99);
  });

  test("an extractable key is refused: the browser cannot be linked (K1)", async () => {
    const { makeClientKey } = await import("../src/platform/keys.web");
    const real = crypto.subtle;
    // A stand-in for Web Crypto whose generateKey ignores `extractable: false`, as a faulty browser might.
    const leaky = {
      generateKey: (algorithm: AlgorithmIdentifier, _extractable: boolean, usages: KeyUsage[]) =>
        real.generateKey(algorithm, true, usages),
      exportKey: (format: "raw", key: CryptoKey) => real.exportKey(format, key),
    } as unknown as SubtleCrypto;
    expect(await makeClientKey(leaky)).toEqual({ ok: false, fault: "extractable" });
    const fine = await makeClientKey(real);
    expect(fine.ok && fine.value.privateKey.extractable).toBe(false);
  });
});

describe("what the client refuses from a hub (faults the real hub cannot be made to show)", () => {
  // Hub end: a HubHello naming a version this build does not speak.
  test("a HubHello with a version outside the client's range is refused", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    hub.helloProtoOverride = 2;
    hub.dropAll();
    await settle();
    timers.advance(APP_RECONNECT_MS[0]);
    await settle();
    expect(client.live.getState().connection).toMatchObject({
      kind: "waiting",
      failure: "protocol",
    });
  });

  // Hub end: a message 4 that is not a LinkResult.
  test("a message 4 that is not a LinkResult is refused; nothing is kept", async () => {
    const hub = new HubEnd();
    hub.linkResultOverride = { client: "seven" };
    const records = memoryRecordStore();
    const client = createHubClient({
      connect: hub.connect,
      records,
      timers: manualTimers(),
      app: "0.1.0",
    });
    await client.link(
      { kind: "secret", secret: hub.tokenWithSecret("console"), identity: undefined },
      "console",
      NAME,
    );
    expect(client.local.getState().link).toEqual({
      kind: "failed",
      from: "console",
      failure: "protocol",
    });
    expect(await records.read()).toEqual({ ok: true, value: undefined });
  });

  // Hub end: a snapshot refused, which the real hub never does to a linked client.
  test("a refused snapshot closes the session, and the client opens a new one", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    hub.handle("snapshot", () => ({ ok: false, error: { code: "unavailable", detail: {} } }));
    const before = hub.connections;
    hub.dropAll();
    await settle();
    timers.advance(APP_RECONNECT_MS[0]);
    await settle();
    expect(hub.connections).toBe(before + 1);
    expect(client.live.getState().connection.kind).toBe("waiting");
  });

  test("a browser not linked sends nothing: requests say so", async () => {
    const hub = new HubEnd();
    const client = createHubClient({
      connect: hub.connect,
      records: memoryRecordStore(),
      timers: manualTimers(),
      app: "0.1.0",
    });
    client.start();
    await settle();
    expect(await client.request("snapshot", {})).toEqual({ ok: false, local: "notLinked" });
    expect(hub.connections).toBe(0);
  });

  test("a public key that is not 32 bytes is refused", async () => {
    const { makeClientKey } = await import("../src/platform/keys.web");
    const real = crypto.subtle;
    const short = {
      generateKey: (a: AlgorithmIdentifier, e: boolean, u: KeyUsage[]) => real.generateKey(a, e, u),
      exportKey: async (f: "raw", k: CryptoKey) => (await real.exportKey(f, k)).slice(1),
    } as unknown as SubtleCrypto;
    expect(await makeClientKey(short)).toEqual({ ok: false, fault: "failed" });
  });
});

describe("events, liveness and reconnection", () => {
  // Hub end: Needs events at chosen revisions, at and below the snapshot's: the real hub's revisions are its own.
  test("events after the snapshot are applied; those at or below its rev are dropped; a gap is nothing", async () => {
    const hub = new HubEnd();
    hub.snapshot = {
      ...hub.snapshot,
      devices: [],
      sensors: [{ id: 4, arm: "disarmed", door: "closed", countdownSecondsLeft: null }],
    };
    const { client } = await linked(hub);
    const rev = client.live.getState().rev ?? 0;
    hub.rev = rev - 1;
    hub.emit("door", { sensor: 4, open: true, atMs: 1 }); // rev = snapshot's: already in it
    await settle();
    expect(client.live.getState().sensors[4]?.door).toBe("closed");
    hub.rev = rev + 5;
    hub.emit("door", { sensor: 4, open: true, atMs: 2 });
    await settle();
    expect(client.live.getState().sensors[4]?.door).toBe("open");
    expect(client.live.getState().rev).toBe(rev + 6);
    expect(hub.seen.filter((r) => r.op === "snapshot")).toHaveLength(1);
  });

  // Hub end: Needs a hub that sends bytes which do not decrypt: a fault the real hub cannot be made to show.
  test("a message that does not decrypt closes the socket, and the client opens a new session", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    const before = hub.connections;
    hub.sendRaw(new Uint8Array(40).fill(1));
    await settle();
    expect(client.live.getState().connection.kind).toBe("waiting");
    timers.advance(APP_RECONNECT_MS[0]);
    await settle();
    expect(hub.connections).toBe(before + 1);
    expect(client.live.getState().connection.kind).toBe("open");
    expect(hub.seen.filter((r) => r.op === "snapshot")).toHaveLength(2);
  });

  // Hub end: Needs the client's clock moved by hand to read each delay; the real hub is only unreachable.
  test("reconnecting waits 1, 2, 4, then every 10 s", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    hub.reachable = false;
    hub.dropAll();
    await settle();
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const state = client.live.getState().connection;
      if (state.kind !== "waiting") throw new Error(state.kind);
      waits.push(state.retryInMs);
      timers.advance(state.retryInMs);
      await settle();
    }
    expect(waits).toEqual([1000, 2000, 4000, 10_000, 10_000]);
    expect([...APP_RECONNECT_MS]).toEqual([1000, 2000, 4000, 10_000]);
  });

  // Hub end: Needs a hub that goes silent on an open session (the real one pings every 20 s) and a hand-moved clock.
  test("a session nothing has come from for 60 s is closed by the client and opened again", async () => {
    const hub = new HubEnd();
    const { client, timers } = await linked(hub);
    const before = hub.connections;
    timers.advance(CLIENT_LIVENESS_MS);
    await settle();
    expect(client.live.getState().connection.kind).toBe("waiting");
    timers.advance(APP_RECONNECT_MS[0]);
    await settle();
    expect(hub.connections).toBe(before + 1);
  });

  // Hub end: Needs a minute and more of refusals on a hand-moved clock.
  test("five refusals in a row over a minute: perhaps removed, and linking again offered; fewer: not", async () => {
    const hub = new HubEnd();
    const { client, records, timers } = await linked(hub);
    const record = await stored(records);
    const hubClient = hub.clients.get(record.hub.client);
    if (hubClient === undefined) throw new Error("client");
    hubClient.removed = true;
    hub.dropAll();
    await settle();
    const seen: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const state = client.live.getState().connection;
      if (state.kind !== "waiting") throw new Error(state.kind);
      timers.advance(state.retryInMs);
      await settle();
      const after = client.live.getState().connection;
      if (after.kind === "waiting") seen.push(after.mayBeRemoved);
    }
    // Refusals at 1, 3, 7, 17, 27 and 37 s after the drop: the fifth in a row, but within a minute.
    expect(seen).toEqual([false, false, false, false, false, false]);
    timers.advance(30_000);
    await settle();
    for (let i = 0; i < 3; i++) {
      timers.advance(10_000);
      await settle();
    }
    const last = client.live.getState().connection;
    expect(last.kind === "waiting" && last.mayBeRemoved).toBe(true);
    hubClient.removed = false;
    timers.advance(10_000);
    await settle();
    expect(client.live.getState().connection.kind).toBe("open");
    hub.dropAll();
    await settle();
    const fresh = client.live.getState().connection;
    expect(fresh.kind === "waiting" && fresh.mayBeRemoved).toBe(false);
  });
});
