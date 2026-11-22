import assert from "node:assert/strict";
import publicVectors from "../../packages/protocol/vectors/relay-push.json";
import { pushOpener, parsePushKey, formatPushKeyId } from "@hsn/protocol/relay";
import { manualTimers, settle } from "./support/timers";
import { expect, test } from "bun:test";
import { pushRegisterBody } from "@hsn/protocol/app";
import {
  KEY_LIFETIME_MS,
  pushLifecycle,
  pushRegistration,
  type PushSession,
} from "../src/hub/push";
import { androidTokenSource, hasStoredTarget } from "../src/platform/push-types";
import { fakePush } from "../src/platform/push-device.fake";

const fcm = { platform: "fcm", environment: "production", token: "local-one" } as const;
const valid = { registered: true, valid: true };

/** Counts transmissions without recording a key or including one in an assertion. */
function setup() {
  const fake = fakePush();
  const clock = { ms: 500 };
  const registration = pushRegistration(fake.storage, fake.tokens, () => clock.ms);
  const sent = { count: 0, ok: true };
  const session: PushSession = {
    hub: "home",
    client: 2,
    register: (body) => {
      sent.count++;
      expect(pushRegisterBody.safeParse(body).success).toBe(true);
      expect(fake.keys.get("home")?.pending?.body.key === body.key).toBe(true);
      return Promise.resolve({ ok: sent.ok });
    },
  };
  return { fake, clock, registration, session, sent };
}

test("unavailable token makes no request and stores no key", async () => {
  const { registration, session, sent, fake } = setup();
  expect((await registration.reconcile(session, null)).ok).toBe(true);
  expect(sent.count).toBe(0);
  expect(fake.keys.size).toBe(0);
});

test("a new link creates its own key and id even when the snapshot reports a valid target", async () => {
  const { registration, session, sent, fake } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  const first = fake.keys.get("home")?.active;
  expect(first?.body.platform).toBe("fcm");
  expect(first?.body.environment).toBe("production");
  expect(first?.body.token).toBe(fcm.token);
  await registration.reconcile(session, valid);
  expect(sent.count).toBe(1);
  await registration.reconcile({ ...session, client: 3 }, valid);
  const next = fake.keys.get("home")?.active;
  expect(next?.client).toBe(3);
  expect(first?.body.key !== next?.body.key).toBe(true);
  expect(first?.body.keyId !== next?.body.keyId).toBe(true);
  expect(sent.count).toBe(2);
});

test("a changed token registers once, preserving the age and key", async () => {
  const { registration, session, sent, fake, clock } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  const first = fake.keys.get("home")?.active;
  fake.token({ ...fcm, token: "local-two" });
  clock.ms++;
  await registration.reconcile(session, valid);
  await registration.reconcile(session, valid);
  const second = fake.keys.get("home")?.active;
  expect(second?.body.token).toBe("local-two");
  expect(second?.body.key === first?.body.key).toBe(true);
  expect(second?.madeMs).toBe(first?.madeMs);
  expect(sent.count).toBe(2);
});

test("a missing, unregistered, or invalid snapshot target registers again", async () => {
  const { registration, session, sent, fake } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  for (const target of [
    null,
    { registered: false, valid: true },
    { registered: true, valid: false },
  ]) {
    const before = sent.count;
    await registration.reconcile(session, target);
    expect(sent.count).toBe(before + 1);
  }
});

test("key and id rotate exactly at 30 days and token refresh does not defer rotation", async () => {
  const { registration, session, sent, fake, clock } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  const first = fake.keys.get("home")?.active;
  clock.ms += 30 * 86400000 - 1;
  await registration.reconcile(session, valid);
  expect(sent.count).toBe(1);
  fake.token({ ...fcm, token: "refresh" });
  await registration.reconcile(session, valid);
  clock.ms++;
  await registration.reconcile(session, valid);
  const next = fake.keys.get("home")?.active;
  expect(sent.count).toBe(3);
  expect(next?.body.key !== first?.body.key).toBe(true);
  expect(next?.body.keyId !== first?.body.keyId).toBe(true);
  expect(next?.madeMs).toBe(clock.ms);
  expect(KEY_LIFETIME_MS).toBe(30 * 86400000);
});

