/** A real hub's v2 snapshot proves what the linked phone registered and subsequently removed. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { parseConsoleFragment, snapshotObjectV2 } from "@hsn/protocol/app";
import { createHubClient } from "../src/hub/client";
import { NO_FINDER, readCode, type SocketLike } from "../src/hub/finder";
import {
  disarmFromNotification,
  phoneFirst,
  type PhoneDeps,
  startPhoneClient,
} from "../src/hub/phone-client";
import { pushLifecycle } from "../src/hub/push";
import { PHONE_PROTO } from "../src/hub/restore";
import { realTimers } from "../src/hub/wire";
import { memoryRecordStore, reserveSeq } from "../src/platform/client-key";
import * as keys from "../src/platform/keys.native";
import { S1, siteSnapshot } from "../../hub/test/unit/firmware/support";
import { seedPairingSite } from "./support/pairing-site";
import { hasStoredTarget } from "../src/platform/push-types";
import { fakePush } from "../src/platform/push-device.fake";
import { itemsOf, memorySecureItems } from "../src/platform/vault";
import { manualTimers } from "./support/timers";
import { HubEnd } from "./support/hub-end";
import { phoneSockets } from "./support/phone-sockets";
import type { PhoneRecords } from "../src/platform/vault";
import { phoneHomes } from "../src/ui/homes";
import { connectFrom, startRealHub, stopAllHubs } from "./support/real-hub";

// Bun accepts headers and TLS options on the client WebSocket, which the DOM declaration omits.
declare const WebSocket: new (
  url: string,
  options: {
    headers: { Origin: string };
    tls: { rejectUnauthorized: boolean };
  },
) => SocketLike;

/** Connects to the local real hub with its test certificate and the phone origin. */
function localSocket(address: string, origin: string): SocketLike {
  return new WebSocket(address, {
    headers: { Origin: origin },
    tls: { rejectUnauthorized: false },
  });
}

afterAll(stopAllHubs);

/** Waits only for a linked client's first authenticated snapshot. */
async function ready(read: () => boolean) {
  const end = Date.now() + 15000;
  while (!read() && Date.now() < end) await Bun.sleep(50);
  assert(read(), "session ready");
}
/** Obtains one real invitation without putting its secret in failure output. */
async function invitation(hub: Awaited<ReturnType<typeof startRealHub>>) {
  const owner = createHubClient({
    connect: connectFrom(hub.consoleOrigin),
    records: memoryRecordStore(),
    timers: realTimers,
    app: "0.1.0",
  });
  owner.start();
  const url = await hub.consoleCode();
  const secret = parseConsoleFragment(url.slice(url.indexOf("#") + 1));
  assert(secret, "console invitation");
  await owner.link({ kind: "secret", secret, identity: undefined }, "console", {
    name: "Console",
    kind: "web",
  });
  await ready(() => owner.live.getState().session !== null);
  const invite = await owner.request("link.create", {
    kind: { newPerson: { name: "Resident" } },
    form: "qr",
  });
  assert(invite.ok && invite.body.qr, "created invite");
  owner.stop();
  const code = readCode(invite.body.qr);
  assert(code.ok && code.value.kind === "link", "phone invitation");
  return code.value.secret;
}

/** Reads only whether this hub persisted the expected non-secret device address. */
function holdsToken(hub: Awaited<ReturnType<typeof startRealHub>>, token: string): boolean {
  const db = new Database(join(hub.dataDir, "hub.db"), { readonly: true });
  const row = db
    .query("SELECT 1 FROM push_targets WHERE token=? AND invalid_ms IS NULL")
    .get(token);
  db.close(true);
  return row !== null;
}

