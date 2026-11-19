/**
 * A change of the computer's addresses connects a waiting relay link at once (docs/m4-design.md
 * section 4, "Back-off": "A change of the computer's addresses (the shell checks every minute for
 * `hubFacts`, M2) reconnects at once and resets the back-off"), in a running hub: `main.ts`'s own
 * minute check calling `networkChanged`, which B6 wired and did not test.
 *
 * The hub runs in `network-changed-hub.test.ts`'s process, whose `node:os` gains an interface when
 * this test writes a file. On B2's relay with the test's clock, three other identities from this
 * address have used up today's new identities (D142), so the hub's join is answered `limit` and
 * 4429, and it waits hours. The relay's day turns; the hub still waits. Then its addresses change:
 * within the minute's check it connects, and joins. About 70 s, so with `HSN_M4=1` only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADDRESS_CHECK_MS } from "../../src/shell/hub-facts.ts";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll } from "../unit/shell-relay/support.ts";
import { StandInHub } from "../../../relay/test/helpers.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder, waitFor } from "./processes.ts";

const SLOW = process.env.HSN_M4 === "1";
const SECOND = 1000;
const FIXTURE = join(import.meta.dir, "network-changed-hub.test.ts");
const roots: string[] = [];
const seen = new Seen();
afterAll(async () => {
  await endProcesses();
  await stopAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!SLOW)("networkChanged, in a running hub", () => {
  test("a hub waiting hours after a limit connects within the minute's check once its addresses change", async () => {
    const run = startRelayRun();
    seen.logs.push(() => run.log.text());
    // Today's three new identities from 127.0.0.1, taken by others.
    for (let i = 0; i < 3; i++) {
      const other = await StandInHub.connect(run.url);
      expect(other.welcome).toBeDefined();
    }
    const root = shortFolder("hsn-nc-");
    roots.push(root);
    const file = join(root, "network-changed");
    const argsFile = join(root, "hub-args.json");
    // `bun test` takes no hub options: the fixture reads the hub's arguments from a file.
    const hub = new HubProcess(root, {
      command: (args) => {
        writeFileSync(argsFile, JSON.stringify(args));
        return ["bun", "test", "--timeout", "600000", FIXTURE];
      },
      env: { HSN_NETWORK_HUB: file, HSN_NETWORK_HUB_ARGS: argsFile },
    });
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    check((await hub.op("relay.set", { url: run.url })).ok, "relay.set");
    check(
      await waitFor(
        async () => (await hub.relayStatus()).lastError === "limited",
        10 * SECOND,
        100,
      ),
      "the join answered with a limit",
    );
    // The relay's day turns, so the limit is gone; the hub, told to wait hours, still waits.
    run.clock.advance(25 * 60 * 60 * SECOND);
    await Bun.sleep(3 * SECOND);
    expect((await hub.relayStatus()).state).toBe("down");
    expect(run.relay?.counts.joined).toBe(0);

    // The computer's addresses change.
    const changedAt = Date.now();
    writeFileSync(file, "changed\n");
    check(
      await hub.relayState("up", ADDRESS_CHECK_MS + 15 * SECOND),
      "joined once the minute's check saw the change",
    );
    expect(Date.now() - changedAt).toBeLessThan(ADDRESS_CHECK_MS + 15 * SECOND);
    expect(run.relay?.counts.joined).toBe(1);
    await hub.stop();
  }, 180_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
