/**
 * A link code names the hub's relay when it is not the default (docs/m4-design.md section 9:
 * "Link codes gain `r=<relay url>`, only when the hub's relay is not the default. `formatLinkQr`
 * adds it"; section 3, "Phones": a phone learns its hub's relay from `hub.info`, the link code's
 * `r=`, or the default; m4-design section 13, F3: "`r=` is ... needed for an invite to a
 * self-hosted relay's hub"). The real hub as a process, on B2's relay; the code read by the
 * phone's own `readCode`.
 *
 * FOUND-1: the phone links using the relay supplied by `link.create` in the QR code.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll } from "../unit/shell-relay/support.ts";
import { AwayPhone } from "./phone.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder } from "./processes.ts";

const roots: string[] = [];
const seen = new Seen();
afterAll(async () => {
  await endProcesses();
  await stopAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function hubOnRelay(url: string): Promise<HubProcess> {
  const root = shortFolder("hsn-lc-");
  roots.push(root);
  const hub = new HubProcess(root);
  seen.hubDirs.push(hub.dataDir);
  await hub.start();
  check((await hub.op("relay.set", { url })).ok, "relay.set");
  return hub;
}

async function qrOf(hub: HubProcess): Promise<string> {
  const made = await hub.op("link.create", { kind: { newPerson: { name: "Rui" } }, form: "qr" });
  return made.ok && typeof made.body.qr === "string" ? made.body.qr : "";
}

describe("a link code's relay (r=)", () => {
  test("FOUND-1: a hub on a relay that is not the default names it in its codes, and a phone links by the code alone", async () => {
    const run = startRelayRun();
    const hub = await hubOnRelay(run.url);
    check(await hub.relayState("up", 15_000), "joined");
    const qr = await qrOf(hub);
    expect(await AwayPhone.relayOf(qr)).toBe(run.url);
    // The phone has nothing but the code: no relay of its own (the default is a placeholder).
    const linked = await AwayPhone.link(qr, "Rui's phone");
    expect(linked instanceof AwayPhone).toBe(true);
    await hub.stop();
  }, 60_000);

  test("with no relay in use, a code names none", async () => {
    const run = startRelayRun();
    const hub = await hubOnRelay(run.url);
    check((await hub.op("relay.set", { url: null })).ok, "relay.set null");
    expect(await AwayPhone.relayOf(await qrOf(hub))).toBeUndefined();
    await hub.stop();
  }, 60_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