test("registers a real target, then home removal unregisters it before deleting its key", async () => {
  const hub = await startRealHub((dir) => {
    const snapshot = siteSnapshot();
    const sensor = snapshot.devices.find((d) => d.id === S1);
    const config = snapshot.sensorConfig.find((c) => c.deviceId === S1);
    assert(sensor && config, "fixture sensor");
    assert(
      seedPairingSite(dir, [
        { table: "devices", op: "upsert", row: sensor },
        { table: "sensor_config", op: "upsert", row: config },
      ]),
    );
  });
  const invite = await invitation(hub);
  const fake = fakePush();

  const push = pushLifecycle(fake.storage, fake.tokens, realTimers);
  const items = memorySecureItems();
  const deps: PhoneDeps = {
    items,
    push,
    keys,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    finder: NO_FINDER,
    makeSocket: localSocket,
  };
  const phone = startPhoneClient(deps);
  phone.client.start();
  await phone.client.link(invite, "qr", { name: "Phone", kind: "phone" });
  await ready(() => phone.client.live.getState().session !== null);
  /** Reads the persisted target through a fresh authenticated snapshot. */
  async function snapshot() {
    const result = await phone.forward("snapshot", {});
    assert(result.ok, "snapshot reply");
    const parsed = snapshotObjectV2.safeParse(result.body);
    assert(parsed.success, "version two snapshot");
    return parsed.data;
  }
  const before = await snapshot();
  const id = before.hub.identity;
  assert(before.push?.valid === false, "target initially absent");
  // A running app receives the OS callback after the initial snapshot with no configured token.
  fake.token({ platform: "fcm", environment: "production", token: "local-token" });
  await ready(() => fake.keys.get(id)?.active != null);
  expect((await snapshot()).push).toEqual({ registered: true, valid: true });
  expect(fake.armed.get(id)).toBe(false);
  expect((await phone.client.request("arm", { target: { sensor: S1 } })).ok).toBe(true);
  await ready(() => fake.armed.get(id) === true);
  // A second authenticated session uses first; the open UI and headless operation share seq allocation.
  expect(await disarmFromNotification(id, Date.now() + 5000, phone.records, deps)).toBe(true);
  expect(await disarmFromNotification(id, Date.now() - 1, phone.records, deps)).toBe(false);
  await ready(() => fake.armed.get(id) === false);
  const first = fake.keys.get(id)?.active;
  expect((await phone.forward("push.unregister", {})).ok).toBe(true);
  // Reconnection sees a missing target and installs it again without a new OS token.
  await phone.choose(id);
  await ready(() => phone.client.live.getState().session !== null);
  const deadline = Date.now() + 5000;
  while (!(await snapshot()).push?.valid && Date.now() < deadline) await Bun.sleep(30);
  expect((await snapshot()).push?.valid).toBe(true);
  expect(fake.keys.get(id)?.active?.body.keyId === first?.body.keyId).toBe(true);
  let unregistered = 0;
  const homes = phoneHomes({
    records: phone.records,
    choose: (identity) => phone.choose(identity),
    live: phone.client.live,
    request: (op, body) => phone.client.request(op, body),
    unregister: async () => {
      const r = await phone.forward("push.unregister", {});
      expect((await snapshot()).push).toEqual({ registered: false, valid: false });
      unregistered++;
      return r;
    },
    pushRegistered: (identity) => hasStoredTarget(fake.storage, identity),
    timers: realTimers,
    defaultName: () => "Home",
  });
  await homes.refresh();
  expect((await homes.rename(id, "Cottage")).ok).toBe(true);
  expect(fake.names()[id]).toBe("Cottage");
  // A failed push-key erasure keeps all vault items until the normal removal sweep retries it.
  const removeKey = fake.storage.remove.bind(fake.storage);
  fake.storage.remove = () => Promise.resolve({ ok: false, fault: "storage" });
  expect((await homes.remove(id)).ok).toBe(false);
  expect(fake.keys.has(id)).toBe(true);
  expect(fake.names()[id]).toBeUndefined();
  expect(items.writes.some((write) => write.startsWith("-"))).toBe(false);
  fake.storage.remove = removeKey;
  expect((await phone.records.sweep()).ok).toBe(true);
  expect(items.writes.some((write) => write.startsWith("-"))).toBe(true);
  expect(unregistered).toBe(1);
  expect(fake.keys.has(id)).toBe(false);
  expect(fake.armed.has(id)).toBe(false);
  push.stop();
  phone.client.stop();
}, 60000);

