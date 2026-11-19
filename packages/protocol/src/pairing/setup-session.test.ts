/**
 * The setup session over a link (setup-session.ts), against a board that answers as ESP-IDF's
 * protocomm did (`testing/replay-board.ts` over `pairing-board-script.json`): a whole pairing
 * through to the Provision result; a wrong code and exactly where the attempt stops; five wrong
 * codes and their timing; link faults, timeouts and changed bytes on the way.
 */
import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "../bytes.ts";
import { decodeSetupMessage } from "../usb/setup.ts";
import { PAIRING_CODE, PROTOCOMM } from "./constants.ts";
import { startSecurity2 } from "./security2.ts";
import {
  type PairingAttempts,
  pairingAttempts,
  pairingCharacteristic,
  type PairingClock,
  SETUP_SESSION,
  setupSessionOpener,
} from "./setup-session.ts";
import { type BoardOp, replayBoard, type ScriptStep } from "./testing/replay-board.ts";
import type { PairingCodeText, StartSecurity2 } from "./types.ts";
import { espIdfVectors } from "./vectors/esp-idf-vectors.ts";

const { srp, script } = espIdfVectors();
const SIREN = srp.cases[0];
const WHOLE = script.cases[0];
const WRONG = script.cases.find((c) => c.wrongPassword !== null) ?? script.cases[0];
const VERSION_TEXT = new TextDecoder().decode(fromHex(WHOLE.steps[0]?.answer ?? ""));
const RIGHT = SIREN.password as PairingCodeText;
const WRONG_CODE = (WRONG.wrongPassword ?? "") as PairingCodeText;
const IDENTIFY = Uint8Array.of(0xf1, 0x01);
const PROVISION = fromHex(WHOLE.steps.at(-1)?.request ?? "");
const encoder = new TextEncoder();

/** The siren case's a, or the retry's: the requests are then the script's, byte for byte. */
const withA =
  (a: Uint8Array): StartSecurity2 =>
  (code) =>
    startSecurity2(code, { clientPrivate: a });
const SIREN_A = withA(fromHex(SIREN.clientPrivate));
const RETRY_A = withA(fromHex(WRONG.clientPrivates[1] ?? ""));

/** The whole pairing's provision request, sealed; the plaintext is in pairing-security2.json. */
const { security2 } = espIdfVectors();
const SIREN_EXCHANGE = security2.cases[0];
const PROVISION_PLAIN = fromHex(SIREN_EXCHANGE.messages[2]?.plaintext ?? "");

function fakeClock() {
  let now = 0;
  let sleepers: { at: number; wake: () => void }[] = [];
  const clock: PairingClock & { advance(ms: number): void; set(ms: number): void } = {
    now: () => now,
    sleep(ms) {
      return new Promise<void>((wake) => sleepers.push({ at: now + ms, wake }));
    },
    advance(ms) {
      clock.set(now + ms);
    },
    set(ms) {
      now = ms;
      const due = sleepers.filter((s) => s.at <= now);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due) s.wake();
    },
  };
  return clock;
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

const ops = (list: readonly BoardOp[]): string[] =>
  list.map(
    (o) =>
      `${o.op} ${o.endpoint}${o.op === "write" ? ` ${o.response ? "with" : "without"} response` : ""}`,
  );

const sessionSteps = (s: (typeof script.cases)[number]): ScriptStep[] => s.steps;

/** The session, failing the test when there is none. */
function sessionOf<T>(r: { ok: true; value: T } | { ok: false; fault: string }): T | undefined {
  expect(r.ok ? "ok" : r.fault).toBe("ok");
  return r.ok ? r.value : undefined;
}

