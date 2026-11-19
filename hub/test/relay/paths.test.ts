/**
 * One phone, two paths (docs/m4-design.md section 8: "Both carry the same Noise session; sessions
 * and `seq` are per client, not per socket, so moving from one path to the other is a reconnect
 * with nothing lost"; section 11, "a session through the relay and one at home for one client").
 * The real hub as a process on B2's relay; one phone on the phone's own code, its session through
 * the relay and another at home (the hub's home listener, by `targetsConnect`, as the phone tries
 * its addresses), sharing its record and `seq`.
 *
 * - Both open at once, for one client; changes alternate between them, each `seq` above the last,
 *   none refused, and the hub's last `seq` for the client is the last one sent.
 * - The relay gone: the home session carries on; the relay back: the relayed session reconnects
 *   and its next change follows on.
 *
 * It needs this computer on a home network, for the home listener.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { realTimers } from "../../../app/src/hub/wire.ts";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll } from "../unit/shell-relay/support.ts";
import { Seen } from "./leaks.ts";
import { AwayPhone } from "./phone.ts";
import { type MakeSocket, phoneModules } from "./phone-code.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder, waitFor } from "./processes.ts";

const SECOND = 1000;
const HOME = Object.values(networkInterfaces())
  .flatMap((list) => list ?? [])
  .some((info) => info.family === "IPv4" && !info.internal);
const roots: string[] = [];
const phones: AwayPhone[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const phone of phones) phone.stop();
  await endProcesses();
  await stopAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const bunSocket: MakeSocket = (url, origin) =>
  new WebSocket(url, {
    headers: { Origin: origin },
    tls: { rejectUnauthorized: false },
  } as unknown as string[]);

function lastSeq(dataDir: string, client: number): number {
  const db = new Database(join(dataDir, "hub.db"), { readonly: true });
  const row = db
    .query<{ last_seq: number }, [number]>("SELECT last_seq FROM clients WHERE id = ?")
    .get(client);
  db.close();
  return row?.last_seq ?? -1;
}

describe.skipIf(!HOME)("one phone, at home and through the relay", () => {
  test("two sessions of one client at once; changes on either follow on; the relay gone and back, nothing lost", async () => {
    const run = startRelayRun();
    seen.logs.push(() => run.log.text());
    const root = shortFolder("hsn-pa-");
    roots.push(root);
    const hub = new HubProcess(root);
    seen.hubDirs.push(hub.dataDir);
    await hub.start();
    check((await hub.op("relay.set", { url: run.url })).ok, "relay.set");
    check(await hub.relayState("up", 15 * SECOND), "joined");
    const invite = await hub.op("link.create", {
      kind: { newPerson: { name: "Vic" } },
      form: "qr",
    });
    const linked = await AwayPhone.link(invite.ok ? String(invite.body.qr) : "", "Vic", run.url);
    check(linked instanceof AwayPhone, `linked: ${JSON.stringify(linked)}`);
    const phone = linked as AwayPhone;
    phones.push(phone);
    seen.phones.push(phone);
    check(await phone.open(), "the session through the relay");
    const info = await phone.request("hub.info", {});
    const body = info.ok ? (info.body as { addresses: string[]; appsPort: number }) : undefined;
    check(body !== undefined && body.addresses.length > 0, "hub.info names the home addresses");
    const app = await phoneModules();
    const home = await phone.openAlso(
      app.targetsConnect(
        app.hubSocketConnect(bunSocket, realTimers),
        [{ identity: phone.identity, addresses: body?.addresses ?? [], port: body?.appsPort ?? 0 }],
        { answered: () => undefined, localNetworkDenied: () => undefined },
      ),
    );
    check(home.open, "the session at home, at the same time");

    const group = (name: string) => ({ name, sensors: [], sirens: "all" });
    expect((await phone.request("group.create", group("Relay one"))).ok).toBe(true);
    expect((await home.channel.forward("group.create", group("Home one"))).ok).toBe(true);
    expect((await phone.request("group.create", group("Relay two"))).ok).toBe(true);
    const stored = await phone.store.read();
    const sent = stored.ok ? (stored.value?.lastSeq ?? 0) : 0;
    expect(sent).toBe(3);
    expect(lastSeq(hub.dataDir, phone.client)).toBe(sent);

    // The relay gone: home carries on. Back: the relayed session reconnects, and follows on.
    await run.stop();
    expect((await home.channel.forward("group.create", group("Home two"))).ok).toBe(true);
    run.start();
    check(await hub.relayState("up", 20 * SECOND), "the hub back on the relay");
    check(await waitFor(() => phone.status === "open", 20 * SECOND), "the relayed session back");
    expect((await phone.request("group.create", group("Relay three"))).ok).toBe(true);
    const after = await phone.store.read();
    const last = after.ok ? (after.value?.lastSeq ?? 0) : 0;
    expect(last).toBe(sent + 2);
    expect(lastSeq(hub.dataDir, phone.client)).toBe(last);
    const groups = await hub.op("snapshot", {});
    expect(JSON.stringify(groups)).toContain("Relay three");
    phone.stop();
    await hub.stop();
  }, 120_000);

  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
