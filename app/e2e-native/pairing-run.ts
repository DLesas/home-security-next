/** Simulator P4 fixture: a real hub with a surveyed site, and real-handshake boards on a private loopback bridge. */
import { spawnSync } from "node:child_process";
import { z } from "../../packages/protocol/node_modules/zod";
import { Role } from "../../packages/protocol/src/messages/common";
import { fromHex } from "../../packages/protocol/src/bytes";
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
            radio.paired(pairing, board);
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
            radio.paired(pairing, board);
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
for (const [role, board] of boards) say(`${role} test display: ${board.shownCode}`);

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
  else if (command === "plan") await radio.plan();
  else if (command === "wake") radio.wake();
  else if (command === "slow") air.faults = { latencyMs: 20, boardDelayMs: 20 };
  else if (command === "drop")
    air.faults = { latencyMs: 20, dropAfter: nthFrame(TransferKind.Data, 30) };
  else if (command === "normal") air.faults = {};
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
