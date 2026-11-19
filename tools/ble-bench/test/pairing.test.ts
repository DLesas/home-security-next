/**
 * The scripted board's pairing side (m3-design.md section 5; protocol.md section 10, "Pairing over
 * Bluetooth" and "Who accepts what"): the window and its advertising, protocomm's GATT layout and
 * framing, the security layer behind the bench's interface (the stand-in here, until P3's security
 * 2 is joined), the code and its five-tries rule, the setup messages over Bluetooth, the Wi-Fi
 * details, the result and the restart, and the faults of a pairing.
 */
import { describe, expect, test } from "bun:test";
import {
  formatPairingCode,
  makePairingCode,
  readPairAdvert,
  readPairingCode,
} from "../../../packages/protocol/src/pairing/code.ts";
import { PAIRING_CODE, PROTOCOMM } from "../../../packages/protocol/src/pairing/constants.ts";
import type { PairingCodeText } from "../../../packages/protocol/src/pairing/types.ts";
import { encodePairingData, type PairingData } from "../../../packages/protocol/src/pairing.ts";
import {
  decodeSetupMessage,
  encodeSetupMessage,
  ProvisionResultCode,
  SetupType,
} from "../../../packages/protocol/src/usb/setup.ts";
import { BLUETOOTH_UPDATE } from "../../../packages/protocol/src/update/bluetooth.ts";
import type { GattLink, SetupSession } from "../../../app/src/platform/ble.ts";
import { BleAir } from "../src/air/air.ts";
import { ScriptedCentral } from "../src/air/central.ts";
import {
  type BoardOptions,
  PAIRING_HOLD_MS,
  RESET_HOLD_MS,
  ScriptedBoard,
} from "../src/boards/board.ts";
import { standInSecurity, unjoinedSecurity } from "../src/boards/pairing-security.ts";
import { endpointUuid, PAIRING_UUIDS } from "../src/boards/protocomm.ts";
import { answerSetup } from "../src/boards/setup.ts";
import { ManualClock } from "../src/clock.ts";
import { openStandInSession, readPairVersion } from "../src/stand-in-client.ts";
import { Role, testPairing } from "./support/images.ts";
import { settled } from "./support/raw-phone.ts";
import { countingRandom } from "./support/world.ts";

/** A code as a board makes it, and another that is a code too (its check character fits). */
const CODE = makePairingCode(0x3_1415_9265n) ?? ("" as PairingCodeText);
const WRONG = makePairingCode(0x3_1415_9266n) ?? ("" as PairingCodeText);
const CHIP = Uint8Array.of(0x3c, 0x84, 0x27, 0xe2, 0x4f, 0x2a);

/**
 * A board on the air, powered on; an unpaired one is then held for 5 seconds, as the person does
 * before the phone searches, unless `hold` is false.
 */
function pairingWorld(
  board: Partial<BoardOptions> = {},
  provisioned: PairingData[] = [],
  hold = true,
) {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 10, connectTimeoutMs: 3000 });
  const made = new ScriptedBoard(
    clock,
    {
      role: Role.Siren,
      chipId: CHIP,
      code: CODE,
      security: standInSecurity,
      random: countingRandom(),
      ...board,
    },
    {
      provisioned: (pairing) => {
        provisioned.push(pairing);
      },
    },
  );
  air.add(made);
  made.powerOn();
  if (hold && made.pairing === undefined) made.holdButton(PAIRING_HOLD_MS);
  const central = new ScriptedCentral(air);
  return { clock, air, board: made, central, provisioned };
}

async function connect(
  world: ReturnType<typeof pairingWorld>,
  central = world.central,
): Promise<GattLink | undefined> {
  const connected = await settled(world.clock, central.connect(world.board.id, 517));
  return connected?.ok === true ? connected.value : undefined;
}

async function session(world: ReturnType<typeof pairingWorld>, code = CODE) {
  const link = await connect(world);
  if (link === undefined) return undefined;
  const opened = (await settled(world.clock, openStandInSession(link, code))) ?? {
    ok: false as const,
    fault: "timeout" as const,
  };
  return { link, opened };
}

async function exchange(
  world: ReturnType<typeof pairingWorld>,
  s: SetupSession,
  message: Uint8Array,
) {
  return settled(world.clock, s.exchange(message));
}

const identify = encodeSetupMessage({ type: SetupType.Identify });
function provision(pairing: PairingData): Uint8Array {
  return encodeSetupMessage({ type: SetupType.Provision, pairing });
}

