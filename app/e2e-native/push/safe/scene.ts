/** Drive the real hub's door from files in a private scratch directory. All services bind loopback. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { HomeGateway, SENSOR, seedHome } from "../../../../hub/test/relay/home";
import { AwayPhone } from "../../../../hub/test/relay/phone";
import {
  HubProcess,
  PushRole,
  RelayProgram,
  shortFolder,
  waitFor,
} from "../../../../hub/test/relay/processes";
import { arrivedFor, standIns } from "../../../../hub/test/relay/pushes";
import { endProcesses } from "../../../../hub/test/world/processes";
import { snapshotObjectV2 } from "@hsn/protocol/app";

const [serial = "", app = "", out = ""] = process.argv.slice(2);
assert(
  serial && app && out,
  "device serial, test application id and new scratch directory required",
);
process.umask(0o077);
mkdirSync(out, { mode: 0o700 });
const root = shortFolder("push-scene-");
const stand = await standIns();
const push = new PushRole(root, stand);
const relay = new RelayProgram(root, { pushUrl: push.url });
const hub = new HubProcess(root, { seed: seedHome });
const gateway = new HomeGateway();
let observer: AwayPhone | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
const state = { closing: false };
const reverse: string[] = [];
const token = "local-android-scene-phone";
process.on("SIGTERM", () => {
  state.closing = true;
});
process.on("SIGINT", () => {
  state.closing = true;
});

/** Spawns only port forwarding and the shell-protected sealed-data injector. */
function adb(args: string[]) {
  const result = spawnSync(process.env.ADB ?? "adb", ["-s", serial, ...args], { stdio: "ignore" });
  assert(result.status === 0, "device delivery/port forwarding failed");
}
/** Gives neither the device command nor its journal the link secret. */
async function invite(name: string): Promise<string> {
  const result = await hub.op("link.create", { kind: { newPerson: { name } }, form: "qr" });
  assert(result.ok && typeof result.body.qr === "string", "created one-use invitation");
  return result.body.qr;
}
/** Writes only a measured state or a non-secret checkpoint for the operator. */
function note(name: string, detail: string) {
  console.log(name, detail);
  writeFileSync(join(out, name), detail);
}
/** Observes a fresh snapshot over a separately authenticated phone session. */
async function sensorState(): Promise<string> {
  const reply = await observer?.request("snapshot", {});
  if (!reply?.ok) return "unavailable";
  const snapshot = snapshotObjectV2.safeParse(reply.body);
  return snapshot.success
    ? (snapshot.data.sensors.find((s) => s.id === SENSOR)?.arm ?? "absent")
    : "invalid";
}
try {
  await push.start();
  await relay.start();
  await hub.start();
  assert(await gateway.connect(hub.devicePort), "gateway");
  assert(
    (await hub.op("relay.set", { url: relay.url })).ok && (await hub.relayState("up", 15000)),
    "hub-relay link",
  );
  const watching = await AwayPhone.link(await invite("Observer"), "Observer", relay.url, true);
  assert(watching instanceof AwayPhone && (await watching.open()), "independent observer");
  observer = watching;
  for (const port of [17643, relay.port]) {
    const name = "tcp:" + String(port);
    adb(["reverse", "--no-rebind", name, name]);
    reverse.push(name);
  }
  let claimed = false;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 17643,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/invite" && !claimed) {
        claimed = true;
        // No LAN path in this scene. The only answering session path is the forwarded relay.
        const qr = await invite("Resident");
        return new Response(
          qr.replace(/([?&])a=[^&]*/u, "$1a=127.0.0.1").replace(/([?&])p=\d+/u, "$1p=1"),
        );
      }
      if (path === "/linked") {
        const result = await request.text();
        note("linked", result === "linked" ? "linked" : "failed");
        return new Response("");
      }
      return new Response("", { status: 404 });
    },
  });
  note("ready", "services listening");
  let seen = 0,
    phase = 0,
    door = false;
  const end = Date.now() + 30 * 60_000;
  while (!state.closing && Date.now() < end && !existsSync(join(out, "finish"))) {
    if (phase < 2 && existsSync(join(out, "arm" + String(phase + 1)))) {
      phase++;
      if (phase === 2) assert(gateway.door(false), "door reset");
      assert(
        (
          await observer.request("sensor.settings", {
            sensor: SENSOR,
            countdown: phase === 1 ? 120 : 18,
          })
        ).ok,
        "countdown setting",
      );
      assert((await observer.request("arm", { target: { sensor: SENSOR } })).ok, "armed");
      assert(
        await waitFor(async () => (await sensorState()) === "armed", 5000),
        "observer saw armed",
      );
      note("armed" + String(phase), "armed");
      door = false;
    }
    if (phase && !door && existsSync(join(out, "door" + String(phase)))) {
      door = true;
      assert(gateway.door(true), "door report sent");
      note("opened" + String(phase), String(Date.now()));
    }
    for (const arrived of arrivedFor(stand, token).slice(seen)) {
      adb([
        "shell",
        "am",
        "broadcast",
        "--receiver-foreground",
        "-n",
        app + "/app.hsn.push.LocalDelivery",
        "--es",
        "h",
        arrived.h,
      ]);
      seen++;
      note("delivered", String(seen));
    }
    if (
      door &&
      phase === 1 &&
      !existsSync(join(out, "disarmed")) &&
      (await sensorState()) === "disarmed"
    )
      note("disarmed", "observer snapshot shows sensor 2 disarmed");
    await Bun.sleep(150);
  }
} finally {
  await server?.stop(true);
  observer?.stop();
  gateway.close();
  for (const port of reverse) adb(["reverse", "--remove", port]);
  await hub.stop();
  await relay.stop();
  await push.stop();
  await stand.close();
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
}
