/**
 * One scripted world for a test: a manual clock, the air, a paired sensor on it, a phone, and
 * the session the hub would have given the phone for an offer to that sensor.
 */
import { BleAir } from "../../src/air/air.ts";
import { ScriptedCentral, type CentralOptions } from "../../src/air/central.ts";
import type { Faults } from "../../src/air/faults.ts";
import { type BoardOptions, ScriptedBoard } from "../../src/boards/board.ts";
import { ManualClock } from "../../src/clock.ts";
import { bluetoothSessionKey } from "../../../../packages/protocol/src/update/bluetooth.ts";
import { Role, testImage, type TestImage, testPairing } from "./images.ts";
import type { PhoneSession } from "../../src/script-phone.ts";

export const NONCE = Uint8Array.of(0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61);

/** Randoms that count up, so every Hello's device random differs and a test can predict it. */
export function countingRandom(start = 0xc0): (bytes: number) => Uint8Array {
  let next = start;
  return (bytes) => {
    const out = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) out[i] = next++ & 0xff;
    return out;
  };
}

export interface UpdateWorld {
  readonly clock: ManualClock;
  readonly air: BleAir;
  readonly board: ScriptedBoard;
  readonly central: ScriptedCentral;
  readonly image: TestImage;
  readonly session: PhoneSession;
}

export function updateWorld(
  options: {
    readonly size?: number;
    readonly faults?: Faults;
    readonly central?: CentralOptions;
    readonly board?: Partial<BoardOptions>;
    readonly image?: TestImage;
  } = {},
): UpdateWorld {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 10 });
  const pairing = testPairing();
  const board = new ScriptedBoard(clock, {
    role: Role.Sensor,
    chipId: Uint8Array.of(0x3c, 0x84, 0x27, 0xe2, 0x10, 0x01),
    pairing,
    random: countingRandom(),
    ...options.board,
  });
  air.add(board);
  board.powerOn();
  if (options.faults !== undefined) air.faults = options.faults;
  const central = new ScriptedCentral(air, options.central);
  const image = options.image ?? testImage(options.size ?? 13000);
  const key = bluetoothSessionKey(pairing.key, NONCE, pairing.address);
  const session: PhoneSession = {
    address: pairing.address,
    sessionKey: key.ok ? key.value : new Uint8Array(32),
    imageId: image.imageId,
    file: image.file,
  };
  return { clock, air, board, central, image, session };
}

/** The hub's offer with action 3 reaches the board. */
export function offer(world: UpdateWorld, windowUnits = 12, nonce = NONCE): boolean {
  return world.board.offerUpdate({ imageId: world.image.imageId, nonce, windowUnits });
}