describe("the pairing window and its advertising", () => {
  test("an unpaired board opens no pairing window at power-up or on a short press: only the five-second hold opens it", () => {
    const { board, clock } = pairingWorld({}, [], false);
    expect(board.window).toBe("closed");
    expect(board.advertising()).toBeNull();
    expect(board.holdButton(PAIRING_HOLD_MS - 1)).toBe("nothing");
    expect(board.window).toBe("closed");
    expect(board.holdButton(PAIRING_HOLD_MS)).toBe("pairing");
    expect(board.window).toBe("pairing");
    // The window's two minutes are counted from the hold.
    expect(clock.now()).toBe(0);
  });

  test("a board powered off is held in vain", () => {
    const { board } = pairingWorld({}, [], false);
    board.powerOff();
    expect(board.holdButton(PAIRING_HOLD_MS)).toBe("nothing");
    board.powerOn();
    expect(board.window).toBe("closed");
  });

  test("held through 15 seconds the board closes its window and resets: no pairing, a new code, nothing open", () => {
    const world = pairingWorld();
    const before = world.board.code;
    expect(world.board.window).toBe("pairing");
    expect(world.board.holdButton(RESET_HOLD_MS - 1)).toBe("pairing");
    expect(world.board.holdButton(RESET_HOLD_MS)).toBe("reset");
    expect(world.board.window).toBe("closed");
    expect(world.board.resets).toBe(1);
    expect(world.board.code).not.toBe(before);
    expect(readPairingCode(world.board.code)).toBe(world.board.code);
    const paired = pairingWorld({ pairing: testPairing() });
    expect(paired.board.holdButton(RESET_HOLD_MS)).toBe("reset");
    expect(paired.board.pairing).toBeUndefined();
    expect(paired.board.update).toBeUndefined();
    expect(paired.board.window).toBe("closed");
    expect(paired.board.holdButton(PAIRING_HOLD_MS)).toBe("pairing");
  });

  test("after the five-second hold: protocomm's service, no service data, hsn-pair-<4 hex>", () => {
    const { board } = pairingWorld();
    const advert = board.advertising();
    expect(advert?.serviceUuids).toEqual([PROTOCOMM.serviceUuid]);
    expect(advert?.serviceUuids).not.toContain(BLUETOOTH_UPDATE.serviceUuid);
    expect(advert?.localName).toBe("hsn-pair-4f2a");
    expect(advert?.serviceData).toEqual([]);
    expect(readPairAdvert(advert?.localName ?? null)).toEqual({ chipSuffix: "4f2a" });
    expect(board.window).toBe("pairing");
    expect(board.label).toBe("Siren 4F2A");
    expect(readPairingCode(CODE)).toBe(CODE);
    expect(board.shownCode).toBe(formatPairingCode(CODE));
    expect(board.qr).toBe(`hsn://pair/1?c=${encodeURIComponent(CODE)}&d=3c8427e24f2a`);
  });

  test("a scan by protocomm's service finds it, without service data; by the update service, not", async () => {
    const world = pairingWorld();
    const seen: string[] = [];
    const notSeen: string[] = [];
    const stop = world.central.scan(PROTOCOMM.serviceUuid, (a) => seen.push(a.name ?? ""));
    const stop2 = world.central.scan(BLUETOOTH_UPDATE.serviceUuid, (a) =>
      notSeen.push(a.name ?? ""),
    );
    await world.clock.advance(25);
    stop();
    stop2();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set(["hsn-pair-4f2a"]));
    expect(notSeen).toEqual([]);
  });

  test("it closes at 2 minutes exactly", async () => {
    const { board, clock } = pairingWorld();
    await clock.advance(PAIRING_CODE.windowMs - 1);
    expect(board.window).toBe("pairing");
    await clock.advance(1);
    expect(board.window).toBe("closed");
    expect(board.advertising()).toBeNull();
  });

  test("it stays open while a phone is connected, and closes when the phone goes", async () => {
    const world = pairingWorld();
    const link = await connect(world);
    await world.clock.advance(PAIRING_CODE.windowMs + 60_000);
    expect(world.board.window).toBe("pairing");
    link?.close();
    await world.clock.advance(1);
    expect(world.board.window).toBe("closed");
  });

  test("a hold opens it again after it ended; a paired board opens none, its hold ignored and counted", async () => {
    const world = pairingWorld();
    await world.clock.advance(PAIRING_CODE.windowMs);
    expect(world.board.window).toBe("closed");
    expect(world.board.holdButton(PAIRING_HOLD_MS)).toBe("pairing");
    expect(world.board.window).toBe("pairing");
    const paired = pairingWorld({ pairing: testPairing() });
    expect(paired.board.window).toBe("closed");
    expect(paired.board.holdButton(PAIRING_HOLD_MS)).toBe("ignored");
    expect(paired.board.window).toBe("closed");
    expect(paired.board.ignoredPresses).toBe(1);
    expect(paired.board.advertising()).toBeNull();
  });

  test("while connected the board does not advertise; a second phone's connect times out", async () => {
    const world = pairingWorld();
    await connect(world);
    expect(world.board.advertising()).toBeNull();
    const second = new ScriptedCentral(world.air);
    const attempt = await settled(world.clock, second.connect(world.board.id, 517));
    expect(attempt).toEqual({ ok: false, fault: "timeout" });
  });
});

