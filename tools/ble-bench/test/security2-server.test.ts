/** Replays the actual ESP-IDF peripheral scripts through the bench's GATT interface. */
import { expect, test } from "bun:test";
import { fromHex, toHex } from "../../../packages/protocol/src/bytes.ts";
import { makePairingCode, readPairingCode } from "../../../packages/protocol/src/pairing/code.ts";
import { pairingAttempts } from "../../../packages/protocol/src/pairing/setup-session.ts";
import { espIdfVectors } from "../../../packages/protocol/src/pairing/vectors/esp-idf-vectors.ts";
import {
  decodeSetupMessage,
  encodeSetupMessage,
  SetupType,
} from "../../../packages/protocol/src/usb/setup.ts";
import { openDeskSession } from "../pages/desk-security.ts";
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

test("the desk opener uses the real handshake and can Identify a scripted board", async () => {
  const clock = new ManualClock();
  const air = new BleAir(clock);
  const board = placeBoard(
    air,
    new ScriptedBoard(clock, { role: Role.Sensor, chipId: fromHex("010203040506") }),
  );
  const connected = await settled(clock, new ScriptedCentral(air).connect(board.id, 23));
  expect(connected?.ok).toBe(true);
  if (!connected?.ok) return;
  const result = await settled(
    clock,
    openDeskSession(connected.value, board.code, pairingAttempts()),
  );
  expect(result?.ok).toBe(true);
  if (!result?.ok) return;
  expect(result.value.version).toMatchObject({ chip: "010203040506", role: Role.Sensor, sec: 2 });
  const identity = await settled(
    clock,
    result.value.exchange(encodeSetupMessage({ type: SetupType.Identify })),
  );
  expect(identity?.ok && decodeSetupMessage(identity.value)).toMatchObject({
    ok: true,
    value: { type: SetupType.Identity, chipId: board.chipId, role: Role.Sensor, paired: false },
  });
  result.value.close();
});

test("the desk opener closes a refused link and reports when five wrong codes stop setup", async () => {
  const code = makePairingCode(42n);
  const wrong = makePairingCode(43n);
  expect(code !== undefined && wrong !== undefined).toBe(true);
  if (code === undefined || wrong === undefined) return;
  const clock = new ManualClock();
  const air = new BleAir(clock);
  const board = placeBoard(
    air,
    new ScriptedBoard(clock, { role: Role.Sensor, chipId: fromHex("010203040506"), code }),
  );
  const central = new ScriptedCentral(air);
  const attempts = pairingAttempts();
  for (const fault of [
    "wrongCode",
    "wrongCode",
    "wrongCode",
    "wrongCode",
    "tooManyTries",
  ] as const) {
    const connected = await settled(clock, central.connect(board.id, 23));
    expect(connected?.ok).toBe(true);
    if (!connected?.ok) return;
    const link = connected.value;
    const closed = new Promise((resolve) => {
      link.onClosed(resolve);
    });
    expect(await settled(clock, openDeskSession(link, wrong, attempts))).toEqual({
      ok: false,
      fault,
    });
    expect(await settled(clock, closed)).toBe(fault === "tooManyTries" ? "lost" : null);
  }
  expect(board.wrongCodes).toBe(5);
  expect(board.window).toBe("closed");
});