describe("the characteristics", () => {
  test("the service's UUID with each endpoint's 16 bits as hex digits 5 to 8", () => {
    expect(PROTOCOMM.serviceUuid).toBe("3b50aa44-5e8a-4831-ba12-b8b12a8b0c8f");
    expect(pairingCharacteristic(PROTOCOMM.endpoints.protoVersion.uuid16)).toBe(
      "3b50ff53-5e8a-4831-ba12-b8b12a8b0c8f",
    );
    expect(pairingCharacteristic(PROTOCOMM.endpoints.session.uuid16)).toBe(
      "3b50ff51-5e8a-4831-ba12-b8b12a8b0c8f",
    );
    expect(pairingCharacteristic(PROTOCOMM.endpoints.setup.uuid16)).toBe(
      "3b50ff60-5e8a-4831-ba12-b8b12a8b0c8f",
    );
    expect(pairingCharacteristic(0x0001)).toBe("3b500001-5e8a-4831-ba12-b8b12a8b0c8f");
  });

  test("protocomm_nimble.c's derivation: bytes 12 and 13 of the little-endian array", () => {
    const le = fromHex(PROTOCOMM.serviceUuid.replaceAll("-", "")).reverse();
    le[12] = 0x51;
    le[13] = 0xff;
    const text = toHex(le.reverse());
    const uuid = `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
    expect(pairingCharacteristic(0xff51)).toBe(uuid);
  });
});

describe("a whole pairing against the board ESP-IDF's code answered", () => {
  test("proto-ver, the handshake, Identify and Provision: the siren is identified and accepts", async () => {
    const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
    const link = board.connect();
    const open = setupSessionOpener({ clock: fakeClock(), start: SIREN_A });
    const opened = await open(link, RIGHT);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const session = opened.value;
    expect(session.version).toEqual({
      v: "hsn-pair/1",
      role: 2,
      chip: (JSON.parse(VERSION_TEXT) as { chip: string }).chip,
      firmware: "1.0.0",
      sec: 2,
    });
    const identity = await session.exchange(IDENTIFY);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    const decoded = decodeSetupMessage(identity.value);
    expect(decoded.ok && decoded.value.type === 0x02 ? decoded.value.role : null).toBe(2);
    const result = await session.exchange(PROVISION_PLAIN);
    expect(result.ok ? toHex(result.value) : result.fault).toBe("f10400");
    const accepted = result.ok ? decodeSetupMessage(result.value) : undefined;
    expect(accepted?.ok && accepted.value.type === 0x04 ? accepted.value.result : null).toBe(0);
    expect(board.unexpected).toEqual([]);
    expect(board.remaining()).toBe(0);
    expect(ops(link.ops)).toEqual([
      "write proto-ver with response",
      "read proto-ver",
      "write prov-session with response",
      "read prov-session",
      "write prov-session with response",
      "read prov-session",
      "write hsn-setup with response",
      "read hsn-setup",
      "write hsn-setup with response",
      "read hsn-setup",
    ]);
    // proto-ver is written the label.
    expect(link.ops[0]?.op === "write" ? link.ops[0].data : "").toBe(
      toHex(encoder.encode("hsn-pair/1")),
    );
    session.close();
    expect(link.closed).toBe(true);
    const after = await session.exchange(IDENTIFY);
    expect(after.ok ? "ok" : after.fault).toBe("lost");
    expect(PROVISION.length).toBeGreaterThan(PROVISION_PLAIN.length);
  });
});

describe("a wrong code", () => {
  test("the attempt stops at the refused command 1: no read after it, nothing more written", async () => {
    const board = replayBoard(sessionSteps(WRONG), VERSION_TEXT);
    const link = board.connect();
    const attempts = pairingAttempts();
    const opened = await setupSessionOpener({ clock: fakeClock(), attempts, start: SIREN_A })(
      link,
      WRONG_CODE,
    );
    expect(opened.ok ? "ok" : opened.fault).toBe("wrongCode");
    expect(ops(link.ops)).toEqual([
      "write proto-ver with response",
      "read proto-ver",
      "write prov-session with response",
      "read prov-session",
      "write prov-session with response",
    ]);
    expect(board.unexpected).toEqual([]);
    expect(link.closed).toBe(true);
    expect(attempts.wrongCodes).toBe(1);
  });

  test("then the right code, on a new connection, opens the session ESP-IDF opened", async () => {
    const board = replayBoard(sessionSteps(WRONG), VERSION_TEXT);
    const clock = fakeClock();
    const attempts = pairingAttempts();
    await setupSessionOpener({ clock, attempts, start: SIREN_A })(board.connect(), WRONG_CODE);
    const opened = await setupSessionOpener({ clock, attempts, start: RETRY_A })(
      board.connect(),
      RIGHT,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const identity = await opened.value.exchange(IDENTIFY);
    expect(identity.ok ? toHex(identity.value).slice(0, 6) : identity.fault).toBe("f10202");
    expect(board.unexpected).toEqual([]);
    expect(attempts.wrongCodes).toBe(0);
  });

  test("a wrong code is only a refused command 1: other faults there are what they are", async () => {
    for (const fault of ["lost", "timeout", "off"] as const) {
      const board = replayBoard(sessionSteps(WRONG), VERSION_TEXT);
      board.interfere = (_op, i) => (i === 4 ? fault : undefined);
      const attempts = pairingAttempts();
      const opened = await setupSessionOpener({ clock: fakeClock(), attempts, start: SIREN_A })(
        board.connect(),
        WRONG_CODE,
      );
      expect(opened.ok ? "ok" : opened.fault).toBe(fault);
      expect(attempts.wrongCodes).toBe(0);
    }
    // A refused command 0 is not a wrong code either.
    const board = replayBoard(sessionSteps(WRONG), VERSION_TEXT);
    board.interfere = (_op, i) => (i === 2 ? "failed" : undefined);
    const opened = await setupSessionOpener({ clock: fakeClock(), start: SIREN_A })(
      board.connect(),
      WRONG_CODE,
    );
    expect(opened.ok ? "ok" : opened.fault).toBe("failed");
  });
});

describe("five wrong codes", () => {
  /** A board that refuses the wrong code's command 1, as many times as asked. */
  const wrongBoard = () =>
    replayBoard(
      Array.from({ length: 12 }, () => sessionSteps(WRONG).slice(0, 2)).flat(),
      VERSION_TEXT,
    );
  const attempt = async (
    clock: PairingClock,
    attempts: PairingAttempts,
    board: ReturnType<typeof wrongBoard>,
  ) => {
    const link = board.connect();
    const opened = await setupSessionOpener({ clock, attempts, start: SIREN_A })(link, WRONG_CODE);
    return { fault: opened.ok ? "ok" : opened.fault, writes: link.ops.length, closed: link.closed };
  };

  test("four are wrong codes, the fifth stops the board, the sixth touches nothing", async () => {
    const clock = fakeClock();
    const attempts = pairingAttempts();
    const board = wrongBoard();
    for (let i = 1; i <= 4; i++) {
      clock.advance(1_000);
      expect(await attempt(clock, attempts, board)).toEqual({
        fault: "wrongCode",
        writes: 5,
        closed: true,
      });
      expect(attempts.wrongCodes).toBe(i);
      expect(attempts.stopped(clock.now())).toBe(false);
    }
    clock.advance(1_000);
    expect(await attempt(clock, attempts, board)).toEqual({
      fault: "tooManyTries",
      writes: 5,
      closed: true,
    });
    expect(attempts.stopped(clock.now())).toBe(true);
    expect(await attempt(clock, attempts, board)).toEqual({
      fault: "tooManyTries",
      writes: 0,
      closed: true,
    });
    expect(PAIRING_CODE.maxTries).toBe(5);
  });

  test("stopped for a window's length after the fifth, to the millisecond; or until reopened", async () => {
    const clock = fakeClock();
    const attempts = pairingAttempts();
    for (let i = 0; i < 5; i++) attempts.wrongCode(clock.now());
    const stoppedAt = clock.now();
    clock.set(stoppedAt + PAIRING_CODE.windowMs - 1);
    expect(attempts.stopped(clock.now())).toBe(true);
    expect((await attempt(clock, attempts, wrongBoard())).writes).toBe(0);
    clock.set(stoppedAt + PAIRING_CODE.windowMs);
    expect(attempts.stopped(clock.now())).toBe(false);
    expect(attempts.wrongCodes).toBe(0);
    expect(await attempt(clock, attempts, wrongBoard())).toEqual({
      fault: "wrongCode",
      writes: 5,
      closed: true,
    });

    const again = pairingAttempts();
    for (let i = 0; i < 5; i++) again.wrongCode(0);
    expect(again.stopped(1)).toBe(true);
    again.reopened();
    expect(again.stopped(1)).toBe(false);
    expect(again.wrongCodes).toBe(0);
  });

  test("the count is a window's: a first wrong code a window old no longer counts", () => {
    const within = pairingAttempts();
    within.wrongCode(0);
    for (let i = 0; i < 3; i++) within.wrongCode(PAIRING_CODE.windowMs - 1);
    expect(within.wrongCode(PAIRING_CODE.windowMs - 1)).toBe(true);

    const after = pairingAttempts();
    after.wrongCode(0);
    for (let i = 0; i < 3; i++) after.wrongCode(PAIRING_CODE.windowMs);
    expect(after.wrongCode(PAIRING_CODE.windowMs)).toBe(false);
    expect(after.wrongCodes).toBe(4);
    expect(after.wrongCode(PAIRING_CODE.windowMs)).toBe(true);
  });

  test("a right code clears the count; a wrong code while stopped is not counted again", () => {
    const a = pairingAttempts();
    for (let i = 0; i < 4; i++) a.wrongCode(i);
    a.rightCode();
    expect(a.wrongCodes).toBe(0);
    for (let i = 0; i < 4; i++) expect(a.wrongCode(10 + i)).toBe(false);
    expect(a.wrongCode(20)).toBe(true);
    expect(a.wrongCode(21)).toBe(false);
    expect(a.wrongCodes).toBe(5);
  });

  test("a right code after four wrong ones opens, and clears the count", async () => {
    const clock = fakeClock();
    const attempts = pairingAttempts();
    for (let i = 0; i < 4; i++) attempts.wrongCode(clock.now());
    const opened = await setupSessionOpener({ clock, attempts, start: SIREN_A })(
      replayBoard(sessionSteps(WHOLE), VERSION_TEXT).connect(),
      RIGHT,
    );
    expect(opened.ok).toBe(true);
    expect(attempts.wrongCodes).toBe(0);
  });
});

describe("time: each step waits at most its timeout, on the caller's clock", () => {
  for (const [name, index] of [
    ["proto-ver's read", 1],
    ["command 0's write", 2],
    ["response 1's read", 5],
    ["command 1's write", 4],
  ] as const)
    test(`${name} never answering is a timeout, at exactly stepTimeoutMs`, async () => {
      const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
      board.interfere = (_op, i) => (i === index ? "hang" : undefined);
      const clock = fakeClock();
      const link = board.connect();
      const attempts = pairingAttempts();
      let result: string | undefined;
      void setupSessionOpener({ clock, attempts, start: SIREN_A })(link, RIGHT).then((r) => {
        result = r.ok ? "ok" : r.fault;
      });
      await settle();
      clock.advance(SETUP_SESSION.stepTimeoutMs - 1);
      await settle();
      expect(result).toBeUndefined();
      clock.advance(1);
      await settle();
      expect(result).toBe("timeout");
      expect(link.closed).toBe(true);
      expect(attempts.wrongCodes).toBe(0);
    });

  test("the timeout is the caller's", async () => {
    const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
    board.interfere = (_op, i) => (i === 1 ? "hang" : undefined);
    const clock = fakeClock();
    let result: string | undefined;
    void setupSessionOpener({ clock, stepTimeoutMs: 50, start: SIREN_A })(
      board.connect(),
      RIGHT,
    ).then((r) => {
      result = r.ok ? "ok" : r.fault;
    });
    await settle();
    clock.advance(49);
    await settle();
    expect(result).toBeUndefined();
    clock.advance(1);
    await settle();
    expect(result).toBe("timeout");
  });

  test("a setup message's answer never coming is a timeout, and ends the session", async () => {
    const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
    board.interfere = (_op, i) => (i === 7 ? "hang" : undefined);
    const clock = fakeClock();
    const session = sessionOf(
      await setupSessionOpener({ clock, start: SIREN_A })(board.connect(), RIGHT),
    );
    if (session === undefined) return;
    let result: string | undefined;
    void session.exchange(IDENTIFY).then((r) => {
      result = r.ok ? "ok" : r.fault;
    });
    await settle();
    clock.advance(SETUP_SESSION.stepTimeoutMs);
    await settle();
    expect(result).toBe("timeout");
    const next = await session.exchange(IDENTIFY);
    expect(next.ok ? "ok" : next.fault).toBe("lost");
  });
});

describe("what the link and the board can do wrong", () => {
  const open = (board: ReturnType<typeof replayBoard>, code = RIGHT) =>
    setupSessionOpener({ clock: fakeClock(), start: SIREN_A })(board.connect(), code);
  const fault = (r: { ok: boolean; fault?: string }) => (r.ok ? "ok" : r.fault);

  test("proto-ver: not JSON, not ours, not security 2, extra fields, or empty", async () => {
    const good = JSON.parse(VERSION_TEXT) as Record<string, unknown>;
    for (const text of [
      "{",
      "",
      "hsn-pair/1",
      JSON.stringify({ ...good, v: "hsn-pair/2" }),
      JSON.stringify({ ...good, sec: 1 }),
      JSON.stringify({ ...good, chip: "3C71BF9A4F2A" }),
      JSON.stringify({ ...good, extra: true }),
      "ÿþ",
    ]) {
      const board = replayBoard(sessionSteps(WHOLE), text);
      const r = await open(board);
      expect({ text, f: fault(r) }).toEqual({ text, f: "protocol" });
      expect(board.remaining()).toBe(sessionSteps(WHOLE).length - 1);
    }
  });

  test("a link fault at each step is that fault, and closes the link", async () => {
    for (let index = 0; index < 6; index++)
      for (const f of ["lost", "off", "unauthorized"] as const) {
        const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
        board.interfere = (_op, i) => (i === index ? f : undefined);
        const link = board.connect();
        const r = await setupSessionOpener({ clock: fakeClock(), start: SIREN_A })(link, RIGHT);
        expect({ index, f: fault(r) }).toEqual({ index, f });
        expect(link.closed).toBe(true);
      }
  });

  test("the board's answers changed at each position: refused, never a session the board's own", async () => {
    const steps = sessionSteps(WHOLE);
    for (const [read, step] of [
      [3, 1],
      [5, 2],
    ] as const) {
      const answer = fromHex(steps[step]?.answer ?? "");
      for (let i = 0; i < answer.length; i += read === 3 ? 7 : 1) {
        const changed = answer.slice();
        changed[i] = (changed[i] ?? 0) ^ 0x04;
        const board = replayBoard(steps, VERSION_TEXT);
        board.interfere = (_op, n) => (n === read ? { answer: changed } : undefined);
        const r = await open(board);
        if (r.ok) {
          // Only response 1's session id is not covered by the proofs; the board then refuses
          // the first request, which it cannot open.
          expect(read).toBe(5);
          const first = await r.value.exchange(IDENTIFY);
          expect(fault(first)).toBe("failed");
        } else expect(["protocol", "wrongCode"]).toContain(r.fault);
      }
    }
  }, 60_000);

  test("a sealed answer changed, replayed or stale ends the session as protocol", async () => {
    const steps = sessionSteps(WHOLE);
    const first = fromHex(steps[3]?.answer ?? "");
    for (const [name, answer] of [
      ["changed", Uint8Array.from(first, (b, i) => (i === 5 ? b ^ 1 : b))],
      ["cut short", first.slice(0, 10)],
      ["empty", new Uint8Array(0)],
      ["response 1, stale", fromHex(steps[2]?.answer ?? "")],
    ] as const) {
      const board = replayBoard(steps, VERSION_TEXT);
      board.interfere = (_op, n) => (n === 7 ? { answer } : undefined);
      const link = board.connect();
      const session = sessionOf(
        await setupSessionOpener({ clock: fakeClock(), start: SIREN_A })(link, RIGHT),
      );
      if (session === undefined) return;
      const r = await session.exchange(IDENTIFY);
      expect({ name, f: fault(r) }).toEqual({ name, f: "protocol" });
      expect(link.closed).toBe(true);
    }
    // The first answer again, for the second request: the counter has moved on.
    const board = replayBoard(steps, VERSION_TEXT);
    board.interfere = (_op, n) => (n === 9 ? { answer: first } : undefined);
    const session = sessionOf(await open(board));
    if (session === undefined) return;
    expect((await session.exchange(IDENTIFY)).ok).toBe(true);
    expect(fault(await session.exchange(PROVISION_PLAIN))).toBe("protocol");
  });

  test("the board dropping the connection in the session", async () => {
    const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
    const link = board.connect();
    const session = sessionOf(
      await setupSessionOpener({ clock: fakeClock(), start: SIREN_A })(link, RIGHT),
    );
    if (session === undefined) return;
    link.drop("lost");
    expect(fault(await session.exchange(IDENTIFY))).toBe("lost");
    expect(link.ops).toHaveLength(6);
  });

  test("messages: empty or over 496 bytes are refused unsent; 496 is sent; one at a time", async () => {
    const session = sessionOf(await open(replayBoard(sessionSteps(WHOLE), VERSION_TEXT)));
    if (session === undefined) return;
    expect(SETUP_SESSION.maxMessageBytes).toBe(496);
    expect(fault(await session.exchange(new Uint8Array(0)))).toBe("protocol");
    expect(fault(await session.exchange(new Uint8Array(497)))).toBe("protocol");
    // Refused before sealing: the session is still good.
    const [a, b] = [session.exchange(IDENTIFY), session.exchange(IDENTIFY)];
    expect(fault(await b)).toBe("protocol");
    expect((await a).ok).toBe(true);
    // 496 bytes are written (the replay board does not know them, and refuses).
    expect(fault(await session.exchange(new Uint8Array(496).fill(0xf1)))).toBe("failed");
  });

  test("a command 0 the board does not take is that write's fault, and nothing opens", async () => {
    // The whole pairing's board and a different a: command 0 is not the one it recorded.
    const board = replayBoard(sessionSteps(WHOLE), VERSION_TEXT);
    const r = await setupSessionOpener({ clock: fakeClock(), start: RETRY_A })(
      board.connect(),
      RIGHT,
    );
    expect(fault(r)).toBe("failed");
    expect(board.unexpected).toHaveLength(1);
  });
});