describe("protocomm's layout and framing", () => {
  test("each endpoint's UUID is the service's with bytes 12 and 13 of its little-endian array replaced", () => {
    // Worked independently of endpointUuid: the 16 bytes, reversed, patched, reversed back.
    const derive = (uuid16: number): string => {
      const bytes =
        PROTOCOMM.serviceUuid
          .replace(/-/gu, "")
          .match(/../gu)
          ?.map((h) => Number.parseInt(h, 16)) ?? [];
      const little = bytes.toReversed();
      little[12] = uuid16 & 0xff;
      little[13] = uuid16 >> 8;
      const hex = little
        .toReversed()
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    expect(PAIRING_UUIDS.protoVersion).toBe(derive(0xff53));
    expect(PAIRING_UUIDS.session).toBe(derive(0xff51));
    expect(PAIRING_UUIDS.setup).toBe(derive(0xff60));
    expect(PAIRING_UUIDS.session).toBe("3b50ff51-5e8a-4831-ba12-b8b12a8b0c8f");
    // ESP-IDF's own example service, as its docs give prov-session's characteristic.
    expect(endpointUuid("021a9004-0382-4aea-bff4-6b3f1c5adfb4", 0xff51)).toBe(
      "021aff51-0382-4aea-bff4-6b3f1c5adfb4",
    );
  });

  test("proto-ver answers the frozen PairVersion in the clear, whatever was written", async () => {
    const world = pairingWorld({ role: Role.Gateway, firmware: { major: 1, minor: 2, patch: 3 } });
    const link = await connect(world);
    if (link === undefined) return;
    const version = await settled(world.clock, readPairVersion(link));
    expect(version).toEqual({
      ok: true,
      value: {
        v: "hsn-pair/1",
        role: Role.Gateway,
        chip: "3c8427e24f2a",
        firmware: "1.2.3",
        sec: 2,
      },
    });
  });

  test("a read before any write is empty; an empty write is ignored; over 512 bytes is refused; answers clear at the disconnect", async () => {
    const world = pairingWorld();
    const link = await connect(world);
    if (link === undefined) return;
    expect(await settled(world.clock, link.read(PAIRING_UUIDS.protoVersion))).toEqual({
      ok: true,
      value: new Uint8Array(),
    });
    expect(
      await settled(world.clock, link.write(PAIRING_UUIDS.session, new Uint8Array(), true)),
    ).toEqual({ ok: true, value: undefined });
    expect(world.board.wrongCodes).toBe(0);
    expect(
      await settled(world.clock, link.write(PAIRING_UUIDS.setup, new Uint8Array(513), true)),
    ).toEqual({ ok: false, fault: "failed" });
    await settled(world.clock, link.write(PAIRING_UUIDS.protoVersion, Uint8Array.of(1), true));
    const kept = await settled(world.clock, link.read(PAIRING_UUIDS.protoVersion));
    expect(kept?.ok === true && kept.value.length > 0).toBe(true);
    link.close();
    await world.clock.advance(1);
    const again = await connect(world);
    if (again === undefined) return;
    expect(await settled(world.clock, again.read(PAIRING_UUIDS.protoVersion))).toEqual({
      ok: true,
      value: new Uint8Array(),
    });
  });

  test("before the session, hsn-setup refuses every write", async () => {
    const world = pairingWorld();
    const link = await connect(world);
    if (link === undefined) return;
    expect(await settled(world.clock, link.write(PAIRING_UUIDS.setup, identify, true))).toEqual({
      ok: false,
      fault: "failed",
    });
  });

  test("a board with no security joined refuses every handshake, and counts no wrong code", async () => {
    const world = pairingWorld({ security: unjoinedSecurity });
    const opened = await session(world);
    expect(opened?.opened).toEqual({ ok: false, fault: "wrongCode" });
    expect(world.board.wrongCodes).toBe(0);
    expect(world.board.window).toBe("pairing");
  });
});

describe("the code and its five tries", () => {
  test("a board makes its code from its random numbers, as a code the app reads", () => {
    const board = new ScriptedBoard(new ManualClock(), {
      role: Role.Sensor,
      chipId: CHIP,
      random: countingRandom(0x11),
    });
    expect(readPairingCode(board.code)).toBe(board.code);
    expect(board.code).toHaveLength(8);
  });

  test("the right code opens the session; a wrong one is refused and counted", async () => {
    const world = pairingWorld();
    const wrong = await session(world, WRONG);
    expect(wrong?.opened).toEqual({ ok: false, fault: "wrongCode" });
    expect(world.board.wrongCodes).toBe(1);
    wrong?.link.close();
    await world.clock.advance(1);
    const right = await session(world);
    expect(right?.opened.ok).toBe(true);
  });

  test("the fifth wrong code in one window: the board stops listening", async () => {
    const world = pairingWorld();
    for (let i = 1; i <= 5; i++) {
      const wrong = await session(world, WRONG);
      expect(wrong?.opened).toEqual({ ok: false, fault: "wrongCode" });
      await world.clock.advance(1);
      if (i < 5) {
        expect(world.board.window).toBe("pairing");
        wrong?.link.close();
        await world.clock.advance(1);
      }
    }
    expect(world.board.window).toBe("closed");
    expect(world.board.advertising()).toBeNull();
    // The hold opens a new window, with five tries again.
    world.board.holdButton(PAIRING_HOLD_MS);
    expect(world.board.wrongCodes).toBe(0);
    const right = await session(world);
    expect(right?.opened.ok).toBe(true);
  });

  test("four wrong, then right, in one connection's worth of tries", async () => {
    const world = pairingWorld();
    for (let i = 0; i < 4; i++) {
      const wrong = await session(world, WRONG);
      wrong?.link.close();
      await world.clock.advance(1);
    }
    const right = await session(world);
    expect(right?.opened.ok).toBe(true);
    expect(world.board.wrongCodes).toBe(4);
  });
});

describe("the setup messages over Bluetooth", () => {
  test("Identify: the board's Identity, a release build's", async () => {
    const world = pairingWorld();
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    const answer = await exchange(world, s.opened.value, identify);
    const decoded = answer?.ok === true ? decodeSetupMessage(answer.value) : undefined;
    expect(decoded?.ok === true && decoded.value).toEqual({
      type: SetupType.Identity,
      role: Role.Siren,
      chipId: CHIP,
      firmwareVersion: { major: 1, minor: 0, patch: 0 },
      paired: false,
      hubIdentity: new Uint8Array(8),
      developmentBuild: false,
    });
  });

  test("Provision: accepted, the result read, then the board restarts as its role with the pairing and its Wi-Fi bytes", async () => {
    const provisioned: PairingData[] = [];
    const world = pairingWorld({}, provisioned);
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    const closed: (string | null)[] = [];
    s.link.onClosed((why) => closed.push(why));
    const pairing = testPairing({
      wifiName: Uint8Array.of(0xe2, 0x98, 0x83),
      wifiPassword: Uint8Array.of(0, 1, 255),
    });
    const answer = await exchange(world, s.opened.value, provision(pairing));
    expect(answer).toEqual({
      ok: true,
      value: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.Accepted,
      }),
    });
    await world.clock.advance(10);
    expect(closed).toEqual(["lost"]);
    expect(world.board.window).toBe("closed");
    expect(world.board.restarts).toBe(1);
    expect(provisioned).toEqual([pairing]);
    expect(world.board.pairing?.wifiName).toEqual(Uint8Array.of(0xe2, 0x98, 0x83));
    expect(world.board.pairing?.wifiPassword).toEqual(Uint8Array.of(0, 1, 255));
    // Paired: the board opens no window again.
    expect(world.board.holdButton(PAIRING_HOLD_MS)).toBe("ignored");
    expect(world.board.window).toBe("closed");
  });

  test("a result never read: the board restarts after its bound all the same", async () => {
    const provisioned: PairingData[] = [];
    const world = pairingWorld({ restartMs: 1500 }, provisioned);
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    await settled(world.clock, s.link.write(PAIRING_UUIDS.setup, provision(testPairing()), true));
    await world.clock.advance(1400);
    expect(provisioned).toHaveLength(0);
    await world.clock.advance(200);
    expect(provisioned).toHaveLength(1);
  });

  test("a board that restarts before the result is read: the phone's read is lost", async () => {
    const world = pairingWorld({ restartBeforeResult: true });
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    const answer = await exchange(world, s.opened.value, provision(testPairing()));
    expect(answer).toEqual({ ok: false, fault: "lost" });
    expect(world.board.pairing).toBeDefined();
  });

  test("a Provision that does not decode is not valid; storage that fails is refused, the pairing gone", async () => {
    const world = pairingWorld();
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    const bad = encodeSetupMessage({ type: SetupType.Provision, pairing: testPairing() });
    bad[1 + 1] = 2; // the pairing data's format version
    expect(await exchange(world, s.opened.value, bad)).toEqual({
      ok: true,
      value: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.NotValid,
      }),
    });
    const zero = Uint8Array.of(0xf1, SetupType.Provision, ...encodePairingData(testPairing()));
    zero.set([0, 0, 0, 0], 3); // address 0
    expect(await exchange(world, s.opened.value, zero)).toEqual({
      ok: true,
      value: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.NotValid,
      }),
    });
    world.board.storageFails = true;
    expect(await exchange(world, s.opened.value, provision(testPairing({ address: 7 })))).toEqual({
      ok: true,
      value: encodeSetupMessage({
        type: SetupType.ProvisionResult,
        result: ProvisionResultCode.Refused,
      }),
    });
    expect(world.board.pairing).toBeUndefined();
  });

  test("Erase, Set role and anything not a setup message are refused over Bluetooth", async () => {
    const world = pairingWorld();
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    for (const message of [
      encodeSetupMessage({ type: SetupType.Erase }),
      encodeSetupMessage({ type: SetupType.SetRole, role: Role.Sensor }),
      Uint8Array.of(0x10, 0x01, 0x02),
    ]) {
      expect(await exchange(world, s.opened.value, message)).toEqual({
        ok: false,
        fault: "protocol",
      });
    }
    expect(world.board.role).toBe(Role.Siren);
  });

  test("in every build a paired board refuses Provision and keeps its pairing; an unpaired one takes it", () => {
    const holder = (pairing: PairingData | undefined) => ({
      role: Role.Sensor,
      chipId: CHIP,
      firmware: { major: 1, minor: 0, patch: 0 },
      pairing,
      store(next: PairingData) {
        this.pairing = next;
        return true;
      },
    });
    const kept = testPairing();
    const paired = holder(kept);
    const refused = answerSetup(paired, provision(testPairing({ address: 9 })));
    expect(refused.ok && refused.value.answer[2]).toBe(ProvisionResultCode.Refused);
    expect(refused.ok && refused.value.effect).toBe("none");
    expect(paired.pairing).toBe(kept);
    const taken = answerSetup(holder(undefined), provision(testPairing({ address: 9 })));
    expect(taken.ok && taken.value.effect).toBe("provisioned");
  });
});

