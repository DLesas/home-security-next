/**
 * The phone's shared Bluetooth discovery (`app/src/pairing/radio.ts`), which serves both pairing's
 * search and the update's: which adverts it takes, how it ends (found, not found, the radio's
 * state, the person leaving), and that it leaves no scan, timer or listener behind.
 */
import { describe, expect, test } from "bun:test";
import { BLUETOOTH_UPDATE, bluetoothSessionKey, bluetoothUpdateName } from "@hsn/protocol/update";
import { discover, radioFault } from "../src/pairing/radio";
import { updateTransfer } from "../src/pairing/update-flow";
import type { Advert, BleCentral, BleState, BluetoothUpdate } from "../src/platform/ble";
import { BleAir } from "../../tools/ble-bench/src/air/air";
import { ScriptedCentral } from "../../tools/ble-bench/src/air/central";
import { ScriptedBoard } from "../../tools/ble-bench/src/boards/board";
import { ManualClock } from "../../tools/ble-bench/src/clock";
import { Role, testImage, testPairing } from "../../tools/ble-bench/src/test-keys";
import { settled } from "../../tools/ble-bench/test/support/raw-phone";
import { countingRandom, NONCE } from "../../tools/ble-bench/test/support/world";

const SERVICE = BLUETOOTH_UPDATE.serviceUuid;

/** An advert as a central reports it. */
const advert = (id: string, name: string): Advert => ({ id, name, serviceData: null, rssi: -60 });

/**
 * A central whose radio is `state` and whose scan reports `heard` at their times (`at` 0 and
 * `during` true: while `scan` is still being called). It counts what discovery asked of it.
 */
function fakeCentral(
  clock: ManualClock,
  heard: readonly { readonly at: number; readonly advert: Advert; readonly during?: boolean }[],
  state: () => BleState = () => "on",
) {
  const counts = { scans: 0, stops: 0, states: 0 };
  let stopped = false;
  const central: BleCentral = {
    state: () => {
      counts.states += 1;
      return Promise.resolve(state());
    },
    scan(service, found) {
      expect(service).toBe(SERVICE);
      counts.scans += 1;
      for (const one of heard) {
        if (one.during === true) found(one.advert);
        else
          clock.after(one.at, () => {
            if (!stopped) found(one.advert);
          });
      }
      return () => {
        stopped = true;
        counts.stops += 1;
      };
    },
    connect: () => Promise.resolve({ ok: false, fault: "failed" }),
  };
  return { central, counts };
}

/** A signal that counts the listeners added to it and those removed. */
function countedSignal() {
  const controller = new AbortController();
  const listeners = { added: 0, removed: 0 };
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args: Parameters<typeof add>) => {
    listeners.added += 1;
    add(...args);
  };
  signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    listeners.removed += 1;
    remove(...args);
  };
  return { controller, signal, listeners };
}

/** Accepts only the named board, as the update's scan does. */
const named = (name: string) => (seen: Advert) => seen.name === name;

describe("which adverts discovery takes", () => {
  test("only the adverts it accepts: another board advertising the same service is passed over", async () => {
    const clock = new ManualClock();
    const { central } = fakeCentral(clock, [
      { at: 10, advert: advert("stranger", "hsn-00000002") },
      { at: 20, advert: advert("ours", "hsn-00000001") },
    ]);
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, named("hsn-00000001"), 5000, new AbortController().signal),
    );
    expect(found).toEqual({ ok: true, value: [advert("ours", "hsn-00000001")] });
  });

  test("the update finds its own sensor while a second sensor advertises its update window", async () => {
    const clock = new ManualClock();
    const air = new BleAir(clock, { advertIntervalMs: 10 });
    const image = testImage(4000);
    const sensor = (address: number, last: number) => {
      const pairing = testPairing({ address });
      const board = new ScriptedBoard(clock, {
        role: Role.Sensor,
        chipId: Uint8Array.of(0x3c, 0x84, 0x27, 0xe2, 0x10, last),
        pairing,
        random: countingRandom(),
      });
      air.add(board);
      board.powerOn();
      board.offerUpdate({ imageId: image.imageId, nonce: NONCE, windowUnits: 12 });
      return { board, pairing };
    };
    // The other sensor is heard first.
    const other = sensor(0x1a2b3c4e, 0x02);
    const ours = sensor(0x1a2b3c4d, 0x01);
    expect([other.board.window, ours.board.window]).toEqual(["update", "update"]);
    const key = bluetoothSessionKey(ours.pairing.key, NONCE, ours.pairing.address);
    const grant: BluetoothUpdate = {
      device: 1,
      address: ours.pairing.address,
      imageId: image.imageId,
      version: "1.4.0",
      fileBytes: image.file.length,
      sha256: image.file.subarray(16, 48),
      sessionKey: key.ok ? key.value : new Uint8Array(32),
      windowS: 120,
      expiresAtMs: 900_000,
      needsWake: false,
    };
    const central = new ScriptedCentral(air);
    const result = await settled(
      clock,
      updateTransfer(central, clock, grant).run(
        { size: image.file.length, read: (o, l) => image.file.subarray(o, o + l) },
        new AbortController().signal,
        0,
        () => undefined,
        () => undefined,
      ),
      155_000,
    );
    expect(result).toEqual({ kind: "done", verified: true, reason: 0 });
    expect(bluetoothUpdateName(ours.pairing.address)).toBe("hsn-1a2b3c4d");
    expect([other.board.connections, ours.board.connections]).toEqual([0, 1]);
  });

  test("a board found in the last 600 ms of the search is returned, not 'not found'", async () => {
    const clock = new ManualClock();
    const { central } = fakeCentral(clock, [{ at: 4700, advert: advert("late", "late") }]);
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, () => true, 5000, new AbortController().signal, 600),
    );
    expect(found).toEqual({ ok: true, value: [advert("late", "late")] });
    expect(clock.now()).toBe(5000);
  });

  test("nothing heard within the search is 'not found', at its end", async () => {
    const clock = new ManualClock();
    const { central } = fakeCentral(clock, []);
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, () => true, 5000, new AbortController().signal, 600),
    );
    expect(found).toEqual({ ok: false, fault: "notFound" });
    expect(clock.now()).toBe(5000);
  });
});

