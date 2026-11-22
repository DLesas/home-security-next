/** A real hub's v2 snapshot proves what the linked phone registered and subsequently removed. */
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

afterAll(stopAllHubs);

/** Waits only for a linked client's first authenticated snapshot. */
async function ready(read: () => boolean) {
  const end = Date.now() + 15000;
  while (!read() && Date.now() < end) await Bun.sleep(50);
  assert(read(), "session ready");
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
  const code = readCode(invite.body.qr);
  assert(code.ok && code.value.kind === "link", "phone invitation");
  const fake = fakePush();

  const push = pushLifecycle(fake.storage, fake.tokens, realTimers);
  const deps: PhoneDeps = {
    items: memorySecureItems(),
    push,
    keys,
    timers: realTimers,
    app: "0.1.0",
    proto: PHONE_PROTO,
    finder: NO_FINDER,
    makeSocket: (address, origin) =>
      new WebSocket(address, {
        headers: { Origin: origin },
        tls: { rejectUnauthorized: false },
      } as unknown as string[]) as unknown as SocketLike,
  };
  const phone = startPhoneClient(deps);
  phone.client.start();
  await phone.client.link(code.value.secret, "qr", { name: "Phone", kind: "phone" });
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
  expect((await homes.remove(id)).ok).toBe(true);
  expect(unregistered).toBe(1);
  expect(fake.keys.has(id)).toBe(false);
  expect(fake.armed.has(id)).toBe(false);
  push.stop();
  phone.client.stop();
  owner.stop();
}, 60000);