test("a changed device token updates both real homes without switching the open session, and retries unreachable debt on restart", async () => {
  const a = await startRealHub();
  const b = await startRealHub();
  const fake = fakePush();
  const items = memorySecureItems();
  const token = (value: string) => {
    fake.token({ platform: "fcm", environment: "production", token: value });
  };
  token("first-token");
  /** Starts a new process-equivalent phone client over the same persisted vault and target records. */
  function boot() {
    const attempts = new Map<number, number>();
    const lifecycle = pushLifecycle(fake.storage, fake.tokens, realTimers);
    const phone = startPhoneClient({
      items,
      push: lifecycle,
      keys,
      timers: realTimers,
      app: "0.1.0",
      proto: PHONE_PROTO,
      finder: NO_FINDER,
      makeSocket: (address, origin) => {
        const port = Number(new URL(address).port);
        attempts.set(port, (attempts.get(port) ?? 0) + 1);
        return localSocket(address, origin);
      },
    });
    phone.client.start();
    return {
      attempts,
      phone,
      stop: () => {
        lifecycle.stop();
        phone.client.stop();
      },
    };
  }
  let app = boot();
  await app.phone.client.link(await invitation(a), "qr", { name: "Phone", kind: "phone" });
  await ready(() => holdsToken(a, "first-token"));
  const idA = app.phone.client.live.getState().hub?.identity;
  assert(idA, "first home");
  await app.phone.client.link(await invitation(b), "qr", { name: "Phone", kind: "phone" });
  await ready(() => holdsToken(b, "first-token"));
  const live = app.phone.client.live;
  const homeB = live.getState().hub?.identity;
  const originalSession = live.getState().session;
  assert(homeB && originalSession && homeB !== idA, "other home selected");
  token("second-token");
  await ready(() => holdsToken(a, "second-token") && holdsToken(b, "second-token"));
  expect(live.getState().session === originalSession).toBe(true);
  expect(await app.phone.records.chosen()).toEqual({ ok: true, value: homeB });
  const beforeRefusal = app.attempts.get(a.lanPort) ?? 0;
  await a.stop();
  token("third-token");
  await ready(
    () => fake.keys.get(idA)?.pending?.body.token === "third-token" && holdsToken(b, "third-token"),
  );
  await ready(() => (app.attempts.get(a.lanPort) ?? 0) > beforeRefusal);
  expect(holdsToken(a, "second-token")).toBe(true);
  expect(live.getState().session === originalSession).toBe(true);
  app.stop();
  await a.start();
  app = boot();
  await ready(() => holdsToken(a, "third-token") && fake.keys.get(idA)?.pending === null);
  expect(app.attempts.get(a.lanPort)).toBeGreaterThan(0);
  expect(await app.phone.records.chosen()).toEqual({ ok: true, value: homeB });
  app.stop();
}, 60000);

test("notification Disarm returns false when the real hub refuses its sequence", async () => {
  const hub = await startRealHub();
  const deps: PhoneDeps = {
    items: memorySecureItems(),
    keys,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    finder: NO_FINDER,
    makeSocket: localSocket,
  };
  const phone = startPhoneClient(deps);
  phone.client.start();
  await phone.client.link(await invitation(hub), "qr", { name: "Phone", kind: "phone" });
  await ready(() => phone.client.live.getState().session !== null);
  const id = phone.client.live.getState().hub?.identity;
  assert(id, "linked home");
  const store = phone.records.hub(id);
  // Leave an unused sequence below a committed change, as after a stale phone record is restored.
  assert((await store.update((record) => ({ ...record, lastSeq: 100 }))).ok);
  assert((await phone.forward("push.unregister", {})).ok);
  assert((await store.update((record) => ({ ...record, lastSeq: 49 }))).ok);
  expect(await disarmFromNotification(id, Date.now() + 5000, phone.records, deps)).toBe(false);
  phone.client.stop();
}, 60000);

/** Creates a distinct authorized phone link to the scripted responder, without selecting its home. */
async function addScriptedLink(hub: HubEnd, records: PhoneRecords) {
  const pair = await keys.makeClientKey();
  assert(pair.ok, "phone key created");
  const client = hub.addClient(pair.value.publicKey, "phone", 1);
  const saved = await records.add(
    {
      key: pair.value,
      hub: {
        identity: hub.identity,
        staticKey: hub.staticKey.publicKey,
        client: client.id,
        person: client.person,
      },
      lastSeq: 0,
      reach: {
        addresses: ["127.0.0.1"],
        appsPort: 8444,
        lastAddress: "127.0.0.1",
        relayUrl: null,
        homeName: "",
      },
    },
    null,
  );
  assert(saved.ok, "stored link");
  return client;
}

/** Gives the phone a version-two responder and a clock controlled by the test. */
function scriptedPhone() {
  const hub = new HubEnd();
  hub.speaks = PHONE_PROTO;
  const timers = manualTimers();
  const deps: PhoneDeps = {
    items: memorySecureItems(),
    keys,
    timers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    finder: NO_FINDER,
    makeSocket: phoneSockets(new Map([["127.0.0.1", hub]])).make,
  };
  return { hub, deps, timers };
}

test.each([
  { name: "rejects an invalid Disarm reply body", body: { disarmed: [] }, accepted: false },
  {
    name: "waits for id 1 after the companion pong reply",
    body: { disarmed: [], heldBack: [], alarmEnded: false },
    accepted: true,
  },
])("notification Disarm $name", async ({ body, accepted }) => {
  const { hub, deps, timers } = scriptedPhone();
  const { records } = startPhoneClient(deps);
  await addScriptedLink(hub, records);
  hub.handle("pong", () => {
    // Its real encrypted pong reply is queued first, then the scripted first-request reply.
    setTimeout(() => {
      hub.emitFrame({ t: "res", id: 1, ok: true, body });
    }, 0);
    return { ok: true, body: {} };
  });
  const answer = await disarmFromNotification(hub.identity, timers.now() + 5000, records, deps);
  expect(hub.seen.map(({ id, op }) => [id, op])).toEqual([[2, "pong"]]);
  expect(answer).toBe(accepted);
});

