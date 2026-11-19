/**
 * The operator refuses a hub's key (docs/m4-design.md section 3, D142: "the operator can refuse"; B2's
 * `refusedHubs`, read again on SIGHUP; B6's reaction to 4403): the relay program as a process with
 * its file of refused identities, the real hub as a process.
 *
 * - Refused while joined: the operator adds the identity and sends SIGHUP; the hub's link closes
 *   4403; the hub says so once and tries nothing more, though its back-off would have tried three
 *   times by now; `relay.status` says down. Lifted, the hub still waits until it restarts (or the
 *   setting changes), and then joins.
 * - Refused at join: a hub whose identity is refused is closed 4403 after message 3, and does not
 *   try again either.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { endProcesses } from "../world/processes.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, RelayProgram, shortFolder, waitFor } from "./processes.ts";

const SECOND = 1000;
const REFUSED_SAYS = "the relay refuses this hub's key (4403)";
const roots: string[] = [];
const relays: RelayProgram[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const relay of relays) await relay.stop();
  await endProcesses();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A relay with a refused-hubs file and no push service (none is needed to refuse a hub). */
async function relayWithRefusals(): Promise<{ relay: RelayProgram; file: string; root: string }> {
  const root = shortFolder("hsn-ref-");
  roots.push(root);
  const file = join(root, "refused-hubs");
  writeFileSync(file, "# none\n");
  const relay = new RelayProgram(root, {
    pushUrl: `ws+unix://${join(root, "no-push.sock")}:/v1/relay`,
    refusedHubs: file,
  });
  await relay.start();
  relays.push(relay);
  seen.relayDirs.push(relay.dataFolder);
  return { relay, file, root };
}

const joins = (relay: RelayProgram) => relay.events("hubJoined").length;
const refusals = (relay: RelayProgram) => relay.events("hubRefused").length;

describe("the operator refuses a hub's key", () => {
  test("refused while joined: closed 4403, said once, never tried again until the hub restarts", async () => {
    const { relay, file, root } = await relayWithRefusals();
    const hub = new HubProcess(root);
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    check((await hub.op("relay.set", { url: relay.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "joined");
    expect(joins(relay)).toBe(1);
    const identity = await hub.identity();

    writeFileSync(file, `# refused by the operator\n${identity}\n`);
    relay.hangUp();
    check(await hub.relayState("down", 10 * SECOND), "the link closed");
    check(
      await waitFor(() => (hub.out?.text ?? "").includes(REFUSED_SAYS), 5 * SECOND),
      "the hub says the relay refuses its key",
    );
    // Its back-off would have tried at about 1, 3 and 7 s: nothing comes.
    await Bun.sleep(10 * SECOND);
    expect(joins(relay)).toBe(1);
    expect(refusals(relay)).toBeLessThanOrEqual(1);
    expect(hub.out?.count(REFUSED_SAYS)).toBe(1);
    const status = await hub.relayStatus();
    expect(status).toMatchObject({ url: relay.url, state: "down" });

    // Lifted: nothing happens by itself; at the hub's next start it joins.
    writeFileSync(file, "# none\n");
    relay.hangUp();
    await Bun.sleep(3 * SECOND);
    expect(joins(relay)).toBe(1);
    await hub.stop();
    await hub.start();
    check(await hub.relayState("up", 15 * SECOND), "joined again after a restart");
    expect(joins(relay)).toBe(2);
    await hub.stop();
  }, 90_000);

  test("refused at join: closed after message 3, and not tried again", async () => {
    const { relay, file, root } = await relayWithRefusals();
    const hub = new HubProcess(root);
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    const identity = await hub.identity();
    writeFileSync(file, `${identity}\n`);
    relay.hangUp();
    await Bun.sleep(500);
    check((await hub.op("relay.set", { url: relay.url })).ok, "relay.set");
    check(
      await waitFor(() => (hub.out?.text ?? "").includes(REFUSED_SAYS), 10 * SECOND),
      "the hub says the relay refuses its key",
    );
    await Bun.sleep(8 * SECOND);
    expect(joins(relay)).toBe(0);
    expect(hub.out?.count(REFUSED_SAYS)).toBe(1);
    expect((await hub.relayStatus()).state).toBe("down");
    // The relay's log names no identity.
    expect(relay.out?.text.includes(identity)).toBe(false);
    await hub.stop();
  }, 60_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
