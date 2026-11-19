/**
 * Sealing pushes and sending the roster (docs/m4-design.md sections 4 and 5; D126, D127), through
 * B2's real relay to B3's real push service, its stand-ins for Apple and Google on loopback: a push
 * sealed with the phone's key and a fresh nonce, sent in the turn's frame, delivered and answered
 * `accepted`; one to a token the stand-in has unregistered answered `badToken`; the roster's two
 * alerts sealed for each target, the roster sent again until the relay stores it; and what the
 * sealer refuses recorded as the core's fault, never sent. Nothing a test sealed with is found in
 * any log line, event or report.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { type PushContent, relayAlertContent } from "@hsn/protocol/app";
import { pushOpener, RELAY_LIMITS } from "@hsn/protocol/relay";
import { err } from "neverthrow";
import type { RosterEntry } from "../../../src/core/model/effects.ts";
import { clientId, outboxId } from "../../../src/core/model/ids.ts";
import { MemoryPushKeys } from "../../../src/shell/relay/push-keys.ts";
import { ROSTER_RESEND_MS } from "../../../src/shell/relay/push.ts";
import { SYSTEM_CLOCK } from "../../../../relay/src/push/clock.ts";
import { readConfig } from "../../../../relay/src/push/config.ts";
import { PushLink } from "../../../../relay/src/push/push-link.ts";
import { startPushRole, type PushRole } from "../../../../relay/src/push/role.ts";
import {
  apnsToken,
  fcmToken,
  memoryLog as pushLog,
  REPO,
  relayKey,
  type StandIns,
  standIns,
  TOPIC,
} from "../../../../relay/test/push/helpers.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import {
  identityOf,
  makeClient,
  need,
  type RelayRun,
  ScriptedRelay,
  settle,
  startRelayRun,
  staticKeyOf,
  stopAll,
  testKey,
  until,
} from "./support.ts";

const hub = staticKeyOf(41);
const IDENTITY = identityOf(hub, sha256);
const PHONE = clientId(5);
const OTHER = clientId(6);
const KEY_ID = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
const OTHER_KEY_ID = Uint8Array.of(8, 7, 6, 5, 4, 3, 2, 1);
const KEY = testKey(sha256(Uint8Array.of(5, 5)));
const OTHER_KEY = testKey(sha256(Uint8Array.of(6, 6)));

/** A notification's push, as the core builds one. */
function content(seq: number, overrides: Partial<PushContent> = {}): PushContent {
  return {
    v: 1,
    hub: IDENTITY,
    n: {
      seq,
      atMs: Date.UTC(2026, 10, 18, 12),
      clockOk: true,
      kind: "countdown_started",
      category: "alarm",
      critical: true,
      device: 3,
      cause: null,
    },
    delayed: false,
    names: { device: "Front door" },
    actions: ["disarm"],
    armed: true,
    ...overrides,
  };
}

function entry(
  client: typeof PHONE,
  keyId: Uint8Array,
  platform: "apns" | "fcm",
  token: string,
  armed = true,
): RosterEntry {
  return {
    client,
    keyId,
    platform,
    environment: "production",
    token,
    unreachable: relayAlertContent("unreachable", IDENTITY, armed),
    back: relayAlertContent("back", IDENTITY, armed),
  };
}

/** The stand-ins, the push role in this process on a local socket, the relay's link to it. */
async function pushService(): Promise<{
  readonly s: StandIns;
  readonly role: PushRole;
  readonly link: PushLink;
  readonly log: ReturnType<typeof pushLog>;
  stop(): Promise<void>;
}> {
  const s = await standIns();
  const caPath = join(s.folder, "standin-ca.pem");
  writeFileSync(caPath, s.tls.cert);
  const socket = join(s.folder, "push.sock");
  const config = need(
    readConfig(
      [
        "--socket",
        socket,
        "--apns-key",
        s.apnsKeyPath,
        "--apns-key-id",
        s.apnsKey.keyId,
        "--apns-team",
        s.apnsKey.teamId,
        "--apns-topic",
        TOPIC,
        "--fcm-account",
        s.fcmAccountPath,
        "--apns-production",
        s.apns.origin,
        "--apns-development",
        s.apns.origin,
        "--fcm-origin",
        s.fcm.origin,
        "--test-ca",
        caPath,
      ],
      { programFolder: REPO, uid: process.getuid?.() },
    ),
  );
  const log = pushLog();
  const role = need(startPushRole(config, { log }));
  const link = new PushLink({
    url: `ws+unix://${socket}:/v1/relay`,
    staticKey: relayKey(),
    version: "0.1.0",
    clock: SYSTEM_CLOCK,
    log,
    random: () => 0.5,
  });
  link.start();
  await until(() => link.up, "the relay's link to the push service");
  return {
    s,
    role,
    link,
    log,
    async stop() {
      link.stop();
      await role.stop();
      await s.close();
    },
  };
}

