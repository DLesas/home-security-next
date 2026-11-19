/** Replays the actual ESP-IDF peripheral scripts through the bench's GATT interface. */
import { expect, test } from "bun:test";
import { fromHex, toHex } from "../../../packages/protocol/src/bytes.ts";
import { readPairingCode } from "../../../packages/protocol/src/pairing/code.ts";
import { setupSessionOpener } from "../../../packages/protocol/src/pairing/setup-session.ts";
import { espIdfVectors } from "../../../packages/protocol/src/pairing/vectors/esp-idf-vectors.ts";
import { BleAir } from "../src/air/air.ts";
import { ScriptedCentral } from "../src/air/central.ts";
import { placeBoard, ScriptedBoard } from "../src/boards/board.ts";
import { PAIRING_UUIDS } from "../src/boards/protocomm.ts";
import { security2Server } from "../src/boards/security2-server.ts";
import { ManualClock } from "../src/clock.ts";
import { Role } from "./support/images.ts";
import { settled } from "./support/raw-phone.ts";

const { script, srp } = espIdfVectors();
const endpoints = {
  "proto-ver": PAIRING_UUIDS.protoVersion,
  "prov-session": PAIRING_UUIDS.session,
  "hsn-setup": PAIRING_UUIDS.setup,
} as const;

for (const fixture of script.cases) {
  test(fixture.name, async () => {
    const credentials = srp.cases.find((value) => value.name === fixture.srpCase);
    const code = readPairingCode(credentials?.password ?? "");
    expect(code !== undefined && credentials !== undefined).toBe(true);
    if (code === undefined || credentials === undefined) return;
    const draws = fixture.boardDraws.map(fromHex);
    const drawn: number[] = [];
    const observed: { securityEvent: string | null } = { securityEvent: null };
    let setupRequests = 0;
    const clock = new ManualClock();
    const air = new BleAir(clock);
    const board = placeBoard(
      air,
      new ScriptedBoard(
        clock,
        {
          role: Role.Siren,
          chipId: fromHex("62d78072c36b"),
          code,
          security: security2Server({
            credentials: {
              salt: fromHex(credentials.salt),
              verifier: fromHex(credentials.verifier),
            },
            draw: (size) => {
              drawn.push(size);
              return draws.shift();
            },
            event: (event) => {
              observed.securityEvent = event;
            },
          }),
        },
        {
          pairingSetup: () => {
            setupRequests += 1;
          },
        },
      ),
    );
    const connected = await settled(clock, new ScriptedCentral(air).connect(board.id, 23));
    expect(connected?.ok).toBe(true);
    if (!connected?.ok) return;
    const link = connected.value;
    for (const step of fixture.steps) {
      observed.securityEvent = null;
      const previousRequests = setupRequests;
      const uuid = endpoints[step.endpoint];
      const written = await settled(clock, link.write(uuid, fromHex(step.request), true));
      expect({ endpoint: step.endpoint, written: written?.ok, ...observed }).toEqual({
        endpoint: step.endpoint,
        written: step.answer !== null,
        securityEvent: step.event,
      });
      if (step.answer !== null) {
        const answer = await settled(clock, link.read(uuid));
        expect(answer?.ok === true && toHex(answer.value) === step.answer).toBe(true);
      }
      expect(setupRequests - previousRequests).toBe(Number(step.setupHandlerRan));
    }
    expect(drawn).toEqual(fixture.boardDraws.map((draw) => draw.length / 2));
    expect(board.wrongCodes).toBe(
      fixture.steps.filter((step) => step.event === "credentialsMismatch").length,
    );
    link.close();
  });
}

test("a scripted board uses the real handshake by default", async () => {
  const clock = new ManualClock();
  const air = new BleAir(clock);
  const board = placeBoard(
    air,
    new ScriptedBoard(clock, { role: Role.Sensor, chipId: fromHex("010203040506") }),
  );
  const connected = await settled(clock, new ScriptedCentral(air).connect(board.id, 23));
  expect(connected?.ok).toBe(true);
  if (!connected?.ok) return;
  const open = setupSessionOpener({
    clock: {
      now: () => clock.now(),
      sleep: (ms) =>
        new Promise((resolve) => {
          clock.after(ms, resolve);
        }),
    },
  });
  const result = await settled(clock, open(connected.value, board.code));
  expect(result?.ok).toBe(true);
  if (result?.ok) result.value.close();
});