describe("the radio's state", () => {
  test("Bluetooth unsupported is a failure, not Bluetooth off", async () => {
    const clock = new ManualClock();
    const unsupported = fakeCentral(clock, [], () => "unsupported");
    expect(await radioFault(unsupported.central)).toBe("failed");
    expect(
      await discover(
        unsupported.central,
        clock,
        SERVICE,
        () => true,
        5000,
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, fault: "failed" });
    expect(unsupported.counts.scans).toBe(0);
    for (const state of ["off", "unauthorized"] as const)
      expect(await radioFault(fakeCentral(clock, [], () => state).central)).toBe(state);
    expect(await radioFault(fakeCentral(clock, []).central)).toBeUndefined();
  });

  test("Bluetooth turned off during the search ends it with 'off' at the next poll", async () => {
    const clock = new ManualClock();
    let state: BleState = "on";
    const { central, counts } = fakeCentral(clock, [], () => state);
    clock.after(700, () => {
      state = "off";
    });
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, () => true, 5000, new AbortController().signal),
    );
    expect(found).toEqual({ ok: false, fault: "off" });
    expect(clock.now()).toBe(1000);
    expect(counts.stops).toBe(1);
  });
});

describe("leaving the search", () => {
  test("a signal aborted before the search starts no scan and answers 'lost'", async () => {
    const clock = new ManualClock();
    const { central, counts } = fakeCentral(clock, [{ at: 10, advert: advert("a", "a") }]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await settled(
        clock,
        discover(central, clock, SERVICE, () => true, 5000, controller.signal),
      ),
    ).toEqual({ ok: false, fault: "lost" });
    expect(counts.scans).toBe(0);
    expect(clock.pending).toBe(0);
  });

  test("aborting during the search ends it at once with 'lost', not at the search's end", async () => {
    const clock = new ManualClock();
    const { central, counts } = fakeCentral(clock, []);
    const controller = new AbortController();
    clock.after(100, () => {
      controller.abort();
    });
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, () => true, 5000, controller.signal),
    );
    expect(found).toEqual({ ok: false, fault: "lost" });
    expect(clock.now()).toBe(100);
    expect(counts.stops).toBe(1);
  });
});

describe("nothing is left behind", () => {
  for (const [name, heard, collectMs] of [
    ["a board found", [{ at: 1200, advert: advert("a", "a") }], 0],
    ["boards collected", [{ at: 1200, advert: advert("a", "a") }], 600],
    ["nothing found", [], 0],
  ] as const) {
    test(`${name}: the scan is stopped, no timer is left, and the abort listener is removed`, async () => {
      const clock = new ManualClock();
      const { central, counts } = fakeCentral(clock, heard);
      const { signal, listeners } = countedSignal();
      await settled(
        clock,
        discover(central, clock, SERVICE, () => true, 5000, signal, collectMs),
      );
      const states = counts.states;
      expect(counts.stops).toBe(1);
      expect(clock.pending).toBe(0);
      expect(listeners.added).toBe(1);
      expect(listeners.removed).toBe(1);
      // No poll of the radio runs after the end.
      await clock.advance(10_000);
      expect(counts.states).toBe(states);
    });
  }

  test("a board reported while the scan is still being set up does not leave the scan running", async () => {
    const clock = new ManualClock();
    const { central, counts } = fakeCentral(clock, [
      { at: 0, advert: advert("at once", "at once"), during: true },
    ]);
    const found = await settled(
      clock,
      discover(central, clock, SERVICE, () => true, 5000, new AbortController().signal),
    );
    expect(found).toEqual({ ok: true, value: [advert("at once", "at once")] });
    expect(counts.stops).toBe(1);
    expect(clock.pending).toBe(0);
  });
});
