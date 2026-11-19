/**
 * The pair page's decisions (`pair-steps.ts`, which `pair-page.tsx` calls) and the pairing flow
 * where they meet the board, against m3-design.md section 5: what a trip to the background does on
 * each page, where "Try again" leads and when the phone forgets a closed window's wrong codes, a
 * search left while a board is connecting, and a board nobody has held. No hub is needed: these
 * stop before `pair.prepare`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex } from "@hsn/protocol/messages";
import { PAIRING_CODE, PROTOCOMM, makePairingCode } from "@hsn/protocol/pairing";
import { findPairingBoards, pairingFlow } from "../src/pairing/pair-device";
import {
  type PairBackground,
  pairBackground,
  type PairPageName,
  retryAfter,
  searchFault,
  showsNoContact,
} from "../src/pairing/pair-steps";
import type { BleCentral, BleFault, GattLink, PairFault } from "../src/platform/ble";
import type { Outcome } from "../src/platform/split";
import { BleAir } from "../../tools/ble-bench/src/air/air";
import { ScriptedCentral } from "../../tools/ble-bench/src/air/central";
import { PAIRING_HOLD_MS, placeBoard, ScriptedBoard } from "../../tools/ble-bench/src/boards/board";
import { ManualClock } from "../../tools/ble-bench/src/clock";
import { Role } from "../../tools/ble-bench/src/test-keys";
import { settled } from "../../tools/ble-bench/test/support/raw-phone";

const failures = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "locales", "en", "common.json"), "utf8"),
) as { pairing: { failure: Record<string, string> } };
/** Every failure the page can show, as its locale keys name them. */
const reasons = [
  ...new Set(Object.keys(failures.pairing.failure).map((key) => key.replace(/_.*$/u, ""))),
];

describe("going to the background", () => {
  /** Every page, with what the trip does there; the type makes the list whole. */
  const expected: Record<PairPageName, PairBackground> = {
    choose: "none",
    open: "none",
    permission: "none",
    find: "interrupted",
    chooseBoard: "none",
    found: "none",
    scan: "none",
    type: "none",
    checking: "interrupted",
    name: "interrupted",
    adding: "unfinished",
    waiting: "none",
    done: "none",
    failure: "none",
  };

  test("only a page with a link or an exchange in flight is interrupted; adding is unfinished", () => {
    for (const [page, effect] of Object.entries(expected))
      expect({ page, effect: pairBackground(page as PairPageName) }).toEqual({ page, effect });
  });

  test("waiting for the device to reach the hub carries on: the hub has added it already", () => {
    expect(pairBackground("waiting")).toBe("none");
  });

  test("the scan page carries on, so a trip to Settings for the camera does not end the pairing", () => {
    expect(pairBackground("scan")).toBe("none");
  });
});

describe("the failure page's Try again", () => {
  const chip = "112233445599";

  test("every fault of the search and of the code shows a failure the page has words for", () => {
    const faults: readonly PairFault[] = [
      "off",
      "unauthorized",
      "notFound",
      "lost",
      "timeout",
      "failed",
      "wrongCode",
      "tooManyTries",
      "protocol",
    ];
    for (const fault of faults) expect(reasons).toContain(searchFault[fault]);
  });

  test("a wrong code goes back to the code, in the same window: nothing is forgotten", () => {
    expect(retryAfter("wrongCode", chip)).toEqual({ page: "type", reopen: undefined });
  });

  test("Bluetooth off or blocked goes to its page: the window is not said to be reopened", () => {
    expect(retryAfter("off", chip)).toEqual({ page: "permission", reopen: undefined });
    expect(retryAfter("unauthorized", chip)).toEqual({ page: "permission", reopen: undefined });
  });

  test("after five wrong codes the person holds the button: the count is forgotten and the search runs", () => {
    expect(retryAfter("tooManyTries", chip)).toEqual({ page: "find", reopen: chip });
  });

  test("every other failure asks for the hold again, and forgets the chosen board's count", () => {
    for (const reason of reasons.filter(
      (r) => !["wrongCode", "tooManyTries", "off", "unauthorized"].includes(r),
    ))
      expect({ reason, retry: retryAfter(reason, chip) }).toEqual({
        reason,
        retry: { page: "open", reopen: chip },
      });
  });

  test("with no board chosen yet, every failure but Bluetooth's asks for the hold, forgetting nothing", () => {
    for (const reason of reasons.filter((r) => r !== "off" && r !== "unauthorized"))
      expect({ reason, retry: retryAfter(reason, undefined) }).toEqual({
        reason,
        retry: { page: "open", reopen: undefined },
      });
  });
});

/** One board on the scripted air, powered on and not yet held, with a phone's pairing flow. */
function oneBoard(chip: string) {
  const clock = new ManualClock();
  const air = new BleAir(clock, { advertIntervalMs: 15 });
  const central = new ScriptedCentral(air);
  const board = placeBoard(
    air,
    new ScriptedBoard(clock, { role: Role.Siren, chipId: fromHex(chip) }),
  );
  return { clock, central, board, flow: pairingFlow(central, clock) };
}

