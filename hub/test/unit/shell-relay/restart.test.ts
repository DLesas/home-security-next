/**
 * Announcing a restart (docs/m4-design.md section 4, D96): before a switch the hub makes itself,
 * `restarting {reason, withinMs: 600000}`, then on once `restartingAck` came or 2 s ‡ passed; with
 * the link down, nothing sent and nothing waited for. On B2's relay, the announcement gives the hub
 * its grace: no unreachable alert until it ends.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import {
  identityOf,
  makeClient,
  NOWHERE,
  ScriptedRelay,
  settle,
  startRelayRun,
  staticKeyOf,
  stopAll,
  until,
} from "./support.ts";

afterEach(async () => {
  await stopAll();
});

describe("announceRestart", () => {
  test("on B2's relay: restarting {update, 600000}, acknowledged; the relay holds the grace", async () => {
    const run = startRelayRun();
    const key = staticKeyOf(80);
    const side = makeClient({ key });
    side.client.perform({ kind: "relayConnect", url: run.url });
    await until(() => side.client.state.kind === "up", "the link up");
    let done = false;
    const announced = side.client.announceRestart("update").then(() => {
      done = true;
    });
    await until(() => done, "the acknowledgement");
    await announced;
    const presence = run.relay?.presenceOf(identityOf(key, sha256));
    expect(presence?.graceEndMs).toBe(run.clock.now() + RELAY_LIMITS.maxRestartWithinMs);
    // Within the 2 s: no timer left behind for it.
    expect(side.timers.pending).toBe(2);
  });

  test("the frame and its reason, as the relay sees them; a restore too", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: staticKeyOf(81), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    const update = side.client.announceRestart("update");
    relay.last?.send({ t: "restartingAck" });
    await update;
    const restore = side.client.announceRestart("restore");
    relay.last?.send({ t: "restartingAck" });
    await restore;
    expect(relay.last?.sent("restarting")).toEqual([
      { t: "restarting", reason: "update", withinMs: 600_000 },
      { t: "restarting", reason: "restore", withinMs: 600_000 },
    ]);
  });

  test("the relay's smaller bound is kept", async () => {
    const relay = new ScriptedRelay();
    relay.limits = { ...relay.limits, maxRestartWithinMs: 120_000 };
    const side = makeClient({ key: staticKeyOf(82), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    const announced = side.client.announceRestart("update");
    relay.last?.send({ t: "restartingAck" });
    await announced;
    expect(relay.last?.sent("restarting")[0]?.withinMs).toBe(120_000);
  });

  test("no acknowledgement: the switch goes on after 2 s, not before", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: staticKeyOf(83), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    let done = false;
    void side.client.announceRestart("update").then(() => {
      done = true;
    });
    side.timers.advance(RELAY_LIMITS.restartAckWaitMs - 1);
    await settle(5);
    expect(done).toBe(false);
    side.timers.advance(1);
    await settle(5);
    expect(done).toBe(true);
  });

  test("the link lost while waiting: on at once", async () => {
    const relay = new ScriptedRelay();
    const side = makeClient({ key: staticKeyOf(84), connect: relay.connect });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "up", "up");
    let done = false;
    void side.client.announceRestart("restore").then(() => {
      done = true;
    });
    relay.last?.close(1001);
    await settle(5);
    expect(done).toBe(true);
  });

  test("with the link down nothing is sent and nothing waited for", async () => {
    const side = makeClient({ key: staticKeyOf(85), connect: NOWHERE });
    side.client.perform({ kind: "relayConnect", url: "ws://127.0.0.1:1" });
    await until(() => side.client.state.kind === "waiting", "down");
    let done = false;
    void side.client.announceRestart("update").then(() => {
      done = true;
    });
    await settle(1);
    expect(done).toBe(true);
    const off = makeClient({ key: staticKeyOf(86) });
    await off.client.announceRestart("update");
  });
});