test("a lost reply retains both generations and retries the staged key", async () => {
  const { registration, session, fake, sent, clock } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  const first = fake.keys.get("home")?.active;
  clock.ms += KEY_LIFETIME_MS;
  sent.ok = false;
  expect((await registration.reconcile(session, valid)).ok).toBe(false);
  const staged = fake.keys.get("home");
  expect(staged?.active?.body.key === first?.body.key).toBe(true);
  sent.ok = true;
  await registration.reconcile(session, valid);
  expect(fake.keys.get("home")?.active?.body.key === staged?.pending?.body.key).toBe(true);
  expect(fake.keys.get("home")?.pending).toBeNull();
});

test("armed state follows all sensors including a door waiting to close, independently per hub", async () => {
  const { registration, fake } = setup();
  await registration.armed("other", [{ arm: "armed" }]);
  for (const arm of ["armed", "waitsForDoorToClose", "disarmed"] as const) {
    await registration.armed("home", [{ arm: "disarmed" }, { arm }]);
    expect(fake.armed.get("home")).toBe(arm !== "disarmed");
    expect(fake.armed.get("other")).toBe(true);
  }
});

test("two homes on one phone have independent key ids and independent key material", async () => {
  const { registration, session, fake } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  await registration.reconcile(
    { ...session, hub: "other", register: () => Promise.resolve({ ok: true }) },
    valid,
  );
  const first = fake.keys.get("home")?.active;
  const second = fake.keys.get("other")?.active;
  expect(first != null && second != null).toBe(true);
  expect(first?.body.key !== second?.body.key).toBe(true);
  expect(first?.body.keyId !== second?.body.keyId).toBe(true);
  await registration.remove("home");
  expect(fake.keys.has("other")).toBe(true);
});

test("an open session handles OS refresh, snapshot and arming writes, and its own rotation timer", async () => {
  const { session, fake, sent } = setup();
  const timers = manualTimers();
  const lifecycle = pushLifecycle(fake.storage, fake.tokens, timers);
  fake.token(fcm);
  await lifecycle.snapshot(session, null, [
    { id: 1, arm: "armed", door: "closed", countdownSecondsLeft: null },
  ]);
  expect(fake.armed.get("home")).toBe(true);
  await lifecycle.arming([{ arm: "disarmed" }]);
  expect(fake.armed.get("home")).toBe(false);
  const first = fake.keys.get("home")?.active;
  fake.token({ ...fcm, token: "replacement" });
  await settle(1);
  expect(fake.keys.get("home")?.active?.body.token).toBe("replacement");
  timers.advance(0x7fffffff);
  await settle(1);
  timers.advance(30 * 86400000 - 0x7fffffff - 1);
  expect(sent.count).toBe(2);
  timers.advance(1);
  await settle(1);
  expect(sent.count).toBe(3);
  expect(fake.keys.get("home")?.active?.body.key !== first?.body.key).toBe(true);
  lifecycle.stop();
  fake.token({ ...fcm, token: "after-stop" });
  timers.advance(KEY_LIFETIME_MS);
  await settle(1);
  expect(sent.count).toBe(3);
});

test("unconfigured Android neither queries the OS nor subscribes to token changes", async () => {
  let reads = 0,
    subscriptions = 0;
  const source = androidTokenSource(
    false,
    () => {
      reads++;
      return Promise.resolve({ type: "android", data: "token" });
    },
    () => {
      subscriptions++;
      return { remove: () => undefined };
    },
  );
  expect(await source.read()).toEqual({ ok: false, fault: "notAvailable" });
  source.listen(() => undefined)();
  expect([reads, subscriptions]).toEqual([0, 0]);
});

test("a staged registration counts for removal even if the hub reply was lost", async () => {
  const { registration, session, fake, sent } = setup();
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  fake.token(fcm);
  sent.ok = false;
  await registration.reconcile(session, null);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(true);
});

test("a transient registration failure retries the staged key on the same open session", async () => {
  const { session, fake, sent } = setup();
  fake.token(fcm);
  sent.ok = false;
  const timers = manualTimers();
  const lifecycle = pushLifecycle(fake.storage, fake.tokens, timers);
  await lifecycle.snapshot(session, null, []);
  const staged = fake.keys.get(session.hub)?.pending;
  expect(staged != null).toBe(true);
  sent.ok = true;
  timers.advance(60_000);
  await settle(1);
  expect(sent.count).toBe(2);
  expect(fake.keys.get(session.hub)?.active?.body.key === staged?.body.key).toBe(true);
  lifecycle.stop();
});

