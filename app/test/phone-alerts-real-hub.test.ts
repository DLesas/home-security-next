/** A real hub and phone client prove the persisted choice and the target visible in snapshots. */
import { afterAll, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { snapshotObjectV2 } from "@hsn/protocol/app";
import { NO_FINDER, readCode, type SocketLike } from "../src/hub/finder";
import { type PhoneClient, type PhoneDeps, startPhoneClient } from "../src/hub/phone-client";
import { pushLifecycle } from "../src/hub/push";
import { PHONE_PROTO } from "../src/hub/restore";
import { realTimers } from "../src/hub/wire";
import { fakeAlertPermission } from "../src/platform/alert-permission.fake";
import * as keys from "../src/platform/keys.native";
import { fakePush } from "../src/platform/push-device.fake";
import { hasStoredTarget } from "../src/platform/push-types";
import { memorySecureItems } from "../src/platform/vault";
import { startRealHub, stopAllHubs } from "./support/real-hub";

declare const WebSocket: new (
  address: string,
  options: { headers: { Origin: string }; tls: { rejectUnauthorized: boolean } },
) => SocketLike;

afterAll(stopAllHubs);

/** Takes a fresh authenticated snapshot and returns only the real hub's push flags. */
async function target(phone: PhoneClient) {
  const reply = await phone.forward("snapshot", {});
  assert(reply.ok, "phone snapshot reply");
  const parsed = snapshotObjectV2.safeParse(reply.body);
  assert(parsed.success, "version 2 snapshot");
  return parsed.data.push;
}

/** Waits for a bounded condition and reports the condition without any registration fields. */
async function ready(check: () => boolean) {
  const end = Date.now() + 8_000;
  while (!check() && Date.now() < end) await Bun.sleep(25);
  assert(check(), "phone alert status observed");
}

test("a real hub shows no target after off, keeps it off across restart, and shows a valid target after on", async () => {
  const hub = await startRealHub();
  const invite = (await hub.control({
    kind: "op",
    op: "link.create",
    body: { kind: { newPerson: { name: "Resident" } }, form: "qr" },
  })) as { reply?: { result?: { body?: { qr?: unknown } } } };
  const qr = invite.reply?.result?.body?.qr;
  assert(typeof qr === "string", "phone invitation");
  const code = readCode(qr);
  assert(code.ok && code.value.kind === "link", "readable phone invitation");
  const secret = code.value.secret;

  const items = memorySecureItems();
  const fake = fakePush();
  fake.token({ platform: "fcm", environment: "production", token: "real-local-fixture" });
  const os = fakeAlertPermission("granted");

  /** Opens a new client and lifecycle on the same phone storage. */
  function start() {
    const push = pushLifecycle(fake.storage, fake.tokens, realTimers, os.permission);
    const deps: PhoneDeps = {
      push,
      items: memorySecureItems(items.disk),
      keys,
      timers: realTimers,
      app: "0.1.0",
      proto: PHONE_PROTO,
      finder: NO_FINDER,
      /** Accepts the local test hub's self-signed TLS certificate. */
      makeSocket: (address, origin) =>
        new WebSocket(address, { headers: { Origin: origin }, tls: { rejectUnauthorized: false } }),
    };
    const phone = startPhoneClient(deps);
    phone.client.start();
    return {
      phone,
      /** Stops this phone without deleting its records. */
      stop: () => {
        phone.client.stop();
        push.stop();
      },
    };
  }

  const first = start();
  const restarted = (async () => {
    const { phone } = first;
    await phone.client.link(secret, "qr", { name: "Phone", kind: "phone" });
    const alerts = phone.client.phoneAlerts;
    assert(alerts, "phone alert controls");
    await ready(() => alerts.status.getState()?.stored === true);
    const live = phone.client.live.getState();
    assert(live.session && live.hub, "chosen phone session");
    const { identity } = live.hub;
    const { client } = live.session;
    expect(await target(phone)).toEqual({ registered: true, valid: true });
    expect((await alerts.setEnabled(identity, client, false)).ok).toBe(true);
    expect(await target(phone)).toEqual({ registered: false, valid: false });
    expect(await hasStoredTarget(fake.storage, identity)).toBe(false);
    return { identity, client };
  })().finally(first.stop);
  const { identity, client } = await restarted;

  const second = start();
  await (async () => {
    const { phone } = second;
    const alerts = phone.client.phoneAlerts;
    assert(alerts, "restored phone alert controls");
    await ready(() => alerts.status.getState()?.enabled === false);
    expect(await target(phone)).toEqual({ registered: false, valid: false });
    expect(await phone.records.alertChoice(identity)).toEqual({ ok: true, value: false });
    expect((await alerts.setEnabled(identity, client, true)).ok).toBe(true);
    await ready(() => alerts.status.getState()?.stored === true);
    expect(await target(phone)).toEqual({ registered: true, valid: true });
    expect(await phone.records.alertChoice(identity)).toEqual({ ok: true, value: true });

    // Remove with an actual persisted opt-out so an orphaned preference would fail the test.
    expect((await alerts.setEnabled(identity, client, false)).ok).toBe(true);
    const choiceItem = `hub.${identity}.alerts-off`;
    expect(items.disk.has(choiceItem)).toBe(true);
    expect((await phone.records.remove(identity)).ok).toBe(true);
    expect(items.disk.has(choiceItem)).toBe(false);
    expect(await phone.records.alertChoice(identity)).toEqual({ ok: true, value: undefined });
  })().finally(second.stop);
}, 30_000);