test("a connection opened after the deadline is closed without sending a message", async () => {
  const { hub, deps, timers } = scriptedPhone();
  const { records } = startPhoneClient(deps);
  await addScriptedLink(hub, records);
  const opening = Promise.withResolvers<undefined>();
  let sent = 0,
    closed = 0;
  const socket: SocketLike = {
    binaryType: "arraybuffer",
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => {
      sent++;
      socket.onclose?.({ code: 1000 });
    },
    close: () => {
      closed++;
      socket.onclose?.({ code: 1000 });
    },
  };
  const answer = phoneFirst(
    hub.identity,
    timers.now() + 5,
    records,
    {
      ...deps,
      makeSocket: () => {
        opening.resolve(undefined);
        return socket;
      },
    },
    { op: "disarm", body: { target: "mine" } },
  );
  await opening.promise;
  timers.advance(6);
  socket.onopen?.({});
  expect(await answer).toEqual({ ok: false, fault: "unreachable" });
  expect({ sent, closed }).toEqual({ sent: 0, closed: 1 });
});

test("a queued token sweep cannot register a replacement link", async () => {
  const { hub, deps, timers } = scriptedPhone();
  const fake = fakePush();
  fake.token({ platform: "fcm", environment: "production", token: "local" });
  const push = pushLifecycle(fake.storage, fake.tokens, timers);
  const listed = Promise.withResolvers<undefined>(),
    resume = Promise.withResolvers<undefined>(),
    swept = Promise.withResolvers<undefined>();
  const phone = startPhoneClient({
    ...deps,
    push: {
      ...push,
      start: async (list) => {
        await push.start(async () => {
          const homes = await list();
          listed.resolve(undefined);
          await resume.promise;
          return homes;
        });
        swept.resolve(undefined);
      },
    },
  });
  const old = await addScriptedLink(hub, phone.records);
  phone.client.start();
  await listed.promise;
  assert((await phone.records.remove(hub.identity)).ok);
  hub.remove(old.id);
  const replacement = await addScriptedLink(hub, phone.records);
  expect(replacement.id).not.toBe(old.id);
  hub.handle("pong", () => {
    hub.emitFrame({ t: "res", id: 1, ok: true, body: { registered: true } });
    return { ok: true, body: {} };
  });
  resume.resolve(undefined);
  await swept.promise;
  const saved = await phone.records.hub(hub.identity).read();
  assert(saved.ok && saved.value);
  expect(saved.value.lastSeq).toBe(0);
  expect(hub.connections).toBe(0);
  expect(fake.keys.get(hub.identity)?.active ?? null).toBeNull();
  phone.client.stop();
  push.stop();
});

test("a sweep excludes the chosen home before its first snapshot", async () => {
  const { hub, deps, timers } = scriptedPhone();
  const fake = fakePush(),
    push = pushLifecycle(fake.storage, fake.tokens, timers);
  const enumerated = Promise.withResolvers<string[]>();
  const phone = startPhoneClient({
    ...deps,
    push: {
      ...push,
      start: async (list) => {
        enumerated.resolve((await list()).map((home) => home.hub));
      },
    },
  });
  await addScriptedLink(hub, phone.records);
  assert((await phone.records.choose(hub.identity)).ok);
  phone.client.start();
  expect(await enumerated.promise).toEqual([]);
  phone.client.stop();
  push.stop();
});

test("reserving a sequence reads no other home record, while a rename refreshes names", async () => {
  const { hub, deps, timers } = scriptedPhone();
  const other = new HubEnd(crypto.getRandomValues(new Uint8Array(32)));
  const fake = fakePush(),
    push = pushLifecycle(fake.storage, fake.tokens, timers);
  const reads: string[] = [];
  const items = {
    ...deps.items,
    get: (name: string) => {
      reads.push(name);
      return deps.items.get(name);
    },
  };
  const { records } = startPhoneClient({ ...deps, items, push });
  await addScriptedLink(hub, records);
  await addScriptedLink(other, records);
  const names = itemsOf(other.identity);
  assert(names);
  const store = records.hub(hub.identity);
  reads.length = 0;
  expect(await reserveSeq(store)).toBe(1);
  expect(reads).not.toContain(names.record);
  expect(reads).not.toContain(names.key);
  const changed = await store.update((record) => {
    assert(record.reach);
    return { ...record, reach: { ...record.reach, homeName: "Cottage" } };
  });
  expect(changed.ok).toBe(true);
  expect(reads).toContain(names.record);
  expect(fake.names()[hub.identity]).toBe("Cottage");
  push.stop();
});