let service: Awaited<ReturnType<typeof pushService>> | undefined;
let run: RelayRun;

beforeEach(async () => {
  service = await pushService();
  run = startRelayRun({ sender: service.link });
});

/** Every log line of every relay and push service the tests ran, for the last test's search. */
const logs: string[] = [];

afterEach(async () => {
  logs.push(...run.log.lines, ...(service?.log.lines ?? []));
  await stopAll();
  await service?.stop();
  service = undefined;
});

function client() {
  const pushKeys = new MemoryPushKeys();
  const side = makeClient({ key: hub, pushKeys });
  side.client.perform({ kind: "pushKey", client: PHONE, keyId: KEY_ID, key: KEY });
  side.client.perform({ kind: "pushKey", client: OTHER, keyId: OTHER_KEY_ID, key: OTHER_KEY });
  return side;
}

async function joined(side: ReturnType<typeof client>): Promise<void> {
  side.client.perform({ kind: "relayConnect", url: run.url });
  await until(() => side.client.state.kind === "up", "the link up");
}

describe("pushes", () => {
  test("a push sealed with the phone's key, sent, delivered by FCM and answered accepted", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(PHONE, KEY_ID, "fcm", fcmToken(1))],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    side.client.perform({ kind: "pushSend", id: outboxId(7), client: PHONE, content: content(9) });
    await until(() => side.of("pushResults").length === 1, "the result");
    expect(side.of("pushResults")[0]?.results).toEqual([{ id: outboxId(7), outcome: "accepted" }]);
    const received = service?.s.fcm.received ?? [];
    expect(received).toHaveLength(1);
    const h = (received[0]?.json as { message: { data: { h: string } } }).message.data.h;
    expect(h).toHaveLength(1763);
    const opened = pushOpener.open(h, (id) => (id.join() === KEY_ID.join() ? KEY : undefined));
    expect(opened).toEqual({ ok: true, value: content(9) });
    expect(service?.s.fcm.received[0]?.token).toBe(fcmToken(1));
  });

  test("an APNs target too, and two items of one turn in one push frame", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [
        entry(PHONE, KEY_ID, "apns", apnsToken(1)),
        entry(OTHER, OTHER_KEY_ID, "fcm", fcmToken(2)),
      ],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    side.client.perform({ kind: "pushSend", id: outboxId(1), client: PHONE, content: content(1) });
    side.client.perform({ kind: "pushSend", id: outboxId(2), client: OTHER, content: content(2) });
    // Sealed and held for the end of the turn: nothing in the relay's hands yet.
    expect(side.client.push.inHand).toBe(0);
    expect(side.client.push.waiting).toBe(2);
    // The turn is over (its microtasks run), and no answer can have come yet: one frame in hand.
    await Promise.resolve();
    expect(side.client.push.inHand).toBe(1);
    expect(side.client.push.waiting).toBe(0);
    await until(() => side.of("pushResults").length === 1, "one result for one frame");
    expect(side.of("pushResults")[0]?.results).toEqual([
      { id: outboxId(1), outcome: "accepted" },
      { id: outboxId(2), outcome: "accepted" },
    ]);
    const apns = service?.s.apns.received ?? [];
    expect(apns).toHaveLength(1);
    const h = (JSON.parse(apns[0]?.body ?? "{}") as { h: string }).h;
    expect(pushOpener.open(h, () => KEY)).toEqual({ ok: true, value: content(1) });
  });

  test("a token the service refuses is answered badToken", async () => {
    service?.s.fcm.unregister(fcmToken(2));
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(OTHER, OTHER_KEY_ID, "fcm", fcmToken(2))],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    side.client.perform({ kind: "pushSend", id: outboxId(3), client: OTHER, content: content(3) });
    await until(() => side.of("pushResults").length === 1, "the result");
    expect(side.of("pushResults")[0]?.results).toEqual([{ id: outboxId(3), outcome: "badToken" }]);
  });

  test("every seal its own nonce: the same content twice is two different envelopes", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(PHONE, KEY_ID, "fcm", fcmToken(1))],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    for (const id of [1, 2, 3])
      side.client.perform({
        kind: "pushSend",
        id: outboxId(id),
        client: PHONE,
        content: content(1),
      });
    await until(() => (service?.s.fcm.received.length ?? 0) === 3, "three deliveries");
    const hs = (service?.s.fcm.received ?? []).map(
      (r) => (r.json as { message: { data: { h: string } } }).message.data.h,
    );
    const nonces = hs.map((h) => h.split(".")[2]?.slice(0, 16));
    expect(new Set(hs).size).toBe(3);
    expect(new Set(nonces).size).toBe(3);
    for (const h of hs)
      expect(pushOpener.open(h, () => KEY)).toEqual({ ok: true, value: content(1) });
  });

  test("content the phone would drop is never sealed: recorded as the core's fault, no result", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "pushSend",
      id: outboxId(4),
      client: PHONE,
      content: content(4, { names: { device: "x".repeat(65) } }),
    });
    side.client.perform({
      kind: "pushSend",
      id: outboxId(5),
      client: clientId(99),
      content: content(5),
    });
    await settle(30);
    const faults: unknown[] = side.of("inputRejected").map((e) => e.rejection);
    expect(faults).toEqual([
      expect.objectContaining({
        source: "core",
        event: "pushResults",
        detail: { id: 4, error: "badContent" },
      }),
      expect.objectContaining({ source: "core", detail: { id: 5, error: "noKey" } }),
    ]);
    expect(side.client.push.inHand).toBe(0);
    expect(side.of("pushResults")).toEqual([]);
  });

  test("while the link is down a push is dropped: the core sends it again when it is back", () => {
    const side = client();
    side.client.perform({ kind: "pushSend", id: outboxId(6), client: PHONE, content: content(6) });
    expect(side.client.push.waiting).toBe(0);
    expect(side.of("inputRejected")).toEqual([]);
  });
});

