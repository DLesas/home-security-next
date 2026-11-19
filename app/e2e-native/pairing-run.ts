/** Simulator P4 fixture: a real hub with a surveyed site, and real-handshake boards on a private loopback bridge. */
import { spawnSync } from "node:child_process";
import { z } from "../../packages/protocol/node_modules/zod";
import { Role } from "../../packages/protocol/src/messages/common";
import { fromHex } from "../../packages/protocol/src/bytes";
import { formatPairingCode, makePairingCode } from "../../packages/protocol/src/pairing/code";
import { nthFrame, TransferKind } from "../../tools/ble-bench/src/air/faults";
import { BleAir } from "../../tools/ble-bench/src/air/air";
import { PAIRING_HOLD_MS, placeBoard, ScriptedBoard } from "../../tools/ble-bench/src/boards/board";
import { startBridge } from "../../tools/ble-bench/src/bridge/server";
import { realClock } from "../../tools/ble-bench/src/clock";
import { startRealHub, stopAllHubs } from "../test/support/real-hub";
import { pairingRadio, SIMULATOR_GATEWAY } from "./pairing-radio";
import { seedPairingSite } from "../test/support/pairing-site";

const linkReply = z.object({
  reply: z.object({ result: z.object({ body: z.object({ qr: z.string() }) }) }),
});
const port = Number(process.env.HSN_P4_BRIDGE_PORT ?? 8878);
const deviceCommand = process.env.HSN_P4_DEVICE;
const hub = await startRealHub((dir) => {
  seedPairingSite(dir, SIMULATOR_GATEWAY);
});
const radio = pairingRadio(hub, say);
await hub.control({
  kind: "siteWifi",
  name: "Test network",
  password: "test-only-password",
});
/** Roles whose first contact with the hub after pairing is held back (`holdoff <role>`). */
const heldBack = new Set<string>();
const pendingContact = new Map<string, Parameters<typeof radio.paired>>();

/** A paired board's first contact with the hub, unless `holdoff` holds it until `release`. */
function contact(role: string, ...args: Parameters<typeof radio.paired>) {
  if (heldBack.has(role)) {
    pendingContact.set(role, args);
    say(`${role}: first contact held back until release ${role}`);
  } else radio.paired(...args);
}

const air = new BleAir(realClock, { advertIntervalMs: 100, connectTimeoutMs: 5000 });
const boards = new Map([
  [
    "sensor",
    placeBoard(
      air,
      new ScriptedBoard(
        realClock,
        { role: Role.Sensor, chipId: fromHex("54881234ab10") },
        {
          provisioned: (pairing, board) => {
            contact("sensor", pairing, board);
            say("Sensor paired");
          },
          updateStatus: (status) => {
            radio.result(status);
          },
        },
      ),
    ),
  ],
  [
    "siren",
    placeBoard(
      air,
      new ScriptedBoard(
        realClock,
        { role: Role.Siren, chipId: fromHex("54881234ab11") },
        {
          provisioned: (pairing, board) => {
            contact("siren", pairing, board);
            say("Siren paired");
          },
        },
      ),
    ),
  ],
  [
    "gateway",
    placeBoard(
      air,
      new ScriptedBoard(
        realClock,
        { role: Role.Gateway, chipId: fromHex("54881234ab12") },
        {
          provisioned: () => {
            say("Gateway paired");
          },
        },
      ),
    ),
  ],
]);
const bridge = startBridge({ air, port, central: { maxMtu: 185 } });
if (!bridge.ok) {
  say("Could not start the loopback bridge");
  await stopAllHubs();
  process.exit(1);
}

say(`Fixture ready at ${bridge.value.url}`);
// A board's code is a secret: it is never printed. `type <role>` enters it where a person would.
say(`Boards placed: ${[...boards.keys()].join(", ")}; codes not printed, use type <role>`);

/** The length of a `hold` command, in milliseconds: the five-second hold when none is given. */
function holdMs(text: string | undefined): number {
  const ms = Number(text);
  return text === undefined || !Number.isFinite(ms) || ms < 0 ? PAIRING_HOLD_MS : ms;
}