test("an old published alert opens throughout rotation until the new registration is accepted", async () => {
  const vector = publicVectors.seal[0];
  assert(vector, "published countdown");
  const h = vector.h;
  const fake = fakePush();
  fake.token(fcm);
  const hub = vector.content.hub;
  const body = {
    ...fcm,
    keyId: vector.keyId,
    key: Buffer.from(vector.key, "hex").toString("base64url"),
  };
  fake.keys.set(hub, { active: { client: 2, madeMs: 0, body }, pending: null });
  const reg = pushRegistration(fake.storage, fake.tokens, () => KEY_LIFETIME_MS);
  /** Reads both generations as the service does, then authenticates the published envelope. */
  function opensOldAlert() {
    const saved = fake.keys.get(hub);
    return pushOpener.open(h, (id) => {
      const match = [saved?.active, saved?.pending].find(
        (r) => r?.body.keyId === formatPushKeyId(id),
      );
      return match ? parsePushKey(match.body.key) : undefined;
    }).ok;
  }
  const ack = Promise.withResolvers<{ ok: boolean }>();
  const sent = Promise.withResolvers<undefined>();
  const pending = reg.reconcile(
    {
      hub,
      client: 2,
      register: () => {
        sent.resolve(undefined);
        return ack.promise;
      },
    },
    valid,
  );
  await sent.promise;
  expect(opensOldAlert()).toBe(true);
  ack.resolve({ ok: true });
  expect((await pending).ok).toBe(true);
  expect(opensOldAlert()).toBe(false);
});

test("an unselected home keeps its overdue key on a token change and rotates only on its own session", async () => {
  const { registration, session, fake, clock, sent } = setup();
  fake.token(fcm);
  await registration.reconcile(session, valid);
  const original = fake.keys.get(session.hub)?.active;
  clock.ms += KEY_LIFETIME_MS + 1;
  await registration.reconcile(session, undefined, fcm, false);
  expect(sent.count).toBe(1);
  const changed = { ...fcm, token: "replaced" };
  await registration.reconcile(session, undefined, changed, false);
  expect(sent.count).toBe(2);
  expect(fake.keys.get(session.hub)?.active?.body.key === original?.body.key).toBe(true);
  await registration.reconcile(session, valid, changed);
  expect(sent.count).toBe(3);
  expect(fake.keys.get(session.hub)?.active?.body.key !== original?.body.key).toBe(true);
});

test("removing a home while its hub reply is outstanding erases the key and a late reply cannot restore it", async () => {
  const { registration, session, fake } = setup();
  fake.token(fcm);
  const ack = Promise.withResolvers<{ ok: boolean }>();
  const sent = Promise.withResolvers<undefined>();
  const pending = registration.reconcile(
    {
      ...session,
      register: () => {
        sent.resolve(undefined);
        return ack.promise;
      },
    },
    null,
  );
  await sent.promise;
  await registration.remove(session.hub);
  expect(fake.keys.has(session.hub)).toBe(false);
  ack.resolve({ ok: true });
  await pending;
  expect(fake.keys.has(session.hub)).toBe(false);
});

test("token refresh visits unselected homes one at a time while the selected home registers", async () => {
  const fake = fakePush();
  const lifecycle = pushLifecycle(fake.storage, fake.tokens, manualTimers());
  const gate = Promise.withResolvers<{ ok: boolean }>();
  const calls: string[] = [];
  const home = (hub: string): PushSession => ({
    hub,
    client: 1,
    register: () => {
      calls.push(hub);
      return hub === "second" ? gate.promise : Promise.resolve({ ok: true });
    },
  });
  await lifecycle.start(() => Promise.resolve([home("second"), home("third")]));
  await lifecycle.snapshot(home("selected"), null, []);
  fake.token(fcm);
  await settle(1);
  expect(calls.toSorted()).toEqual(["second", "selected"]);
  gate.resolve({ ok: true });
  await settle(1);
  expect(calls.at(-1)).toBe("third");
  lifecycle.stop();
});