test("searching for a board nobody has held finds nothing: the hold opens its window", async () => {
  const { clock, central, board } = oneBoard("112233445598");
  const signal = new AbortController().signal;
  expect(board.window).toBe("closed");
  expect(await settled(clock, findPairingBoards(central, clock, signal))).toEqual({
    ok: false,
    fault: "notFound",
  });
  expect(board.connections).toBe(0);
  board.holdButton(PAIRING_HOLD_MS);
  const found = await settled(clock, findPairingBoards(central, clock, signal));
  expect(found?.ok ? found.value.map(({ version }) => version.chip) : found?.fault).toEqual([
    "112233445598",
  ]);
});

test("after a board's window ends and the person holds the button again, only the new window's wrong codes count", async () => {
  const { clock, central, board, flow } = oneBoard("112233445599");
  const signal = new AbortController().signal;
  const wrong = makePairingCode(board.code === makePairingCode(1n) ? 2n : 1n);
  expect(wrong !== undefined).toBe(true);
  if (wrong === undefined) return;
  board.holdButton(PAIRING_HOLD_MS);

  // The window is open; the person takes a minute to read the code from the display.
  await clock.advance(60_000);
  const first = await settled(clock, findPairingBoards(central, clock, signal));
  const candidate = first?.ok ? first.value[0] : undefined;
  expect(candidate !== undefined).toBe(true);
  if (candidate === undefined) return;
  for (let i = 0; i < 3; i++)
    expect((await settled(clock, flow.open(candidate, wrong, signal)))?.ok).toBe(false);
  expect(board.wrongCodes).toBe(3);

  // The board's two minutes, counted from its hold, end; the first wrong code is younger.
  const firstWrongAt = 60_000;
  await clock.advance(Math.max(0, PAIRING_CODE.windowMs + 1_000 - clock.now()));
  expect(board.window).toBe("closed");
  expect(clock.now() - firstWrongAt).toBeLessThan(PAIRING_CODE.windowMs);
  const late = await settled(clock, flow.open(candidate, board.code, signal));
  expect(late?.ok).toBe(false);
  if (late === undefined || late.ok) return;

  // The page shows its failure; Try again asks for the hold, which the person does.
  const retry = retryAfter(searchFault[late.fault], candidate.version.chip);
  expect(retry.page).toBe("open");
  if (retry.reopen !== undefined) flow.reopened(retry.reopen);
  board.holdButton(PAIRING_HOLD_MS);
  expect(board.window).toBe("pairing");
  const again = await settled(clock, findPairingBoards(central, clock, signal));
  const reopened = again?.ok ? again.value[0] : undefined;
  expect(reopened !== undefined).toBe(true);
  if (reopened === undefined) return;

  // Two wrong codes in the new window: the board has three tries left and is listening.
  for (let i = 0; i < 2; i++)
    expect(await settled(clock, flow.open(reopened, wrong, signal))).toEqual({
      ok: false,
      fault: "wrongCode",
    });
  expect(board.wrongCodes).toBe(2);
  expect(flow.remaining(reopened.version.chip)).toBe(3);
  expect(board.window).toBe("pairing");
  // So the right code is tried, and the board accepts it.
  const right = await settled(clock, flow.open(reopened, board.code, signal));
  expect(right?.ok).toBe(true);
  if (right?.ok) right.value.session.close();
});

test("leaving the search while a board is connecting closes that link at once and writes nothing", async () => {
  const clock = new ManualClock();
  const writes: string[] = [];
  let closes = 0;
  const link: GattLink = {
    mtu: 185,
    write: (characteristic) => {
      writes.push(characteristic);
      // A board that is slow to answer: the answer never comes.
      return new Promise<Outcome<void, BleFault>>(() => undefined);
    },
    read: () => new Promise<Outcome<Uint8Array, BleFault>>(() => undefined),
    watch: () => () => undefined,
    onClosed: () => undefined,
    close: () => {
      closes += 1;
    },
  };
  let connected: ((outcome: Outcome<GattLink, BleFault>) => void) | undefined;
  const central: BleCentral = {
    state: () => Promise.resolve("on"),
    scan: (service, found) => {
      expect(service).toBe(PROTOCOMM.serviceUuid);
      clock.after(10, () => {
        found({ id: "board", name: "hsn-pair-4f2a", serviceData: null, rssi: -50 });
      });
      return () => undefined;
    },
    connect: () =>
      new Promise<Outcome<GattLink, BleFault>>((resolve) => {
        connected = resolve;
      }),
  };
  const leaving = new AbortController();
  const search = findPairingBoards(central, clock, leaving.signal);
  await clock.advance(1_000);
  expect(connected !== undefined).toBe(true);

  // The person leaves the page while the phone is still connecting; then the connection comes.
  leaving.abort();
  connected?.({ ok: true, value: link });
  await clock.advance(1);
  expect(writes).toEqual([]);
  expect(closes).toBe(1);
  // And nothing found after the person left is offered.
  expect(await settled(clock, search)).toEqual({ ok: false, fault: "lost" });
});

test("the timed-out pairing result shows success when the hub hears the device", () => {
  expect(showsNoContact(true, "paired")).toBe(true);
  expect(showsNoContact(true, "contacted")).toBe(false);
});