describe("the roster", () => {
  test("each target's two alerts sealed afresh with its key, armed as the core built them", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [
        entry(PHONE, KEY_ID, "fcm", fcmToken(1), true),
        entry(OTHER, OTHER_KEY_ID, "apns", apnsToken(2), false),
      ],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    const stored = run.targets(IDENTITY);
    expect(stored.map((t) => [t.key, t.platform, t.token])).toEqual([
      ["0102030405060708", "fcm", fcmToken(1)],
      ["0807060504030201", "apns", apnsToken(2)],
    ]);
    const [phone, other] = stored;
    const keyFor = (k: Uint8Array) => (k.join() === KEY_ID.join() ? KEY : OTHER_KEY);
    expect(pushOpener.open(phone?.unreachable ?? "", keyFor)).toEqual({
      ok: true,
      value: relayAlertContent("unreachable", IDENTITY, true),
    });
    expect(pushOpener.open(phone?.back ?? "", keyFor)).toEqual({
      ok: true,
      value: relayAlertContent("back", IDENTITY, true),
    });
    expect(pushOpener.open(other?.unreachable ?? "", keyFor)).toEqual({
      ok: true,
      value: relayAlertContent("unreachable", IDENTITY, false),
    });
    // Two nonces, never the same.
    expect(phone?.unreachable.slice(19, 35)).not.toBe(phone?.back.slice(19, 35));
  });

  test("the relay's unreachable alert, when the hub goes quiet, is the one the hub sealed", async () => {
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(PHONE, KEY_ID, "fcm", fcmToken(1), true)],
    });
    await until(() => side.client.push.unackedRev === undefined, "the roster stored");
    side.client.stop();
    await until(() => run.joined === 0, "the link closed");
    run.clock.advance(180_000);
    await until(() => (service?.s.fcm.received.length ?? 0) === 1, "the alert");
    const h = (service?.s.fcm.received[0]?.json as { message: { data: { h: string } } }).message
      .data.h;
    expect(pushOpener.open(h, () => KEY)).toEqual({
      ok: true,
      value: relayAlertContent("unreachable", IDENTITY, true),
    });
  });

  test("a roster with no rosterAck is sent again every 15 s until one comes", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: hub, connect: relay.connect });
    side.client.perform({ kind: "pushKey", client: PHONE, keyId: KEY_ID, key: KEY });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    side.client.perform({
      kind: "relayRoster",
      rev: 4,
      targets: [entry(PHONE, KEY_ID, "fcm", "t")],
    });
    const link = relay.last;
    expect(link?.sent("roster").map((r) => r.rev)).toEqual([4]);
    side.timers.advance(ROSTER_RESEND_MS - 1);
    expect(link?.sent("roster")).toHaveLength(1);
    side.timers.advance(1);
    expect(link?.sent("roster")).toHaveLength(2);
    // The same roster, byte for byte: nothing sealed again.
    expect(link?.sent("roster")[1]).toEqual(link?.sent("roster")[0]);
    link?.send({ t: "rosterAck", rev: 3 });
    side.timers.advance(ROSTER_RESEND_MS);
    expect(link?.sent("roster")).toHaveLength(3);
    link?.send({ t: "rosterAck", rev: 4 });
    expect(side.client.push.unackedRev).toBeUndefined();
    side.timers.advance(10 * ROSTER_RESEND_MS);
    expect(link?.sent("roster")).toHaveLength(3);
  });

  test("on B2's relay, a roster it could not store is not acknowledged, and is sent again", async () => {
    await run.stop();
    let failures = 1;
    run = startRelayRun({
      ...(service === undefined ? {} : { sender: service.link }),
      store: (real) => ({
        load: () => real.load(),
        addHub: (record, presence) => real.addHub(record, presence),
        putRecord: (record) => real.putRecord(record),
        putPresence: (presence) => real.putPresence(presence),
        replaceTargets: (identity, list) =>
          failures-- > 0
            ? err({ kind: "storage", origin: "test", message: "the disk is full" })
            : real.replaceTargets(identity, list),
        targets: (identity) => real.targets(identity),
        dropTarget: (identity, key) => real.dropTarget(identity, key),
        deleteHubs: (identities) => real.deleteHubs(identities),
        close: () => {
          real.close();
        },
      }),
    });
    const side = client();
    await joined(side);
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(PHONE, KEY_ID, "fcm", fcmToken(1))],
    });
    await settle(50);
    expect(side.client.push.unackedRev).toBe(1);
    side.timers.advance(ROSTER_RESEND_MS);
    await until(() => side.client.push.unackedRev === undefined, "the second roster stored");
    expect(run.targets(IDENTITY)).toHaveLength(1);
  });

  test("a target with no key is left out, recorded; a roster over its bound is never sent", async () => {
    const relay = new ScriptedRelay();
    relay.limits = { ...relay.limits, maxRosterBytes: 4000 };
    const side = makeClient({ key: hub, connect: relay.connect });
    side.client.perform({ kind: "pushKey", client: PHONE, keyId: KEY_ID, key: KEY });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    side.client.perform({
      kind: "relayRoster",
      rev: 1,
      targets: [entry(PHONE, KEY_ID, "fcm", "t"), entry(clientId(77), OTHER_KEY_ID, "fcm", "u")],
    });
    expect(relay.last?.sent("roster")[0]?.targets.map((t) => t.token)).toEqual(["t"]);
    expect(side.of("inputRejected").map((e) => e.rejection.source)).toEqual(["core"]);
    // Two targets, each with two 1,763-character alerts, pass 4,000 bytes: not sent.
    side.client.perform({ kind: "pushKey", client: OTHER, keyId: OTHER_KEY_ID, key: OTHER_KEY });
    side.client.perform({
      kind: "relayRoster",
      rev: 2,
      targets: [entry(PHONE, KEY_ID, "fcm", "t"), entry(OTHER, OTHER_KEY_ID, "fcm", "u")],
    });
    expect(relay.last?.sent("roster").map((r) => r.rev)).toEqual([1]);
    expect(side.of("inputRejected")).toHaveLength(2);
    expect(RELAY_LIMITS.maxRosterBytes).toBe(131_072);
  });

  test("at most 4 push frames in the relay's hands; a fifth waits for a pushResult", async () => {
    const relay = new ScriptedRelay();
    relay.limits = { ...relay.limits, maxPushItemsPerFrame: 1 };
    const side = makeClient({ key: hub, connect: relay.connect });
    side.client.perform({ kind: "pushKey", client: PHONE, keyId: KEY_ID, key: KEY });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    for (let id = 1; id <= 6; id++)
      side.client.perform({
        kind: "pushSend",
        id: outboxId(id),
        client: PHONE,
        content: content(id),
      });
    await settle(5);
    const link = relay.last;
    expect(link?.sent("push").map((p) => p.items.map((i) => i.id))).toEqual([[1], [2], [3], [4]]);
    link?.send({ t: "pushResult", results: [{ id: 1, outcome: "limited" }] });
    expect(link?.sent("push")).toHaveLength(5);
    expect(side.of("pushResults")[0]?.results).toEqual([{ id: outboxId(1), outcome: "limited" }]);
    link?.send({ t: "pushResult", results: [{ id: 2, outcome: "failed" }] });
    expect(link?.sent("push").map((p) => p.items[0]?.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

test("no push key in any log line of the relay or the push service, nor in any event or report", () => {
  expect(logs.length).toBeGreaterThan(20);
  for (const key of [KEY, OTHER_KEY])
    for (const text of [
      Buffer.from(key).toString("base64url"),
      Buffer.from(key).toString("base64"),
      Buffer.from(key).toString("hex"),
    ])
      expect(logs.filter((line) => line.includes(text))).toEqual([]);
  expectNoKeyLeaks();
});
