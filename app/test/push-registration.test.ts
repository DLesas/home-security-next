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
  expect((await registration.reconcile(session, null)).isOk()).toBe(true);
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
  expect((await registration.reconcile(session, valid)).isOk()).toBe(false);
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
  expect((await source.read())._unsafeUnwrapErr()).toBe("notAvailable");
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
