/** Opt-out follows each route that could otherwise write a target. */
import { expect, test } from "bun:test";
import { KEY_LIFETIME_MS, type PushSession, pushLifecycle } from "../src/hub/push";
import { fakeAlertPermission } from "../src/platform/alert-permission.fake";
import { fakePush } from "../src/platform/push-device.fake";
import { hasStoredTarget } from "../src/platform/push-types";
import { manualTimers, settle } from "./support/timers";

const token = { platform: "fcm", environment: "production", token: "switch-fixture" } as const;

/** Keeps a per-home choice and counts hub requests without retaining their bodies. */
function home(hub: string) {
  const state = { enabled: true, registered: false, requests: [] as string[] };
  const session: PushSession = {
    hub,
    client: 1,
    /** Reads or saves the per-home choice. */
    alertChoice: (enabled) => {
      state.enabled = enabled ?? state.enabled;
      return Promise.resolve({ ok: true, value: state.enabled });
    },
    /** Marks the fake hub's current target. */
    register: () => {
      state.requests.push("register");
      state.registered = true;
      return Promise.resolve({ ok: true });
    },
    /** Removes the fake hub's target. */
    unregister: () => {
      state.requests.push("unregister");
      state.registered = false;
      return Promise.resolve({ ok: true });
    },
  };
  return { session, state };
}

/** Runs the phone lifecycle against two addressable homes and a manually advanced timer. */
function started() {
  const fake = fakePush();
  fake.token(token);
  const timers = manualTimers();
  const os = fakeAlertPermission("granted");
  const push = pushLifecycle(fake.storage, fake.tokens, timers, os.permission);
  return { fake, timers, push, os, selected: home("selected"), other: home("other") };
}

test("opt-out unregisters before erasing active and pending keys", async () => {
  const {
    fake,
    push,
    selected: { session, state },
  } = started();
  const withKeyCheck = {
    ...session,
    /** Proves both local generations remain until the hub confirms removal. */
    unregister: async () => {
      expect(fake.keys.get(session.hub)?.active != null).toBe(true);
      expect(fake.keys.get(session.hub)?.pending != null).toBe(true);
      return (await session.unregister?.()) ?? { ok: false };
    },
  };
  await push.snapshot(withKeyCheck, null, []);
  const active = fake.keys.get(session.hub)?.active;
  expect(active != null).toBe(true);
  if (active) await fake.storage.writeKeys(session.hub, { active, pending: active });
  expect((await push.alerts.setEnabled(session.hub, session.client, false)).ok).toBe(true);
  expect(state.requests).toEqual(["register", "unregister"]);
  expect(state.registered).toBe(false);
  expect(state.enabled).toBe(false);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  push.stop();
});

test("an opted-out home does not register from a missing-target snapshot", async () => {
  const {
    fake,
    push,
    selected: { session, state },
  } = started();
  await push.snapshot(session, null, []);
  expect((await push.alerts.setEnabled(session.hub, session.client, false)).ok).toBe(true);
  await push.snapshot(session, null, []);
  expect(state.requests).toEqual(["register", "unregister"]);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  push.stop();
});

test("a token change leaves the selected opted-out home off", async () => {
  const {
    fake,
    push,
    selected: { session, state },
  } = started();
  await push.snapshot(session, null, []);
  expect((await push.alerts.setEnabled(session.hub, session.client, false)).ok).toBe(true);
  fake.token({ ...token, token: "replacement-fixture" });
  await settle(2);
  expect(state.requests).toEqual(["register", "unregister"]);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  push.stop();
});

test("startup and token sweeps skip an opted-out unselected home and still register another home", async () => {
  const { fake, push, selected, other } = started();
  await push.snapshot(selected.session, null, []);
  expect((await push.alerts.setEnabled(selected.session.hub, 1, false)).ok).toBe(true);
  push.closed();
  await push.start(() => Promise.resolve([selected.session, other.session]));
  expect(selected.state.requests).toEqual(["register", "unregister"]);
  expect(other.state.requests).toEqual(["register"]);
  fake.token({ ...token, token: "replacement-fixture" });
  await settle(2);
  expect(selected.state.requests).toEqual(["register", "unregister"]);
  expect(other.state.requests).toEqual(["register", "register"]);
  expect(await hasStoredTarget(fake.storage, selected.session.hub)).toBe(false);
  push.stop();
});

test("opt-out cancels the existing renewal and prevents a later registration at 30 days", async () => {
  const {
    fake,
    timers,
    push,
    selected: { session, state },
  } = started();
  await push.snapshot(session, null, []);
  expect(timers.asked).toEqual([0x7fffffff]);
  expect((await push.alerts.setEnabled(session.hub, session.client, false)).ok).toBe(true);
  await settle(2);
  timers.advance(KEY_LIFETIME_MS);
  await settle(2);
  expect(state.requests).toEqual(["register", "unregister"]);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  expect(timers.asked).toEqual([0x7fffffff]);
  push.stop();
});

test("an in-flight registration settles before opt-out removes its target and key", async () => {
  const {
    fake,
    push,
    selected: { session, state },
  } = started();
  const release = Promise.withResolvers<{ ok: boolean }>();
  const registering = push.snapshot(
    {
      ...session,
      /** Simulates a hub that commits a target before the phone receives its reply. */
      register: () => {
        state.requests.push("register");
        state.registered = true;
        return release.promise;
      },
    },
    null,
    [],
  );
  await settle(2);
  expect(state.requests).toEqual(["register"]);
  expect(fake.keys.get(session.hub)?.pending != null).toBe(true);
  const switching = push.alerts.setEnabled(session.hub, session.client, false);
  fake.token({ ...token, token: "queued-fixture" });
  await settle(2);
  const beforeReply = state.requests.slice();
  release.resolve({ ok: true });
  await registering;
  expect((await switching).ok).toBe(true);
  await settle(2);
  expect(beforeReply).toEqual(["register"]);
  expect(state.requests).toEqual(["register", "unregister"]);
  expect(state.registered).toBe(false);
  expect(await hasStoredTarget(fake.storage, session.hub)).toBe(false);
  push.stop();
});

test("permission gates startup sweeps and token changes, with no prompt", async () => {
  const { fake, push, os, selected, other } = started();
  os.state.answer = "denied";
  await push.start(() => Promise.resolve([other.session]));
  await push.snapshot(selected.session, null, []);
  fake.token({ ...token, token: "queued-fixture" });
  await settle(2);
  expect(os.state.asked).toBe(0);
  expect(selected.state.requests).toEqual([]);
  expect(other.state.requests).toEqual([]);
  os.returnFromSettings("granted");
  await settle(2);
  expect(selected.state.requests).toEqual(["register"]);
  expect(other.state.requests).toEqual(["register"]);
  push.stop();
});

test("a replaced device address counts as ready only after the hub accepts it", async () => {
  const {
    fake,
    push,
    timers,
    selected: { session, state },
  } = started();
  let reachable = true;
  await push.snapshot(
    {
      ...session,
      /** Allows the current target to be confirmed and the replacement to fail once. */
      register: async (body) => (reachable ? session.register(body) : { ok: false }),
    },
    null,
    [],
  );
  expect(push.alerts.status.getState()?.stored).toBe(true);
  reachable = false;
  fake.token({ ...token, token: "replacement-fixture" });
  await settle(2);
  expect(push.alerts.status.getState()?.stored).toBe(false);
  expect(state.requests).toEqual(["register"]);
  reachable = true;
  timers.advance(60_000);
  await settle(2);
  expect(push.alerts.status.getState()?.stored).toBe(true);
  expect(state.requests).toEqual(["register", "register"]);
  push.stop();
});
