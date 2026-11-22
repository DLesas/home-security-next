/** A real hub's v2 snapshot proves what the linked phone registered and subsequently removed. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { parseConsoleFragment, snapshotObjectV2 } from "@hsn/protocol/app";
import { createHubClient } from "../src/hub/client";
import { NO_FINDER, readCode, type SocketLike } from "../src/hub/finder";
import { disarmFromNotification, type PhoneDeps, startPhoneClient } from "../src/hub/phone-client";
import { pushLifecycle } from "../src/hub/push";
import { PHONE_PROTO } from "../src/hub/restore";
import { realTimers } from "../src/hub/wire";
import { memoryRecordStore } from "../src/platform/client-key";
import * as keys from "../src/platform/keys.native";
import { S1, siteSnapshot } from "../../hub/test/unit/firmware/support";
import { seedPairingSite } from "./support/pairing-site";
import { hasStoredTarget } from "../src/platform/push-types";
import { fakePush } from "../src/platform/push-device.fake";
import { memorySecureItems } from "../src/platform/vault";
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
  const removeKey = fake.storage.remove;
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
