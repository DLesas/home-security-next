/**
 * The bridge's smoke run (the brief's "a minimal development-only caller of your own"): a page the
 * bench serves at `/smoke`, opened in a simulator's browser. Through `bridgeBleCentral` (the very
 * file a development build bundles) over the simulator's network to the bridge on the Mac, it
 * pairs the smoke siren with Security 2 (Identify, then Provision, the result) and
 * updates the smoke sensor (Hello, Open, every Get, Done), then says the verdict on the page and to
 * the bench, which prints it as a `smoke` line. It runs in the simulator's browser engine.
 */
import { PROTOCOMM } from "../../../packages/protocol/src/pairing/constants.ts";
import { readPairAdvert, readPairingCode } from "../../../packages/protocol/src/pairing/code.ts";
import { setupSessionOpener } from "../../../packages/protocol/src/pairing/setup-session.ts";
import { encodeSetupMessage, SetupType } from "../../../packages/protocol/src/usb/setup.ts";
import { bridgeBleCentral } from "../src/bridge/client.ts";
import { fromHex } from "../src/bridge/wire.ts";
import { realClock } from "../src/clock.ts";
import { ScriptPhone } from "../src/script-phone.ts";

interface SmokeSession {
  readonly sirenCode: string;
  readonly sirenChip: string;
  readonly provision: string;
  readonly update: {
    readonly address: number;
    readonly sessionKey: string;
    readonly imageId: string;
    readonly file: string;
  };
}

const page = document.getElementById("page");
const lines: string[] = [];
const list = document.createElement("ol");

function show(text: string, good: boolean): void {
  lines.push(`${good ? "ok" : "NO"} ${text}`);
  const item = document.createElement("li");
  item.textContent = text;
  item.className = good ? "ok" : "no";
  list.append(item);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(): Promise<boolean> {
  const heading = document.createElement("h1");
  heading.textContent = "Bridge smoke run";
  const about = document.createElement("p");
  about.textContent = `From ${navigator.userAgent.includes("iPhone") ? "an iPhone simulator" : "this browser"} to the bench at ${location.host}.`;
  page?.append(heading, about, list);

  // Asking for the session holds the smoke siren's button for 5 seconds: its window opens.
  const session = (await (await fetch("/smoke/session")).json()) as SmokeSession;
  const central = bridgeBleCentral(`ws://${location.host}`);
  const ready = await central.ready;
  show(`the bridge answered its hello: ${String(ready)}`, ready);
  if (!ready) return false;
  const state = await central.state();
  show(`Bluetooth through the bridge: ${state}`, state === "on");

  // The name advertises the suffix. The encrypted session checks the full chip below.
  const found = await new Promise<string | undefined>((resolve) => {
    const stop = central.scan(PROTOCOMM.serviceUuid, (advert) => {
      if (readPairAdvert(advert.name)?.chipSuffix === session.sirenChip.slice(-4)) {
        stop();
        resolve(advert.id);
      }
    });
    setTimeout(() => {
      stop();
      resolve(undefined);
    }, 5000);
  });
  show(`a scan by pairing's service found the smoke siren: ${found ?? "no"}`, found !== undefined);
  if (found === undefined) return false;
  const code = readPairingCode(session.sirenCode);
  if (code === undefined) return false;
  const connected = await central.connect(found, 517);
  show(
    `connected, MTU ${connected.ok ? String(connected.value.mtu) : connected.fault}`,
    connected.ok,
  );
  if (!connected.ok) return false;
  const open = setupSessionOpener({ clock: { now: () => realClock.now(), sleep: wait } });
  const opened = await open(connected.value, code);
  show(`the Security 2 session opened: ${opened.ok ? "yes" : opened.fault}`, opened.ok);
  if (!opened.ok) return false;
  const rightChip = opened.value.version.chip === session.sirenChip;
  show("the session chip matches the smoke siren", rightChip);
  if (!rightChip) {
    opened.value.close();
    central.shutdown();
    return false;
  }
  const identity = await opened.value.exchange(encodeSetupMessage({ type: SetupType.Identify }));
  const isIdentity = identity.ok && identity.value[1] === SetupType.Identity;
  show("Identify answered with the board's Identity", isIdentity);
  const result = await opened.value.exchange(fromHex(session.provision) ?? new Uint8Array());
  const accepted =
    result.ok && result.value[1] === SetupType.ProvisionResult && result.value[2] === 0;
  show("Provision answered accepted", accepted);
  opened.value.close();

  // Updating the smoke sensor: the bench opened its window when it gave the session.
  const phone = new ScriptPhone(central, realClock, {
    address: session.update.address,
    sessionKey: fromHex(session.update.sessionKey) ?? new Uint8Array(32),
    imageId: fromHex(session.update.imageId) ?? new Uint8Array(8),
    file: fromHex(session.update.file) ?? new Uint8Array(),
  });
  const started = performance.now();
  phone.start();
  for (let i = 0; i < 600 && phone.done === undefined; i++) await wait(50);
  phone.stop();
  const verified = phone.done?.result === 0;
  show(
    `the update: Hello ${String(phone.hellos.length)}, Data ${String(phone.dataFrames)}, served ${String(phone.servedTo)} bytes, Done ${verified ? "verified" : "not verified"} in ${String(Math.round(performance.now() - started))} ms`,
    verified,
  );
  central.shutdown();
  return state === "on" && isIdentity && accepted && verified;
}

const pass = await run();
const verdict = document.createElement("p");
verdict.id = "verdict";
verdict.textContent = pass ? "SMOKE PASS" : "SMOKE FAIL";
verdict.className = pass ? "ok" : "no";
page?.append(verdict);
await fetch("/smoke/result", { method: "POST", body: JSON.stringify({ pass, lines }) });
