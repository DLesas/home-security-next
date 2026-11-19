/**
 * The scripted board's update service against the firmware's real one, exchange by exchange.
 *
 * `fixtures/firmware-transcripts.json` was made on the firmware's own host bench by
 * `firmware-transcript/transcript.cpp`: a real sensor (roles/sensor's `SensorRole` with the core's
 * `UpdateService`, firmware/core/src/device/update*.cpp) offered a Bluetooth update by the test
 * hub and served by the bench's `ScriptPhone`, in five scenarios. It holds every frame the board
 * sent over Bluetooth, in order, and the inputs that made them: the file (its header signed by the
 * hub's key), the device key and the nonce the session key derives from, the address, the window,
 * the hub's public signing key and identity; the device randoms are inside its Hellos.
 *
 * Here the TypeScript board runs on exactly those inputs, its random numbers being the firmware's
 * Hellos' randoms in order, against `src/script-phone.ts` (the firmware's `ScriptPhone`, same
 * options, same 15 ms each way), and every frame it sends must equal the firmware's byte for byte,
 * as must what it reports over LoRa at the end. The session key the board derives must be the one
 * the C++ hub derived. A frame that differs, one too many or one missing fails the scenario.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "../../../packages/protocol/src/bytes.ts";
import { UpdateReason, UpdateStage } from "../../../packages/protocol/src/messages/update.ts";
import { bluetoothSessionKey } from "../../../packages/protocol/src/update/bluetooth.ts";
import {
  decodeTransferFrame,
  TransferKind,
} from "../../../packages/protocol/src/update/transfer.ts";
import { BleAir } from "../src/air/air.ts";
import { ScriptedCentral } from "../src/air/central.ts";
import { nthFrame } from "../src/air/faults.ts";
import { ScriptedBoard } from "../src/boards/board.ts";
import { ManualClock } from "../src/clock.ts";
import type { PairingCodeText } from "../../../packages/protocol/src/pairing/types.ts";
import { Role, testPairing } from "./support/images.ts";
import { ScriptPhone } from "../src/script-phone.ts";

interface Transcript {
  readonly name: string;
  readonly phone: {
    readonly mtu: number;
    readonly wrongTags: number;
    readonly dropAfterData: number;
    readonly reconnectAfterMs: number;
    readonly corruptData: number;
  };
  readonly address: number;
  readonly deviceKey: string;
  readonly nonce: string;
  readonly sessionKey: string;
  readonly windowUnits: number;
  readonly imageId: string;
  readonly signingKey: string;
  readonly hubIdentity: string;
  readonly file: string;
  readonly fromBoard: readonly string[];
  readonly result: {
    readonly done: number | null;
    readonly doneReason: number | null;
    readonly hellos: number;
    readonly opens: number;
    readonly wrongOpens: number;
    readonly connections: number;
    readonly dataFrames: number;
    readonly servedTo: number;
  };
}

const file = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "firmware-transcripts.json"), "utf8"),
) as { readonly scenarios: readonly Transcript[] };

/** The device randoms of the firmware's Hellos, in order. */
function hellosRandoms(frames: readonly string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const frame of frames) {
    const decoded = decodeTransferFrame(fromHex(frame));
    if (decoded.ok && decoded.value.kind === TransferKind.Hello)
      out.push(decoded.value.deviceRandom);
  }
  return out;
}

async function runTypeScriptBoard(t: Transcript) {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 5 });
  air.faults = {
    latencyMs: 15,
    ...(t.phone.dropAfterData > 0
      ? { dropAfter: nthFrame(TransferKind.Data, t.phone.dropAfterData) }
      : {}),
  };
  const randoms = hellosRandoms(t.fromBoard);
  let drawn = 0;
  const pairing = testPairing({
    address: t.address,
    key: fromHex(t.deviceKey),
    hubIdentity: fromHex(t.hubIdentity),
    firmwareSigningKey: fromHex(t.signingKey),
  });
  const board = new ScriptedBoard(clock, {
    role: Role.Sensor,
    chipId: Uint8Array.of(1, 2, 3, 4, 5, 6),
    code: "0000000Y" as PairingCodeText,
    pairing,
    random: (bytes) => (randoms[drawn++] ?? new Uint8Array(bytes)).slice(0, bytes),
  });
  air.add(board);
  board.powerOn();
  const sent: string[] = [];
  air.sniff((_, crossing) => {
    if (crossing.direction === "toPhone" && crossing.kind === "notify")
      sent.push(toHex(crossing.data));
  });
  const key = bluetoothSessionKey(pairing.key, fromHex(t.nonce), t.address);
  const phone = new ScriptPhone(
    new ScriptedCentral(air),
    clock,
    {
      address: t.address,
      sessionKey: key.ok ? key.value : new Uint8Array(32),
      imageId: fromHex(t.imageId),
      file: fromHex(t.file),
    },
    t.phone,
  );
  board.offerUpdate({
    imageId: fromHex(t.imageId),
    nonce: fromHex(t.nonce),
    windowUnits: t.windowUnits,
  });
  phone.start();
  await clock.runUntil(() => board.update?.session === "closed", 180_000);
  // What was on its way (the Done) arrives.
  await clock.advance(1000);
  phone.stop();
  return { board, phone, sent, key, drawn, randoms };
}

describe("the scripted board's update service, frame for frame against the firmware's", () => {
  test("the fixture holds the five scenarios", () => {
    expect(file.scenarios.map((s) => s.name)).toEqual([
      "a whole transfer",
      "two wrong tags, then the right one",
      "a drop after 30 Data, and the resume",
      "the 5th Data corrupted",
      "five wrong tags",
    ]);
  });

  for (const t of file.scenarios) {
    test(t.name, async () => {
      const run = await runTypeScriptBoard(t);
      // The same key: the board's derivation from the device key and nonce is the hub's.
      expect(run.key.ok && toHex(run.key.value)).toBe(t.sessionKey);
      // Every frame the firmware sent, in order, and nothing else.
      expect(run.sent).toEqual([...t.fromBoard]);
      // Each of the firmware's randoms was drawn once, for one Hello each.
      expect(run.drawn).toBe(run.randoms.length);
      // The phone saw what the firmware's phone saw.
      expect({
        done: run.phone.done?.result ?? null,
        doneReason: run.phone.done?.reason ?? null,
        hellos: run.phone.hellos.length,
        opens: run.phone.opens,
        wrongOpens: run.phone.wrongOpens,
        connections: run.phone.connections,
        dataFrames: run.phone.dataFrames,
        servedTo: run.phone.servedTo,
      }).toEqual(t.result);
      // And the board's last word for LoRa.
      const last = run.board.statuses.at(-1);
      if (t.result.done === 0) {
        expect(last?.stage).toBe(UpdateStage.Verified);
        expect(last?.bytesWritten).toBe(fromHex(t.file).length);
      } else {
        expect(last?.stage).toBe(UpdateStage.Refused);
        expect(last?.reason).toBe(UpdateReason.SessionRefused);
      }
    });
  }
});
