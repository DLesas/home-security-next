/**
 * The restore's switch announced to the relay by a running hub (docs/m4-design.md section 4,
 * "Announcing a restart"; D96), which A8's tests cover through the loop and the function but not in
 * a running process with a relay (A8's note). Hub A, on B2's relay, has a phone linked through the
 * relay, holding A's backup key, and writes a backup; A is stopped (m2-design section 9: the old
 * hub stays off). A new hub B, joined to the relay under its own identity, is given the file
 * (`hsn restore`); the phone, at home, runs the restore with the phone's own code (`restoreHub`).
 * B then announces `restarting` before its switch: the relay holds B's grace (10 minutes ‡), B exits
 * 70 within the announcement's bound, and, started again as the restored hub, joins under A's
 * identity, with nobody told anything. Then the old hub A is started again by mistake: the newest
 * link of the identity wins, and the restored hub, replaced, says another computer uses its
 * identity and waits.
 *
 * It needs this computer on a home network: the phone restores on the hub's home listener.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { RELAY_LIMITS } from "@hsn/protocol/relay";
import { endProcesses, spawnTracked } from "../world/processes.ts";
import { startRelayRun, stopAll } from "../unit/shell-relay/support.ts";
import { AwayPhone } from "./phone.ts";
import { phoneModules, type MakeSocket } from "./phone-code.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HSN, HubProcess, shortFolder, waitFor } from "./processes.ts";
import { realTimers } from "../../../app/src/hub/wire.ts";

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

/** Bun's WebSocket as the phone's `MakeSocket`: the hub's own certificate accepted (D132). */
const bunSocket: MakeSocket = (url, origin) =>
  new WebSocket(url, {
    headers: { Origin: origin },
    tls: { rejectUnauthorized: false },
  } as unknown as string[]);

describe.skipIf(!HOME)("the restore's switch, announced by a running hub", () => {
  test("restarting before the switch; the relay holds the grace; exit 70; back as the restored hub", async () => {
    const run = startRelayRun();
    seen.logs.push(() => run.log.text());
    const root = shortFolder("hsn-ra-");
    roots.push(root);

    // Hub A, a phone linked through the relay, a backup.
    const a = new HubProcess(root);
    seen.hubDirs.push(a.dataDir);
    await a.start();
    check((await a.op("relay.set", { url: run.url })).ok, "A: relay.set");
    check(await a.relayState("up", 15 * SECOND), "A joined");
    const identityA = await a.identity();
    const invite = await a.op("link.create", { kind: { newPerson: { name: "Tom" } }, form: "qr" });
    const linked = await AwayPhone.link(invite.ok ? String(invite.body.qr) : "", "Tom", run.url);
    check(linked instanceof AwayPhone, `linked: ${JSON.stringify(linked)}`);
    const phone = linked as AwayPhone;
    phones.push(phone);
    seen.phones.push(phone);
    const backupKey = phone.backupKey;
    check(backupKey !== undefined, "the phone holds A's backup key");
    const folder = join(root, "backups");
    mkdirSync(folder);
    check((await a.op("backup.settings", { folder })).ok, "A: the backup folder");
    check((await a.op("backup.now", {})).ok, "A: a backup now");
    // The finished file only (`*.hsnb`): the hub writes `.….hsnb.tmp` and renames it.
    const files = () =>
      readdirSync(folder, { recursive: true })
        .map((entry) => join(folder, String(entry)))
        .filter((path) => path.endsWith(".hsnb") && !path.split("/").at(-1)?.startsWith("."));
    check(await waitFor(() => files().length === 1, 20 * SECOND, 200), "A's backup written");
    await a.stop();

    // Hub B, new, on the relay under its own identity.
    const b = new HubProcess(root, { programTree: true });
    seen.hubDirs.push(b.dataDir);
    await b.start();
    check((await b.op("relay.set", { url: run.url })).ok, "B: relay.set");
    check(await b.relayState("up", 15 * SECOND), "B joined");
    const identityB = await b.identity();
    expect(identityB).not.toBe(identityA);

    // `hsn restore <file>` on B; the code it shows, read by the phone.
    const restore = spawnTracked(["bun", HSN, "--data", b.dataDir, "restore", files()[0] ?? ""], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void restore.stdin.write("y\n");
    void restore.stdin.flush();
    let shown = "";
    void (async () => {
      for await (const chunk of restore.stdout) shown += new TextDecoder().decode(chunk);
    })();
    check(
      await waitFor(() => /hsn:\/\/restore\/1\?\S+/u.test(shown), 20 * SECOND),
      `the restore code shown: ${shown}`,
    );
    const app = await phoneModules();
    const read = app.readCode(/hsn:\/\/restore\/1\?\S+/u.exec(shown)?.[0] ?? "");
    check(read.ok && read.value.kind === "restore", "the phone reads the restore code");
    if (!read.ok || read.value.kind !== "restore") return;
    const code = read.value.restore;
    const key = Uint8Array.from(Buffer.from(backupKey?.key ?? "", "base64url"));
    const outcome = await app.restoreHub(code, {
      connect: app.targetsConnect(
        app.hubSocketConnect(bunSocket, realTimers),
        [{ identity: code.identity, addresses: code.reach.addresses, port: code.reach.port }],
        { answered: () => undefined, localNetworkDenied: () => undefined },
      ),
      timers: realTimers,
      app: "2.0.0",
      proto: app.PHONE_PROTO,
      held: () => Promise.resolve({ ok: true, value: [{ epoch: backupKey?.epoch ?? 0, key }] }),
    });
    const restoredAt = Date.now();
    expect(outcome).toMatchObject({ ok: true, offer: { identity: identityA } });

    // The announcement: B's grace held at the relay; B exits 70 within the bound.
    const code70 = await Promise.race([b.ended(), Bun.sleep(15 * SECOND).then(() => -1)]);
    expect(code70).toBe(70);
    expect(Date.now() - restoredAt).toBeLessThan(RELAY_LIMITS.restartAckWaitMs + 3 * SECOND);
    expect(run.relay?.presenceOf(identityB)?.graceEndMs).toBe(
      run.clock.now() + RELAY_LIMITS.maxRestartWithinMs,
    );
    expect(await restore.exited).toBe(0);

    // Started again (the launcher's part): the restored hub joins under A's identity.
    await b.start();
    expect(await b.identity()).toBe(identityA);
    check(await b.relayState("up", 15 * SECOND), "the restored hub joined");
    expect(run.relay?.presenceOf(identityA)?.state).toBe("online");
    expect(run.push.items).toEqual([]);

    // The old hub started again by mistake: two computers with one identity. The newest link wins
    // (4001); the one replaced without reconnecting itself says so (`relay_identity_in_use`) and
    // waits (section 3, "One link per identity, the newest wins"; section 16, "Risks").
    await a.start();
    check(await a.relayState("up", 15 * SECOND), "the old hub joined, under the same identity");
    check(
      await waitFor(async () => (await b.relayStatus()).lastError === "replaced", 10 * SECOND, 100),
      "the restored hub's link replaced",
    );
    const warned = await b.hsn("log", "--kind", "event");
    expect(warned.out).toContain("relay_identity_in_use");
    await Bun.sleep(3 * SECOND);
    expect((await b.relayStatus()).state).toBe("down");
    expect((await a.relayStatus()).state).toBe("up");
    await a.stop();
    await b.stop();
  }, 120_000);
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