describe("faults of a pairing", () => {
  test("a board that vanishes mid-pairing: the phone's next exchange is lost; powered again it opens a window only when held", async () => {
    const world = pairingWorld();
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    world.board.powerOff();
    expect(await exchange(world, s.opened.value, identify)).toEqual({ ok: false, fault: "lost" });
    expect(world.board.advertising()).toBeNull();
    world.board.powerOn();
    expect(world.board.window).toBe("closed");
    world.board.holdButton(PAIRING_HOLD_MS);
    expect(world.board.window).toBe("pairing");
  });

  test("a dropped connection mid-session: the next session starts from the handshake", async () => {
    const world = pairingWorld();
    world.air.faults = {
      dropAfter: (c) => c.characteristic === PAIRING_UUIDS.setup && c.kind === "write",
    };
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    expect(await exchange(world, s.opened.value, identify)).toEqual({ ok: false, fault: "lost" });
    world.air.faults = {};
    await world.clock.advance(1);
    const again = await session(world);
    expect(again?.opened.ok).toBe(true);
  });

  test("a slow board, and latency: the whole pairing still completes", async () => {
    const provisioned: PairingData[] = [];
    const world = pairingWorld({}, provisioned);
    world.air.faults = { latencyMs: 40, boardDelayMs: 300 };
    const s = await session(world);
    if (s?.opened.ok !== true) return;
    await exchange(world, s.opened.value, identify);
    await exchange(world, s.opened.value, provision(testPairing()));
    await world.clock.advance(2000);
    expect(provisioned).toHaveLength(1);
  });

  test("each role pairs: a sensor, a siren and a gateway", async () => {
    for (const role of [Role.Sensor, Role.Siren, Role.Gateway] as const) {
      const provisioned: PairingData[] = [];
      const world = pairingWorld({ role }, provisioned);
      const s = await session(world);
      if (s?.opened.ok !== true) return;
      await exchange(world, s.opened.value, provision(testPairing()));
      await world.clock.advance(10);
      expect(provisioned).toHaveLength(1);
      expect(world.board.update).toBeDefined();
    }
  });
});