/** Keeps each fixture status to a non-secret line. */
function say(message: string) {
  process.stdout.write(`${message}\n`);
}

/** Opens a QR through this thread's bound device command, with command output suppressed. */
function openCode(code: string) {
  if (deviceCommand === undefined) {
    say("No bound device command");
    return;
  }
  const opened = spawnSync(deviceCommand, ["open", "invalid.hsn.app", code], { stdio: "ignore" });
  say(opened.status === 0 ? "Code opened" : "Could not open the code");
}

/** Types text into the app's focused field through the bound device command, output suppressed. */
function typeText(text: string, what: string) {
  if (deviceCommand === undefined) {
    say("No bound device command");
    return;
  }
  const typed = spawnSync(deviceCommand, ["type", text, "--no-record"], { stdio: "ignore" });
  say(typed.status === 0 ? `Typed ${what}` : `Could not type ${what}`);
}

/** A code of valid format (its check character holds) that is not this board's. */
function wrongCode(board: ScriptedBoard): string {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    let secret = 0n;
    for (const byte of bytes) secret = (secret << 8n) | BigInt(byte);
    const code = makePairingCode(secret & ((1n << 35n) - 1n));
    if (code !== undefined && code !== board.code) return formatPairingCode(code);
  }
}

/** Generates a fresh simulator-only link without printing it. */
async function link() {
  const control = await hub.control({
    kind: "op",
    op: "link.create",
    body: {
      kind: { newPerson: { name: `Simulator household ${String(Date.now())}` } },
      form: "qr",
    },
  });
  const parsed = linkReply.safeParse(control);
  if (parsed.success) openCode(parsed.data.reply.result.body.qr);
  else say("The hub refused the fixture link");
}

/** Shuts down only this fixture's bridge, hub and data folder. */
async function stop() {
  if (bridge.ok) bridge.value.stop();
  radio.close();
  await stopAllHubs();
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
for await (const line of console) {
  const [command, role, length] = line.trim().split(/\s+/u);
  const board = role === undefined ? undefined : boards.get(role);
  if (command === "quit") await stop();
  else if (command === "link") await link();
  else if (command === "qr" && board !== undefined) openCode(board.qr);
  else if (command === "type" && board !== undefined)
    typeText(board.shownCode, `the ${role}'s code`);
  else if (command === "wrong" && board !== undefined) typeText(wrongCode(board), "a wrong code");
  else if (command === "plan") await radio.plan();
  else if (command === "wake") radio.wake();
  // `slow` adds 20 ms each way; `slow <ms>` another delay, to watch or cancel a transfer.
  else if (command === "slow") {
    const ms = role === undefined || !Number.isFinite(Number(role)) ? 20 : Number(role);
    air.faults = { latencyMs: ms, boardDelayMs: ms };
  } else if (command === "drop")
    air.faults = { latencyMs: 20, dropAfter: nthFrame(TransferKind.Data, 30) };
  // Drops the link just after the board's first Hello reaches the phone: before Open is accepted.
  else if (command === "dropearly")
    air.faults = { latencyMs: 20, dropAfter: nthFrame(TransferKind.Hello, 1) };
  else if (command === "normal") air.faults = {};
  else if (command === "holdoff" && board !== undefined) {
    heldBack.add(role ?? "");
    say(`${role ?? "?"}: first contact will be held back`);
  } else if (command === "release" && board !== undefined) {
    heldBack.delete(role ?? "");
    const pending = pendingContact.get(role ?? "");
    pendingContact.delete(role ?? "");
    if (pending !== undefined) radio.paired(...pending);
    say(
      `${role ?? "?"}: ${pending === undefined ? "nothing held back" : "first contact released"}`,
    );
  }
  // No board's pairing window is open until its button is held: 5000 ms opens it, 15000 resets.
  else if (command === "hold")
    say(`${role ?? "?"}: ${board?.holdButton(holdMs(length)) ?? "no such board"}`);
  else if (command === "on") board?.powerOn();
  else if (command === "off") board?.powerOff();
  else if (command === "state")
    for (const [name, value] of boards)
      say(`${name}: ${value.window}, ${value.wrongCodes} wrong tries`);
}
await stop();
