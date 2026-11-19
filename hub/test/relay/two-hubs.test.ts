/**
 * Two homes on one relay, kept apart (docs/m4-design.md section 11, "Hub and relay together"):
 * two real hubs as processes on B2's relay, two phones linked to the first and one to the second,
 * each on the phone's own code through the relay, each registered for push with its own key.
 *
 * - Each hub's roster at the relay holds its own phones' targets and no other's.
 * - A test push from each phone reaches that phone's token only, names its own hub, and opens with
 *   that phone's key only.
 * - An event of one home reaches its own phones' sessions only.
 * - A phone of one hub cannot open a session on the other's path: the other hub refuses its key
 *   before message 2.
 * - When both hubs go quiet, each phone is told about its own hub, in an alert sealed for it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll, type RelayRun } from "../unit/shell-relay/support.ts";
import { AwayPhone, relayConnect } from "./phone.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder, waitFor } from "./processes.ts";
import { apnsToken, fcmToken } from "./pushes.ts";

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

async function hubOn(run: RelayRun): Promise<{ hub: HubProcess; identity: string }> {
  const root = shortFolder("hsn-2h-");
  roots.push(root);
  const hub = new HubProcess(root);
  seen.hubDirs.push(hub.dataDir);
  await hub.start();
  check((await hub.op("relay.set", { url: run.url })).ok, "relay.set");
  check(await hub.relayState("up", 15 * SECOND), "the hub's link up");
  return { hub, identity: await hub.identity() };
}

async function phoneOf(run: RelayRun, hub: HubProcess, name: string): Promise<AwayPhone> {
  const invite = await hub.op("link.create", { kind: { newPerson: { name } }, form: "qr" });
  const linked = await AwayPhone.link(
    invite.ok ? String(invite.body.qr) : "",
    `${name}'s phone`,
    run.url,
  );
  check(linked instanceof AwayPhone, `${name}'s phone linked: ${JSON.stringify(linked)}`);
  const phone = linked as AwayPhone;
  phones.push(phone);
  seen.phones.push(phone);
  check(await phone.open(), `${name}'s session`);
  return phone;
}

const kinds = (run: RelayRun, token: string, phone: AwayPhone) =>
  run.push.items
    .filter((item) => item.token === token)
    .map((item) => {
      const content = phone.openPush(item.h);
      return content === undefined ? "unopened" : `${content.hub}:${content.n.kind}`;
    });

describe("two hubs and three phones on one relay", () => {
  test("kept apart: rosters, pushes, events, sessions and alerts", async () => {
    const run = startRelayRun();
    seen.logs.push(() => run.log.text());
    seen.sealed.push(() => run.push.items.map((item) => item.h));
    const one = await hubOn(run);
    const two = await hubOn(run);
    expect(one.identity).not.toBe(two.identity);
    const ann = await phoneOf(run, one.hub, "Ann");
    const bob = await phoneOf(run, one.hub, "Bob");
    const cat = await phoneOf(run, two.hub, "Cat");
    const tokens = { ann: fcmToken(41), bob: apnsToken(42), cat: fcmToken(43) };
    seen.tokens.push(tokens.ann, tokens.bob, tokens.cat);
    for (const [phone, platform, token] of [
      [ann, "fcm", tokens.ann],
      [bob, "apns", tokens.bob],
      [cat, "fcm", tokens.cat],
    ] as const)
      check((await phone.registerPush(platform, token)).ok, `${phone.name} registered`);
    check(
      await waitFor(
        () => run.targets(one.identity).length === 2 && run.targets(two.identity).length === 1,
        10 * SECOND,
      ),
      "both rosters at the relay",
    );
    expect(
      run
        .targets(one.identity)
        .map((t) => t.token)
        .toSorted(),
    ).toEqual([tokens.ann, tokens.bob].toSorted());
    expect(run.targets(two.identity).map((t) => t.token)).toEqual([tokens.cat]);

    // Each phone's test push: its token only, its hub, its key.
    for (const phone of [ann, bob, cat])
      check((await phone.request("push.test", {})).ok, `${phone.name}'s push.test`);
    check(await waitFor(() => run.push.items.length >= 3, 10 * SECOND), "three test pushes");
    expect(kinds(run, tokens.ann, ann)).toEqual([`${one.identity}:push_test`]);
    expect(kinds(run, tokens.bob, bob)).toEqual([`${one.identity}:push_test`]);
    expect(kinds(run, tokens.cat, cat)).toEqual([`${two.identity}:push_test`]);
    for (const item of run.push.items) {
      const owners = [ann, bob, cat].filter((phone) => phone.openPush(item.h) !== undefined);
      expect(owners).toHaveLength(1);
      expect(item.hub).toBe(owners[0] === cat ? two.identity : one.identity);
    }

    // An event of home one reaches its phones' sessions, never home two's.
    for (const phone of [ann, bob, cat])
      check((await phone.request("subscribe", { topics: ["config"] })).ok, "subscribed");
    const made = await one.hub.op("group.create", { name: "Upstairs", sensors: [], sirens: "all" });
    check(made.ok, "a group made in home one");
    check(
      await waitFor(
        () =>
          ann.events.some((e) => e.ev === "config") && bob.events.some((e) => e.ev === "config"),
        5 * SECOND,
      ),
      "home one's phones told",
    );
    await Bun.sleep(500);
    expect(cat.events.filter((e) => e.ev === "config")).toEqual([]);

    // Ann's key on home two's path: refused before message 2 (the hub does not know it).
    const crossed = await ann.disarmFirst([relayConnect(run.url, two.identity)]);
    expect(crossed.reply).toBeUndefined();
    expect(crossed.failed).toBe("message 2: closed");

    // Both hubs gone: each phone is told about its own, sealed for it.
    for (const phone of [ann, bob, cat]) phone.stop();
    await one.hub.kill();
    await two.hub.kill();
    check(await waitFor(() => run.relay?.counts.joined === 0, 5 * SECOND), "both links gone");
    const before = run.push.items.length;
    run.clock.advance(181 * SECOND);
    check(await waitFor(() => run.push.items.length >= before + 3, 5 * SECOND), "three alerts");
    expect(kinds(run, tokens.ann, ann).at(-1)).toBe(`${one.identity}:hub_unreachable`);
    expect(kinds(run, tokens.bob, bob).at(-1)).toBe(`${one.identity}:hub_unreachable`);
    expect(kinds(run, tokens.cat, cat).at(-1)).toBe(`${two.identity}:hub_unreachable`);
    expect(run.push.items.length).toBe(before + 3);
  }, 120_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
