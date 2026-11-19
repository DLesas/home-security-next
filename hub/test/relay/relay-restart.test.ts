/**
 * A relay restart with the real hub (docs/m4-design.md section 3, "Presence"; D96: "a restarted
 * relay starts its 3-minute clock afresh"; section 11, "Hub-unreachable": "a relay restart: the
 * clock afresh"). B2's relay on loopback with the test's clock (`Relay.start`, as B2's note says
 * tests that need the clock do), stopped and started again on its port and its SQLite file; the
 * real hub as a process; a phone on the phone's own code registered through the relay, so the
 * hub's roster, and the alerts it sealed, are the real hub's.
 *
 * - A hub gone when the relay restarts is alerted 180 s after the relay's start, not 180 s after
 *   its last frame; an alerted hub stays alerted across a restart, is not alerted again, and gets
 *   `back` when it returns.
 * - A running hub whose relay restarts is back on it within its back-off, well inside the fresh 3
 *   minutes, and nobody is told anything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll, type RelayRun } from "../unit/shell-relay/support.ts";
import { AwayPhone } from "./phone.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder, waitFor } from "./processes.ts";
import { fcmToken } from "./pushes.ts";
import { rmSync } from "node:fs";

const SECOND = 1000;
const roots: string[] = [];
const phones: AwayPhone[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const phone of phones) phone.stop();
  await endProcesses();
  await stopAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A hub joined to `run`, with a phone linked and registered through it. */
async function joinedHub(
  run: RelayRun,
  token: string,
): Promise<{ readonly hub: HubProcess; readonly phone: AwayPhone; readonly identity: string }> {
  const root = shortFolder("hsn-rr-");
  roots.push(root);
  const hub = new HubProcess(root);
  seen.hubDirs.push(hub.dataDir);
  seen.tokens.push(token);
  seen.logs.push(() => run.log.text());
  seen.sealed.push(() => run.push.items.map((item) => item.h));
  await hub.start();
  check((await hub.op("relay.set", { url: run.url })).ok, "relay.set");
  check(await hub.relayState("up", 15 * SECOND), "the hub's link up");
  const invite = await hub.op("link.create", { kind: { newPerson: { name: "Ida" } }, form: "qr" });
  const linked = await AwayPhone.link(
    invite.ok ? String(invite.body.qr) : "",
    "Ida's phone",
    run.url,
  );
  const phone = linked instanceof AwayPhone ? linked : undefined;
  check(phone !== undefined, `the phone linked: ${JSON.stringify(linked)}`);
  if (phone === undefined) return { hub, phone: linked as unknown as AwayPhone, identity: "" };
  phones.push(phone);
  seen.phones.push(phone);
  check(await phone.open(), "the phone's session");
  check((await phone.registerPush("fcm", token)).ok, "push.register");
  const identity = await hub.identity();
  check(
    await waitFor(() => run.targets(identity).length === 1, 10 * SECOND),
    "the roster at the relay",
  );
  phone.stop();
  return { hub, phone, identity };
}

/** The alerts the relay sent for `identity`, opened with the phone's key. */
function alertsOf(run: RelayRun, phone: AwayPhone, identity: string): string[] {
  return run.push.items
    .filter((item) => item.hub === identity)
    .map((item) => phone.openPush(item.h)?.n.kind ?? "unopened");
}

describe("a relay restart, with the real hub (D96)", () => {
  test("a hub gone across the restart is alerted 180 s after the relay's start; alerted, it stays so and gets back", async () => {
    const run = startRelayRun();
    const { hub, phone, identity } = await joinedHub(run, fcmToken(31));
    await hub.kill();
    check(
      await waitFor(() => run.relay?.counts.joined === 0, 5 * SECOND),
      "the relay saw the link go",
    );
    const lastContact = run.relay?.presenceOf(identity)?.lastContactMs ?? 0;
    // 100 s pass; the relay restarts on its file.
    run.clock.advance(100 * SECOND);
    expect(alertsOf(run, phone, identity)).toEqual([]);
    await run.stop();
    run.start();
    const startedAt = run.clock.now();
    expect(run.relay?.presenceOf(identity)?.lastContactMs).toBe(startedAt);
    // 180 s after the last frame passes in silence: the clock started afresh.
    run.clock.advance(lastContact + 180 * SECOND - startedAt + 10 * SECOND);
    await Bun.sleep(50);
    expect(alertsOf(run, phone, identity)).toEqual([]);
    // 180 s after the relay's start, not a second before.
    run.clock.advance(startedAt + 180 * SECOND - run.clock.now() - 1);
    await Bun.sleep(50);
    expect(alertsOf(run, phone, identity)).toEqual([]);
    run.clock.advance(1);
    await waitFor(() => alertsOf(run, phone, identity).length === 1, 5 * SECOND);
    expect(alertsOf(run, phone, identity)).toEqual(["hub_unreachable"]);

    // Alerted, the relay restarts again: it stays alerted, and is not alerted a second time.
    await run.stop();
    run.start();
    expect(run.relay?.presenceOf(identity)?.state).toBe("alerted");
    run.clock.advance(400 * SECOND);
    await Bun.sleep(50);
    expect(alertsOf(run, phone, identity)).toEqual(["hub_unreachable"]);

    // The hub returns: `back`, the one the hub sealed for this phone.
    await hub.start();
    check(await hub.relayState("up", 15 * SECOND), "the hub back on the relay");
    check(
      await waitFor(() => alertsOf(run, phone, identity).length === 2, 5 * SECOND),
      "the back alert",
    );
    expect(alertsOf(run, phone, identity)).toEqual(["hub_unreachable", "hub_back"]);
    await hub.stop();
  }, 90_000);

  test("a running hub is back on its restarted relay within its back-off, and nobody is told", async () => {
    const run = startRelayRun();
    const { hub, phone, identity } = await joinedHub(run, fcmToken(32));
    const stoppedAt = Date.now();
    await run.stop();
    check(await hub.relayState("down", 5 * SECOND), "the hub saw its relay go (1001)");
    await Bun.sleep(3 * SECOND);
    run.start();
    const startedAt = run.clock.now();
    check(await hub.relayState("up", 20 * SECOND), "the hub back on the restarted relay");
    const backAfterMs = Date.now() - stoppedAt;
    // The back-off's first steps (1, 2, 4 s, each ±20%) bring it back long before 180 s.
    expect(backAfterMs).toBeLessThan(15 * SECOND);
    expect(run.relay?.presenceOf(identity)?.state).toBe("online");
    expect(run.relay?.presenceOf(identity)?.lastContactMs).toBeGreaterThanOrEqual(startedAt);
    // Its roster again on the new run, and nothing sent to anyone.
    check(
      await waitFor(() => run.targets(identity).length === 1, 10 * SECOND),
      "the roster sent again",
    );
    expect(alertsOf(run, phone, identity)).toEqual([]);
    await hub.stop();
  }, 90_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
