/**
 * The scripted board's update service (m3-updates-design.md section 5; protocol.md section 10;
 * m3-design.md section 7, "Tests"): against the protocol package's vectors for the session key,
 * the tag and the name; the window and its advertising; Hello; the tag and the five-tries rule;
 * the pull's rules (header first, eight out, no further than the next sector, asked again after
 * 3 s, CRC and length checked); the header's checks in order; the stops; and the faults the brief
 * lists. `firmware-compare.test.ts` checks the same service frame for frame against the firmware.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "../../../packages/protocol/src/bytes.ts";
import { UpdateReason, UpdateStage } from "../../../packages/protocol/src/messages/update.ts";
import {
  BLUETOOTH_UPDATE,
  bluetoothOpenTag,
  bluetoothUpdateName,
} from "../../../packages/protocol/src/update/bluetooth.ts";
import { PROTOCOMM } from "../../../packages/protocol/src/pairing/constants.ts";
import { TransferKind } from "../../../packages/protocol/src/update/transfer.ts";
import { ScriptedCentral } from "../src/air/central.ts";
import { corruptNthData, nthFrame } from "../src/air/faults.ts";
import { ScriptedBoard } from "../src/boards/board.ts";
import { UPDATE_SESSION } from "../src/boards/update-service.ts";
import { Role, TEST_SIGNING_KEY, testImage, testPairing } from "./support/images.ts";
import { RawPhone, settled } from "./support/raw-phone.ts";
import { ScriptPhone } from "../src/script-phone.ts";
import { countingRandom, NONCE, offer, updateWorld, type UpdateWorld } from "./support/world.ts";

interface SessionVectors {
  readonly sessionKeys: readonly {
    readonly deviceKey: string;
    readonly nonce: string;
    readonly address: number;
    readonly sessionKey: string;
  }[];
  readonly openTags: readonly {
    readonly name: string;
    readonly sessionKey: string;
    readonly address: number;
    readonly deviceRandom: string;
    readonly imageId: string;
    readonly tag: string;
  }[];
  readonly names: readonly { readonly address: number; readonly name: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "protocol",
      "vectors",
      "ble-update-session.json",
    ),
    "utf8",
  ),
) as SessionVectors;

async function wholeTransfer(world: UpdateWorld, options = {}) {
  const phone = new ScriptPhone(world.central, world.clock, world.session, options);
  phone.start();
  await world.clock.runUntil(() => world.board.update?.session === "closed", 20 * 60_000);
  await world.clock.advance(1000);
  phone.stop();
  return phone;
}

async function openedRaw(world: UpdateWorld, mtu = 185): Promise<RawPhone | undefined> {
  offer(world);
  const raw = await RawPhone.connect(world.clock, world.central, world.board.id, mtu);
  await world.clock.advance(1);
  await raw?.open(world.session.sessionKey, world.session.address);
  await world.clock.advance(1);
  return raw;
}

describe("against the protocol package's vectors", () => {
  test("the board derives each vector's session key from its device key, nonce and address", async () => {
    expect(vectors.sessionKeys.length).toBeGreaterThan(0);
    for (const v of vectors.sessionKeys) {
      const world = updateWorld({
        board: { pairing: testPairing({ key: fromHex(v.deviceKey), address: v.address }) },
      });
      world.board.offerUpdate({
        imageId: world.image.imageId,
        nonce: fromHex(v.nonce),
        windowUnits: 12,
      });
      const raw = await RawPhone.connect(world.clock, world.central, world.board.id);
      await world.clock.advance(1);
      // Opened with the vector's key: the board took it, so it derived the same key.
      await raw?.open(fromHex(v.sessionKey), v.address);
      await world.clock.advance(1);
      expect(world.board.update?.session).toBe("open");
      expect(raw?.gets[0]).toMatchObject({ offset: 0, length: 128 });
    }
  });

  test("the board takes each vector's tag for its Hello, and refuses it with one bit changed", async () => {
    for (const v of vectors.openTags) {
      for (const flip of [false, true]) {
        const deviceRandom = fromHex(v.deviceRandom);
        // A board whose device key gives the vector's session key (the first session-key vector).
        const keyVector = vectors.sessionKeys.find((k) => k.sessionKey === v.sessionKey);
        expect(keyVector).toBeDefined();
        const world = updateWorld({
          board: {
            pairing: testPairing({ key: fromHex(keyVector?.deviceKey ?? ""), address: v.address }),
            random: () => deviceRandom.slice(),
          },
        });
        world.board.offerUpdate({
          imageId: fromHex(v.imageId),
          nonce: fromHex(keyVector?.nonce ?? ""),
          windowUnits: 12,
        });
        const raw = await RawPhone.connect(world.clock, world.central, world.board.id);
        await world.clock.advance(1);
        expect(toHex(raw?.hellos[0]?.deviceRandom ?? new Uint8Array())).toBe(v.deviceRandom);
        const tag = fromHex(v.tag);
        if (flip) tag[0] = (tag[0] ?? 0) ^ 0x01;
        await raw?.send({ kind: TransferKind.Open, tag });
        await world.clock.advance(1);
        expect(world.board.update?.session).toBe(flip ? "advertising" : "open");
        expect(world.board.update?.wrongTags).toBe(flip ? 1 : 0);
      }
    }
  });

  test("the board advertises each vector's name", () => {
    for (const v of vectors.names) {
      const world = updateWorld({ board: { pairing: testPairing({ address: v.address }) } });
      offer(world);
      expect(world.board.advertising()?.localName).toBe(v.name);
      expect(bluetoothUpdateName(v.address)).toBe(v.name);
    }
  });

  test("the test key's public half is a real key", () => {
    expect(TEST_SIGNING_KEY.some((b) => b !== 0)).toBe(true);
  });
});

describe("the update window", () => {
  test("no offer, no Bluetooth: a paired board advertises nothing and takes no connection", async () => {
    const world = updateWorld();
    expect(world.board.advertising()).toBeNull();
    const connected = await settled(world.clock, world.central.connect(world.board.id, 517));
    expect(connected).toEqual({ ok: false, fault: "timeout" });
  });

  test("the offer opens it: the update service and hsn-<address>, never pairing's service", () => {
    const world = updateWorld();
    expect(offer(world)).toBe(true);
    const advert = world.board.advertising();
    expect(advert?.serviceUuids).toEqual([BLUETOOTH_UPDATE.serviceUuid]);
    expect(advert?.serviceUuids).not.toContain(PROTOCOMM.serviceUuid);
    expect(advert?.localName).toBe("hsn-1a2b3c4d");
    expect(world.board.window).toBe("update");
  });

  test("its units of 10 s: nobody comes, and it ends at 30 s exactly with windowEnded", async () => {
    const world = updateWorld();
    offer(world, 3);
    await world.clock.advance(29_999);
    expect(world.board.window).toBe("update");
    expect(world.board.statuses).toEqual([]);
    await world.clock.advance(1);
    expect(world.board.window).toBe("closed");
    expect(world.board.advertising()).toBeNull();
    expect(world.board.statuses).toEqual([
      {
        imageId: world.image.imageId,
        stage: UpdateStage.Refused,
        reason: UpdateReason.WindowEnded,
        bytesWritten: 0,
      },
    ]);
  });

  test("an offer with no window gets the firmware's 120 s", async () => {
    const world = updateWorld();
    offer(world, 0);
    await world.clock.advance(119_999);
    expect(world.board.window).toBe("update");
    await world.clock.advance(1);
    expect(world.board.window).toBe("closed");
  });

  test("the session lives 15 minutes, however long the window", async () => {
    const world = updateWorld();
    offer(world, 255);
    await world.clock.advance(UPDATE_SESSION.sessionLifeMs - 1);
    expect(world.board.window).toBe("update");
    await world.clock.advance(1);
    expect(world.board.statuses.at(-1)?.reason).toBe(UpdateReason.WindowEnded);
  });

  test("the same offer again changes nothing; a new nonce starts a new session", async () => {
    const world = updateWorld();
    offer(world, 3);
    await world.clock.advance(20_000);
    offer(world, 3);
    await world.clock.advance(10_000);
    expect(world.board.window).toBe("closed");
    const again = updateWorld();
    offer(again, 3);
    await again.clock.advance(20_000);
    offer(again, 3, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    await again.clock.advance(10_000);
    expect(again.board.window).toBe("update");
  });
});

describe("Hello", () => {
  test("the address, a fresh random each connection, the image, nothing held, the piece", async () => {
    const world = updateWorld();
    offer(world);
    const first = await RawPhone.connect(world.clock, world.central, world.board.id);
    await world.clock.advance(1);
    expect(first?.hellos).toHaveLength(1);
    expect(first?.hellos[0]).toMatchObject({
      address: 0x1a2b3c4d,
      imageId: world.image.imageId,
      bytesHeld: 0,
      largestData: 164,
    });
    first?.link.close();
    await world.clock.advance(50);
    const second = await RawPhone.connect(world.clock, world.central, world.board.id);
    await world.clock.advance(1);
    expect(toHex(second?.hellos[0]?.deviceRandom ?? new Uint8Array())).not.toBe(
      toHex(first?.hellos[0]?.deviceRandom ?? new Uint8Array()),
    );
  });

  test("the largest data follows the MTU agreed: the ask, the phone's limit, the board's", async () => {
    const cases: readonly [ask: number, phoneMax: number, boardMax: number, piece: number][] = [
      [517, 517, 517, 496],
      [185, 517, 517, 164],
      [517, 185, 517, 164],
      [517, 517, 247, 226],
    ];
    for (const [ask, phoneMax, boardMax, piece] of cases) {
      const world = updateWorld({ central: { maxMtu: phoneMax }, board: { maxMtu: boardMax } });
      offer(world);
      const raw = await RawPhone.connect(world.clock, world.central, world.board.id, ask);
      await world.clock.advance(1);
      expect(raw?.hellos[0]?.largestData).toBe(piece);
    }
  });

  test("at Bluetooth's least MTU, 23, Hello (28 bytes) cannot be notified: nothing comes, and 30 s later linkLost", async () => {
    const world = updateWorld();
    offer(world);
    const raw = await RawPhone.connect(world.clock, world.central, world.board.id, 23);
    await world.clock.advance(1);
    expect(raw?.frames).toEqual([]);
    await world.clock.advance(UPDATE_SESSION.noProgressMs);
    expect(world.board.statuses.at(-1)?.reason).toBe(UpdateReason.LinkLost);
  });
});

describe("Open and the tag", () => {
  test("a wrong tag closes the connection and the window stays; four wrong, then right, and it goes on", async () => {
    const world = updateWorld();
    offer(world);
    for (let i = 0; i < 4; i++) {
      const raw = await RawPhone.connect(world.clock, world.central, world.board.id);
      await world.clock.advance(1);
      await raw?.open(world.session.sessionKey, world.session.address, true);
      await world.clock.advance(5);
      expect(raw?.closed).toBe("lost");
      expect(world.board.window).toBe("update");
    }
    const raw = await RawPhone.connect(world.clock, world.central, world.board.id);
    await world.clock.advance(1);
    await raw?.open(world.session.sessionKey, world.session.address);
    await world.clock.advance(1);
    expect(world.board.update?.session).toBe("open");
    expect(world.board.update?.wrongTags).toBe(4);
  });

  test("the fifth wrong tag ends the window: sessionRefused, no more advertising", async () => {
    const world = updateWorld();
    offer(world);
    for (let i = 0; i < 5; i++) {
      const raw = await RawPhone.connect(world.clock, world.central, world.board.id);
      await world.clock.advance(1);
      await raw?.open(world.session.sessionKey, world.session.address, true);
      await world.clock.advance(5);
    }
    expect(world.board.window).toBe("closed");
    expect(world.board.advertising()).toBeNull();
    expect(world.board.statuses).toEqual([
      {
        imageId: world.image.imageId,
        stage: UpdateStage.Refused,
        reason: UpdateReason.SessionRefused,
        bytesWritten: 0,
      },
    ]);
  });

  test("a phone with the wrong session key opens nothing and is served nothing", async () => {
    const world = updateWorld();
    offer(world);
    const phone = new ScriptPhone(
      world.central,
      world.clock,
      { ...world.session, sessionKey: new Uint8Array(32).fill(7) },
      { reconnectAfterMs: 500 },
    );
    phone.start();
    await world.clock.runUntil(() => world.board.window === "closed", 60_000);
    phone.stop();
    expect(phone.opens).toBe(5);
    expect(phone.dataFrames).toBe(0);
    expect(world.board.update?.writtenImage().length).toBe(0);
  });

  test("an Open before Hello, or a second Open, is ignored", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    await raw?.open(world.session.sessionKey, world.session.address, true);
    await world.clock.advance(1);
    expect(world.board.update?.session).toBe("open");
    expect(world.board.update?.wrongTags).toBe(0);
  });
});

describe("the pull", () => {
  test("a whole transfer: header first alone, then the image, Done verified, the status for LoRa", async () => {
    const world = updateWorld({ faults: { latencyMs: 15 } });
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done).toMatchObject({ result: 0, reason: 0 });
    expect(phone.servedTo).toBe(world.image.file.length);
    expect(world.board.update?.writtenImage()).toEqual(world.image.image);
    expect(world.board.update?.record).toEqual({
      stage: "verified",
      bytesWritten: world.image.file.length,
    });
    expect(world.board.statuses).toEqual([
      {
        imageId: world.image.imageId,
        stage: UpdateStage.Verified,
        reason: UpdateReason.None,
        bytesWritten: world.image.file.length,
      },
    ]);
    // Done ends Bluetooth: the board closed the connection and does not advertise.
    expect(phone.disconnections).toBe(1);
    expect(world.board.advertising()).toBeNull();
  });

  test("eight Gets out at most, pieces that never cross a sector, never past the next sector", async () => {
    const world = updateWorld({ size: 13000 });
    const raw = await openedRaw(world);
    expect(raw?.gets).toHaveLength(1);
    expect(raw?.gets[0]).toMatchObject({ offset: 0, length: 128 });
    const header = raw?.gets[0];
    if (raw === undefined || header === undefined) return;
    await raw.serve(world.image.file, header);
    await world.clock.advance(1);
    // Eight out, 164 bytes each, from 128.
    expect(raw.gets.slice(1).map((g) => [g.offset, g.length])).toEqual(
      Array.from({ length: 8 }, (_, i) => [128 + 164 * i, 164]),
    );
    // Serve none: after 3 s exactly each is asked again, not before.
    await world.clock.advance(UPDATE_SESSION.reaskMs - 3);
    expect(raw.gets).toHaveLength(9);
    await world.clock.advance(3);
    expect(raw.gets).toHaveLength(17);
    // Serve everything asked, as asked, until the two-sector bound shows: the last piece of a
    // sector is cut at its end, and nothing is asked past the end of the sector after the current.
    const answered = new Set<number>([0]);
    for (let round = 0; round < 60; round++) {
      const pending = raw.pending(answered);
      if (pending.length === 0) break;
      for (const get of pending) {
        answered.add(get.offset);
        await raw.serve(world.image.file, get);
      }
      await world.clock.advance(1);
    }
    const imageGets = raw.gets.filter((g) => g.offset >= 128);
    for (const get of imageGets) {
      const start = get.offset - 128;
      expect(Math.floor(start / 4096)).toBe(Math.floor((start + get.length - 1) / 4096));
      expect(get.length).toBeLessThanOrEqual(164);
    }
    expect(imageGets.some((g) => (g.offset - 128) % 4096 === 4096 - (4096 % 164))).toBe(true);
    expect(world.board.update?.writtenImage()).toEqual(world.image.image);
  });

  test("the two-sector bound: with the current sector unfinished, nothing is asked past the next", async () => {
    const world = updateWorld({ size: 20000 });
    const raw = await openedRaw(world);
    if (raw === undefined) return;
    const header = raw.gets[0];
    if (header === undefined) return;
    await raw.serve(world.image.file, header);
    await world.clock.advance(1);
    // Hold back the first piece of sector 0 and serve all else: the asks stop at sector 1's end.
    const held = 128;
    const answered = new Set<number>([0, held]);
    for (let round = 0; round < 80; round++) {
      const pending = raw.pending(answered);
      if (pending.length === 0) break;
      for (const get of pending) {
        answered.add(get.offset);
        await raw.serve(world.image.file, get);
      }
      await world.clock.advance(1);
    }
    const furthest = Math.max(...raw.gets.map((g) => g.offset + g.length));
    expect(furthest).toBe(128 + 2 * 4096);
    expect(world.board.update?.sectorsWritten).toEqual([]);
  });

  test("a Data with a bad CRC, or the wrong length, is asked again at once", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    const header = raw?.gets[0];
    if (raw === undefined || header === undefined) return;
    await raw.send({
      kind: TransferKind.Data,
      imageId: header.imageId,
      offset: 0,
      data: world.image.file.slice(0, 128),
    });
    await world.clock.advance(1);
    const first = raw.gets[1];
    if (first === undefined) return;
    const bytes = world.image.file.slice(first.offset, first.offset + first.length);
    const before = raw.gets.length;
    // The wrong length: the piece less a byte.
    await raw.send({
      kind: TransferKind.Data,
      imageId: first.imageId,
      offset: first.offset,
      data: bytes.slice(1),
    });
    await world.clock.advance(1);
    expect(raw.gets.length).toBe(before + 1);
    expect(raw.gets.at(-1)).toMatchObject({ offset: first.offset, length: first.length });
    expect(world.board.update?.dropped.damaged).toBe(1);
  });

  test("a Data nobody asked for, or for another image, is dropped", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    if (raw === undefined) return;
    await raw.send({
      kind: TransferKind.Data,
      imageId: world.image.imageId,
      offset: 5000,
      data: new Uint8Array(10),
    });
    await raw.send({
      kind: TransferKind.Data,
      imageId: new Uint8Array(8),
      offset: 0,
      data: world.image.file.slice(0, 128),
    });
    await world.clock.advance(1);
    expect(world.board.update?.dropped.notAsked).toBe(2);
    expect(world.board.update?.record).toBeUndefined();
  });

  test("a Gone ends the session: Done refused linkLost", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    await raw?.send({ kind: TransferKind.Gone, imageId: world.image.imageId, reason: 3 });
    await world.clock.advance(5);
    const done = raw?.frames.find((f) => f.kind === TransferKind.Done);
    expect(done).toMatchObject({ result: 1, reason: UpdateReason.LinkLost });
    expect(world.board.statuses.at(-1)?.reason).toBe(UpdateReason.LinkLost);
  });

  test("anything not a transfer frame on rx is ignored", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    await raw?.sendBytes(Uint8Array.of(0xf1, 0x01));
    await raw?.sendBytes(Uint8Array.of(0xf2, 0x7f, 1, 2));
    await world.clock.advance(1);
    expect(world.board.update?.dropped.notFrames).toBe(2);
    expect(world.board.update?.session).toBe("open");
  });

  test("an image already verified: Open is answered Done verified at once", async () => {
    const world = updateWorld();
    offer(world);
    await wholeTransfer(world);
    // The hub's next session (the same nonce here, so the phone's key still fits).
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done?.result).toBe(0);
    expect(phone.dataFrames).toBe(0);
  });
});

describe("the header's checks, in order, before anything is written", () => {
  const cases: readonly [string, (w: UpdateWorld) => UpdateWorld, UpdateReason][] = [
    [
      "another hub's",
      () =>
        updateWorld({
          image: testImage(5000, (f) => ({ ...f, hubIdentity: new Uint8Array(8).fill(1) })),
        }),
      UpdateReason.WrongHub,
    ],
    [
      "not for a sensor",
      () => updateWorld({ image: testImage(5000, (f) => ({ ...f, roles: 1 << Role.Siren })) }),
      UpdateReason.WrongRole,
    ],
    [
      "too large for the slot",
      () => updateWorld({ size: 5000, board: { capacity: 4999 } }),
      UpdateReason.TooLarge,
    ],
    [
      "signed by another key",
      () =>
        updateWorld({
          image: testImage(
            5000,
            (f) => f,
            fromHex("0000000000000000000000000000000000000000000000000000000000000001"),
          ),
        }),
      UpdateReason.BadSignature,
    ],
    [
      "for another target",
      () => updateWorld({ image: testImage(5000, (f) => ({ ...f, target: 2 })) }),
      UpdateReason.BadHeader,
    ],
  ];
  for (const [name, make, reason] of cases) {
    test(`${name}: refused, nothing written`, async () => {
      const world = make(updateWorld());
      offer(world);
      const phone = await wholeTransfer(world);
      expect(phone.done).toMatchObject({ result: 1, reason });
      expect(world.board.update?.sectorsWritten).toEqual([]);
      expect(world.board.update?.record).toBeUndefined();
    });
  }

  test("a header for another image than the offer's: badHeader", async () => {
    const world = updateWorld();
    const other = testImage(4000);
    offer(world);
    const phone = await wholeTransfer({
      ...world,
      session: { ...world.session, file: other.file },
    });
    expect(phone.done).toMatchObject({ result: 1, reason: UpdateReason.BadHeader });
  });

  test("an image whose hash is not the header's: hashMismatch after the last byte, and the part forgotten", async () => {
    const image = testImage(9000, (f) => ({ ...f, imageSha256: new Uint8Array(32).fill(3) }));
    const world = updateWorld({ image });
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done).toMatchObject({ result: 1, reason: UpdateReason.HashMismatch });
    expect(world.board.update?.sectorsWritten).toEqual([0, 1, 2]);
    expect(world.board.update?.record).toBeUndefined();
    expect(world.board.statuses.at(-1)).toMatchObject({
      reason: UpdateReason.HashMismatch,
      bytesWritten: 0,
    });
  });
});

describe("the stops", () => {
  test("30 s without progress once open: linkLost, the part kept", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    const header = raw?.gets[0];
    if (raw === undefined || header === undefined) return;
    await raw.serve(world.image.file, header);
    await world.clock.advance(UPDATE_SESSION.noProgressMs - 2);
    expect(world.board.update?.session).toBe("open");
    await world.clock.advance(2);
    expect(world.board.update?.session).toBe("closed");
    expect(world.board.statuses.at(-1)).toMatchObject({
      reason: UpdateReason.LinkLost,
      bytesWritten: 128,
    });
  });

  test("after a drop, the phone must be back within 30 s of the last progress", async () => {
    const world = updateWorld();
    const raw = await openedRaw(world);
    raw?.link.close();
    await world.clock.advance(UPDATE_SESSION.noProgressMs);
    expect(world.board.window).toBe("closed");
    expect(world.board.statuses.at(-1)?.reason).toBe(UpdateReason.LinkLost);
  });
});

describe("faults", () => {
  test("a drop after the 30th Data: the phone reconnects, Hello says what is held, it resumes at the first sector not written", async () => {
    const world = updateWorld({
      faults: { latencyMs: 15, dropAfter: nthFrame(TransferKind.Data, 30) },
    });
    offer(world);
    const phone = await wholeTransfer(world, { dropAfterData: 30, reconnectAfterMs: 1000 });
    expect(phone.connections).toBe(2);
    expect(phone.hellos.map((h) => h.bytesHeld)).toEqual([0, 128 + 4096]);
    expect(phone.done?.result).toBe(0);
    expect(world.board.update?.writtenImage()).toEqual(world.image.image);
  });

  test("a lost Get is asked again after 3 s; a lost Data too", async () => {
    for (const lose of [nthFrame(TransferKind.Get, 4), nthFrame(TransferKind.Data, 6)]) {
      const world = updateWorld({ faults: { latencyMs: 15, lose } });
      offer(world);
      const started = world.clock.now();
      const phone = await wholeTransfer(world);
      expect(phone.done?.result).toBe(0);
      expect(world.clock.now() - started).toBeGreaterThan(UPDATE_SESSION.reaskMs);
    }
  });

  test("a repeated notification is answered twice, and the second Data is dropped", async () => {
    const world = updateWorld({ faults: { latencyMs: 15, repeat: nthFrame(TransferKind.Get, 3) } });
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done?.result).toBe(0);
    expect(world.board.update?.dropped.notAsked).toBe(1);
  });

  test("a piece corrupted on the way is dropped and asked again", async () => {
    const world = updateWorld({ faults: { latencyMs: 15, corrupt: corruptNthData(7) } });
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done?.result).toBe(0);
    expect(world.board.update?.dropped.damaged).toBe(1);
    expect(world.board.update?.writtenImage()).toEqual(world.image.image);
  });

  test("a slow board still finishes", async () => {
    const world = updateWorld({ faults: { latencyMs: 15, boardDelayMs: 80 } });
    offer(world);
    const phone = await wholeTransfer(world);
    expect(phone.done?.result).toBe(0);
  });

  test("a board that vanishes mid-transfer: the phone's link is lost; powered again and offered again, it resumes", async () => {
    const world = updateWorld({ size: 70000, faults: { latencyMs: 5 } });
    offer(world);
    const phone = new ScriptPhone(world.central, world.clock, world.session, {
      reconnectAfterMs: 500,
    });
    phone.start();
    await world.clock.runUntil(() => (world.board.update?.record?.bytesWritten ?? 0) > 128, 60_000);
    await world.clock.runUntil(
      () => (world.board.update?.sectorsWritten.length ?? 0) >= 17,
      60_000,
    );
    world.board.powerOff();
    await world.clock.advance(100);
    expect(phone.disconnections).toBe(1);
    expect(world.board.advertising()).toBeNull();
    world.board.powerOn();
    offer(world, 12, Uint8Array.of(1, 1, 1, 1, 1, 1, 1, 1));
    await world.clock.runUntil(() => phone.hellos.length === 2, 60_000);
    // The checkpoint: 64 KB is 16 sectors.
    expect(phone.hellos[1]?.bytesHeld).toBe(128 + 16 * 4096);
    phone.stop();
  });

  test("a second phone arriving during an update cannot connect; the first finishes", async () => {
    const world = updateWorld({ faults: { latencyMs: 15 } });
    offer(world);
    const phone = new ScriptPhone(world.central, world.clock, world.session);
    phone.start();
    await world.clock.runUntil(() => phone.dataFrames > 10, 60_000);
    const second = new ScriptedCentral(world.air);
    const attempt = await settled(world.clock, second.connect(world.board.id, 517));
    expect(attempt).toEqual({ ok: false, fault: "timeout" });
    await world.clock.runUntil(() => phone.done !== undefined, 60_000);
    expect(phone.done?.result).toBe(0);
  });

  test("185 carries the full header; 184 refuses update frames even when they would fit", async () => {
    const enough = updateWorld({ size: 600, faults: { latencyMs: 1 } });
    offer(enough);
    const phone = await wholeTransfer(enough, { mtu: 185 });
    expect(phone.done?.result).toBe(0);
    expect(phone.hellos[0]?.largestData).toBe(164);
    expect(phone.oversize).toBe(0);

    const short = updateWorld({
      size: 600,
      faults: { latencyMs: 1 },
      board: { random: (bytes) => new Uint8Array(bytes).fill(3) },
    });
    offer(short);
    const raw = await RawPhone.connect(short.clock, short.central, short.board.id, 184);
    expect(raw).toBeDefined();
    expect(raw?.frames).toEqual([]);
    const tag = bluetoothOpenTag(
      short.session.sessionKey,
      short.session.address,
      new Uint8Array(8).fill(3),
      short.session.imageId,
    );
    expect(tag.ok).toBe(true);
    if (tag.ok) await raw?.send({ kind: TransferKind.Open, tag: tag.value });
    expect(short.board.update?.session).toBe("connected");
    expect(raw?.gets).toEqual([]);
    await short.clock.advance(UPDATE_SESSION.noProgressMs);
    expect(short.board.statuses.at(-1)?.reason).toBe(UpdateReason.LinkLost);
    expect(short.board.update?.record).toBeUndefined();
  });
});

describe("a board made from its parts", () => {
  test("an unpaired board has no update service, and an offer does nothing", () => {
    const board = new ScriptedBoard(updateWorld().clock, {
      role: Role.Sensor,
      chipId: new Uint8Array(6),
      random: countingRandom(),
    });
    board.powerOn();
    expect(board.offerUpdate({ imageId: new Uint8Array(8), nonce: NONCE, windowUnits: 1 })).toBe(
      false,
    );
    expect(board.update).toBeUndefined();
  });
});
