/** One local phone, an independent hub observer and the relay test suite's loopback stand-ins.
 * Supply an empty private output directory. Create 'door' there to start the eight-second
 * countdown, then 'finish' to stop. Provisioning contains only throwaway keys for this run.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HomeGateway, SENSOR, seedHome } from "../../../../hub/test/relay/home.ts";
import { AwayPhone } from "../../../../hub/test/relay/phone.ts";
import { HubProcess, PushRole, RelayProgram, shortFolder, waitFor } from "../../../../hub/test/relay/processes.ts";
import { apnsToken, fcmToken, openedFor, standIns } from "../../../../hub/test/relay/pushes.ts";
import { endProcesses } from "../../../../hub/test/world/processes.ts";

const [platform, device, out] = process.argv.slice(2);
if ((platform !== "ios" && platform !== "android") || !device || !out) process.exit(2);
mkdirSync(out, { mode: 0o700, recursive: true });
if (readdirSync(out).length) process.exit(2);
process.umask(0o077);
const app = "invalid.hsn.app.s5spike";
const ios = platform === "ios";
const token = ios ? apnsToken(1) : fcmToken(1);
const root = shortFolder("s5-");
const s = await standIns();
const push = new PushRole(root, s);
const relay = new RelayProgram(root, { pushUrl: push.url });
const hub = new HubProcess(root, { seed: seedHome });
const gateway = new HomeGateway();
const phones: AwayPhone[] = [];
const adb = process.env.ADB ?? "adb";
let reverse = false;
let iosProvision: string | undefined;
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

/** Stop a failed setup without including arguments or private fixture data in diagnostics. */
function requireOk(ok: boolean, step: string): asserts ok {
  if (!ok) process.exitCode = 1;
  if (!ok) throw Error(step);
}

/** Link one fixture client to this hub using its freshly generated QR invitation. */
async function link(name: string) {
  const invite = await hub.op("link.create", { kind: { newPerson: { name } }, form: "qr" });
  requireOk(invite.ok && typeof invite.body.qr === "string", "invite");
  const phone = await AwayPhone.link(invite.body.qr, name, relay.url, true);
  requireOk(phone instanceof AwayPhone, "link");
  phones.push(phone);
  requireOk(await phone.open(), "session");
  return phone;
}

/** Run a local injection, installation-data or forwarding command with confidential input on stdin. */
function run(cmd: string, args: string[], input?: string) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8" });
  requireOk(r.status === 0, cmd + " " + args[0]);
  return r.stdout.trim();
}

/** Log only states, times and test outcomes. */
function note(event: string, detail: object = {}) {
  console.log(JSON.stringify({ atMs: Date.now(), event, ...detail }));
}

try {
  await push.start();
  await relay.start();
  await hub.start();
  requireOk(await gateway.connect(hub.devicePort), "gateway");
  requireOk((await hub.op("relay.set", { url: relay.url })).ok, "relay.set");
  requireOk(await waitFor(async () => (await hub.relayStatus()).state === "up", 15000), "relay link");
  const phone = await link("Phone");
  const observer = await link("Observer");
  requireOk((await phone.registerPush(ios ? "apns" : "fcm", token)).ok, "register");
  requireOk(await waitFor(() => relay.events("roster").length > 0, 10000), "roster");
  requireOk((await phone.request("arm", { target: { sensor: SENSOR } })).ok, "arm");
  phone.stop();
  const stored = await phone.store.read();
  requireOk(stored.ok && stored.value !== undefined, "phone record");
  const r = stored.value;
  const provision = JSON.stringify({
    relayUrl: relay.url, identity: r.hub.identity, client: r.hub.client, lastSeq: r.lastSeq,
    hubStatic: Buffer.from(r.hub.staticKey).toString("hex"),
    clientPrivate: Buffer.from(r.key.privateKey).toString("hex"),
    pushKeyId: Buffer.from(phone.push.keyId).toString("hex"),
    pushKey: Buffer.from(phone.push.key).toString("base64url"),
  });
  if (ios) {
    const group = run("xcrun", ["simctl", "get_app_container", device, app, "group." + app]);
    iosProvision = join(group, "provision.json");
    writeFileSync(iosProvision, provision, { mode: 0o600 });
  } else {
    const port = "tcp:" + relay.port;
    run(adb, ["-s", device, "reverse", "--no-rebind", port, port]);
    reverse = true;
    run(adb, ["-s", device, "shell", "run-as", app, "sh", "-c", "'mkdir -p files && cat > files/provision.json'"], provision);
  }
  let opened = false;
  let seen = 0;
  note("ready", { platform, relay: relay.url });
  writeFileSync(join(out, "ready"), "");
  while (!stopping && !existsSync(join(out, "finish"))) {
    if (!opened && existsSync(join(out, "door"))) {
      requireOk(gateway.door(true), "door");
      opened = true;
      note("door.open");
    }
    const arrivals = openedFor(s, token, phone);
    for (const item of arrivals.slice(seen)) {
      if (ios) run("xcrun", ["simctl", "push", device, app, "-"], item.body);
      else run(adb, ["-s", device, "shell", "am", "broadcast", "--receiver-foreground",
        "-n", app + "/expo.modules.hsnpush.StandInFcmReceiver", "-a", "invalid.hsn.s5.FCM", "--es", "h", item.h]);
      note("forwarded", { kind: item.content.n.kind, actions: item.content.actions, serviceAtMs: item.atMs });
    }
    seen = arrivals.length;
    for (const e of observer.events.splice(0)) {
      if (e.ev === "arming") note("hub.arming", { body: e.body });
    }
    await Bun.sleep(50);
  }
} finally {
  for (const phone of phones) phone.stop();
  gateway.close();
  if (iosProvision) rmSync(iosProvision, { force: true });
  if (reverse) {
    spawnSync(adb, ["-s", device!, "shell", "run-as", app, "rm", "-f", "files/provision.json"]);
    spawnSync(adb, ["-s", device!, "reverse", "--remove", "tcp:" + relay.port]);
  }
  await hub.stop();
  await relay.stop();
  await push.stop();
  await s.close();
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
}
