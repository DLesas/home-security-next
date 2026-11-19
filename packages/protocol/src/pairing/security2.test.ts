/**
 * Protocomm security 2's phone side (security2.ts) against ESP-IDF's security2.c: whole exchanges
 * (`pairing-security2.json`), the board's scripts (`pairing-board-script.json`), the counter at
 * its top (`pairing-security2-counter.json`); a wrong code, a tampered byte at every position, and
 * replayed and reordered answers.
 */
import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "../bytes.ts";
import { decodeSessionData, encodeSessionData, type Sec2Message } from "./protobuf.ts";
import { security2Nonce, security2Session, startSecurity2 } from "./security2.ts";
import type { PairingCodeText, PairResult, Security2Session } from "./types.ts";
import { espIdfVectors } from "./vectors/esp-idf-vectors.ts";

const { srp, security2, script, counter } = espIdfVectors();
const srpCase = (name: string) => srp.cases.find((c) => c.name === name);
const asCode = (text: string): PairingCodeText => text as PairingCodeText;
const value = <T>(r: PairResult<T>): T | undefined => (r.ok ? r.value : undefined);
const error = <T>(r: PairResult<T>): string => (r.ok ? "ok" : r.error);

const SIREN = srp.cases[0];
const exchange = security2.cases[0];

/** A client for the siren's case taken to the given stage. */
async function clientAt(stage: "sent0" | "sent1", password = SIREN.password) {
  const client = startSecurity2(asCode(password), { clientPrivate: fromHex(SIREN.clientPrivate) });
  const c0 = value(await client.command0());
  const c1 =
    stage === "sent1" ? value(await client.command1(fromHex(exchange.response0))) : undefined;
  return { client, c0, c1 };
}

describe("whole exchanges, as ESP-IDF's board made them", () => {
  test("the file is ESP-IDF v6.1.1's", () => {
    expect(security2.source).toContain(
      "ESP-IDF v6.1.1 (commit 051e4c4eb20346e043cdd47bc388fde75ff8af63)",
    );
    expect(security2.cases).toHaveLength(4);
  });

  for (const c of security2.cases)
    test(c.name, async () => {
      const s = srpCase(c.srpCase);
      expect(s).toBeDefined();
      if (s === undefined) return;
      const client = startSecurity2(asCode(s.password), {
        clientPrivate: fromHex(s.clientPrivate),
      });
      expect(toHex(value(await client.command0()) ?? new Uint8Array())).toBe(c.command0);
      expect(toHex(value(await client.command1(fromHex(c.response0))) ?? new Uint8Array())).toBe(
        c.command1,
      );
      const session = value(await client.finish(fromHex(c.response1)));
      expect(session).toBeDefined();
      if (session === undefined) return;
      const board = security2Session(fromHex(s.sessionKey), fromHex(c.nonce), "board");
      for (const [i, m] of c.messages.entries()) {
        // The nonce: the session id, then the counter from 1.
        expect(m.nonce).toBe(toHex(security2Nonce(fromHex(c.nonce), i + 1)));
        if (m.direction === "toBoard") {
          expect(toHex(value(session.seal(fromHex(m.plaintext))) ?? new Uint8Array())).toBe(
            m.sealed,
          );
          expect(toHex(value(board.open(fromHex(m.sealed))) ?? new Uint8Array())).toBe(m.plaintext);
        } else {
          expect(toHex(value(board.seal(fromHex(m.plaintext))) ?? new Uint8Array())).toBe(m.sealed);
          expect(toHex(value(session.open(fromHex(m.sealed))) ?? new Uint8Array())).toBe(
            m.plaintext,
          );
        }
      }
    });
});

describe("a wrong code", () => {
  const wrongScript = script.cases.find((c) => c.wrongPassword !== null);

  test("command 0 does not use the code; command 1 is the one ESP-IDF refused; nothing opens", async () => {
    expect(wrongScript?.wrongPassword).toBe("X42SA94W");
    expect(wrongScript?.clientPrivates[0]).toBe(SIREN.clientPrivate);
    const steps = wrongScript?.steps ?? [];
    const wrong = await clientAt("sent0", "X42SA94W");
    const right = await clientAt("sent0");
    // Command 0 is the same with either code: the code is first used on response 0.
    expect(toHex(wrong.c0 ?? new Uint8Array())).toBe(steps[0]?.request ?? "");
    expect(toHex(right.c0 ?? new Uint8Array())).toBe(steps[0]?.request ?? "");
    const c1 = value(await wrong.client.command1(fromHex(steps[0]?.answer ?? "")));
    expect(toHex(c1 ?? new Uint8Array())).toBe(steps[1]?.request ?? "");
    expect(steps[1]?.answer).toBeNull();
    expect(steps[1]?.event).toBe("credentialsMismatch");
    // Even the right code's response 1, replayed, does not open a session for the wrong code.
    expect(error(await wrong.client.finish(fromHex(exchange.response1)))).toBe("wrongCode");
    // And the attempt is over.
    expect(error(await wrong.client.finish(fromHex(exchange.response1)))).toBe("protocol");
  });

  test("the retry on the same connection, with a new a, is the one ESP-IDF accepted", async () => {
    const steps = wrongScript?.steps ?? [];
    const client = startSecurity2(asCode(SIREN.password), {
      clientPrivate: fromHex(wrongScript?.clientPrivates[1] ?? ""),
    });
    expect(toHex(value(await client.command0()) ?? new Uint8Array())).toBe(steps[2]?.request ?? "");
    expect(
      toHex(value(await client.command1(fromHex(steps[2]?.answer ?? ""))) ?? new Uint8Array()),
    ).toBe(steps[3]?.request ?? "");
    const session = value(await client.finish(fromHex(steps[3]?.answer ?? "")));
    expect(
      toHex(
        value(session?.seal(Uint8Array.of(0xf1, 0x01)) ?? { ok: false, error: "protocol" }) ??
          new Uint8Array(),
      ),
    ).toBe(steps[4]?.request ?? "");
    const identity = session?.open(fromHex(steps[4]?.answer ?? ""));
    expect(
      toHex(
        identity === undefined ? new Uint8Array() : (value(identity) ?? new Uint8Array()),
      ).slice(0, 4),
    ).toBe("f102");
  });
});

describe("a byte changed at every position", () => {
  test("response 0: either refused, or a command 1 the board would refuse", async () => {
    const original = fromHex(exchange.response0);
    let refused = 0;
    for (let i = 0; i < original.length; i++) {
      const changed = original.slice();
      changed[i] = (changed[i] ?? 0) ^ 0x01;
      const { client } = await clientAt("sent0");
      const c1 = await client.command1(changed);
      if (!c1.ok) refused++;
      else expect(toHex(c1.value)).not.toBe(exchange.command1);
    }
    // The protobuf's own bytes, and a salt that is no longer 16 bytes, are refused outright.
    expect(refused).toBeGreaterThanOrEqual(10);
  }, 60_000);

  test("response 1: either refused, or a session whose first request the board would refuse", async () => {
    const original = fromHex(exchange.response1);
    const first = exchange.messages[0];
    for (let i = 0; i < original.length; i++) {
      const changed = original.slice();
      changed[i] = (changed[i] ?? 0) ^ 0x01;
      const { client } = await clientAt("sent1");
      const finished = await client.finish(changed);
      if (!finished.ok) {
        expect(["wrongCode", "protocol"]).toContain(finished.error);
        continue;
      }
      // Only the session id is not covered by the proofs: the request then differs.
      expect(i).toBeGreaterThanOrEqual(original.length - 12);
      expect(i).toBeLessThan(original.length - 4);
      const sealed = finished.value.seal(fromHex(first?.plaintext ?? ""));
      expect(toHex(value(sealed) ?? new Uint8Array())).not.toBe(first?.sealed);
    }
  });

  test("the board's proof changed at each byte is a wrong code", async () => {
    const r1 = decodeSessionData(fromHex(exchange.response1));
    expect(r1?.msg).toBe("response1");
    if (r1?.msg !== "response1") return;
    for (let i = 0; i < 64; i++) {
      const proof = r1.proof.slice();
      proof[i] = (proof[i] ?? 0) ^ 0x80;
      const { client } = await clientAt("sent1");
      expect(error(await client.finish(encodeSessionData({ ...r1, proof })))).toBe("wrongCode");
    }
  });

  test("every sealed answer, at every position, does not open and ends the session", () => {
    for (const m of exchange.messages.filter((x) => x.direction === "toPhone")) {
      const n = Number.parseInt(m.nonce.slice(16), 16);
      const sealed = fromHex(m.sealed);
      for (let i = 0; i < sealed.length; i++) {
        const phone = security2Session(
          fromHex(SIREN.sessionKey),
          security2Nonce(fromHex(exchange.nonce), n - 1),
        );
        phone.seal(Uint8Array.of(0));
        const changed = sealed.slice();
        changed[i] = (changed[i] ?? 0) ^ 0x01;
        expect(error(phone.open(changed))).toBe("decryptFailed");
        expect(error(phone.open(sealed))).toBe("protocol");
        expect(error(phone.seal(Uint8Array.of(0)))).toBe("protocol");
      }
      // The intact answer opens at its counter.
      const phone = security2Session(
        fromHex(SIREN.sessionKey),
        security2Nonce(fromHex(exchange.nonce), n - 1),
      );
      phone.seal(Uint8Array.of(0));
      expect(toHex(value(phone.open(sealed)) ?? new Uint8Array())).toBe(m.plaintext);
    }
  });

  test("a sealed answer cut short, or shorter than a tag", () => {
    const answer = fromHex(exchange.messages[1]?.sealed ?? "");
    for (const n of [0, 1, 15, 16, answer.length - 1]) {
      const phone = security2Session(fromHex(SIREN.sessionKey), fromHex(exchange.nonce));
      phone.seal(fromHex(exchange.messages[0]?.plaintext ?? ""));
      expect(error(phone.open(answer.slice(0, n)))).toBe("decryptFailed");
    }
  });
});

describe("replayed and reordered answers", () => {
  const key = fromHex(SIREN.sessionKey);
  const [up1, down1, up2, down2] = exchange.messages;
  const phone = (): Security2Session => security2Session(key, fromHex(exchange.nonce));

  test("in order, both open", () => {
    const s = phone();
    expect(value(s.seal(fromHex(up1?.plaintext ?? "")))).toBeDefined();
    expect(toHex(value(s.open(fromHex(down1?.sealed ?? ""))) ?? new Uint8Array())).toBe(
      down1?.plaintext ?? "",
    );
    expect(value(s.seal(fromHex(up2?.plaintext ?? "")))).toBeDefined();
    expect(toHex(value(s.open(fromHex(down2?.sealed ?? ""))) ?? new Uint8Array())).toBe(
      down2?.plaintext ?? "",
    );
  });

  test("the first answer again, in place of the second", () => {
    const s = phone();
    s.seal(fromHex(up1?.plaintext ?? ""));
    s.open(fromHex(down1?.sealed ?? ""));
    s.seal(fromHex(up2?.plaintext ?? ""));
    expect(error(s.open(fromHex(down1?.sealed ?? "")))).toBe("decryptFailed");
  });

  test("the second answer first", () => {
    const s = phone();
    s.seal(fromHex(up1?.plaintext ?? ""));
    expect(error(s.open(fromHex(down2?.sealed ?? "")))).toBe("decryptFailed");
  });

  test("an answer opened twice, or before any request", () => {
    const s = phone();
    expect(error(s.open(fromHex(down1?.sealed ?? "")))).toBe("protocol");
    const t = phone();
    t.seal(fromHex(up1?.plaintext ?? ""));
    t.open(fromHex(down1?.sealed ?? ""));
    expect(error(t.open(fromHex(down1?.sealed ?? "")))).toBe("protocol");
  });

  test("two requests without the answer between", () => {
    const s = phone();
    s.seal(fromHex(up1?.plaintext ?? ""));
    expect(error(s.seal(fromHex(up2?.plaintext ?? "")))).toBe("protocol");
  });
});

describe("the counter at its top, as security2.c has it", () => {
  test("the file is ESP-IDF's, from the siren's handshake", () => {
    expect(counter.source).toContain("ESP-IDF v6.1.1");
    expect(counter.srpCase).toBe(SIREN.name);
    expect(counter.key).toBe(SIREN.sessionKey.slice(0, 64));
    expect(counter.sessionId).toBe(exchange.nonce.slice(0, 16));
  });

  for (const c of counter.cases)
    test(c.name, () => {
      const nonce = security2Nonce(fromHex(counter.sessionId), c.startCounter);
      const phone = security2Session(fromHex(counter.key), nonce, "phone");
      const board = security2Session(fromHex(counter.key), nonce, "board");
      for (const m of c.messages) {
        expect(m.nonce).toBe(toHex(security2Nonce(fromHex(counter.sessionId), m.counter)));
        if (m.direction === "toBoard" && m.refused) {
          // The phone does not send it: at 0xffffffff its answer could not be sealed, and after
          // that the counter is 0.
          expect(error(phone.seal(fromHex(m.plaintext)))).toBe("decryptFailed");
          // The board, as security2.c: it opens at 0xffffffff and cannot seal; at 0 it opens nothing.
          if (m.counter === 0xffffffff) {
            expect(toHex(value(board.open(fromHex(m.sealed))) ?? new Uint8Array())).toBe(
              m.plaintext,
            );
            expect(error(board.seal(Uint8Array.of(0xf1)))).toBe("decryptFailed");
          } else {
            expect(m.counter).toBe(0);
            expect(error(board.open(fromHex(m.sealed)))).toBe("decryptFailed");
          }
          continue;
        }
        expect(m.refused).toBe(false);
        if (m.direction === "toBoard") {
          expect(toHex(value(phone.seal(fromHex(m.plaintext))) ?? new Uint8Array())).toBe(m.sealed);
          expect(toHex(value(board.open(fromHex(m.sealed))) ?? new Uint8Array())).toBe(m.plaintext);
        } else {
          expect(toHex(value(board.seal(fromHex(m.plaintext))) ?? new Uint8Array())).toBe(m.sealed);
          expect(toHex(value(phone.open(fromHex(m.sealed))) ?? new Uint8Array())).toBe(m.plaintext);
        }
      }
    });

  test("from 0xfffffffe the phone's last request is at fffffffe; from 0xffffffff it has none", () => {
    const key = fromHex(counter.key);
    const id = fromHex(counter.sessionId);
    const a = security2Session(key, security2Nonce(id, 0xfffffffe));
    expect(value(a.seal(Uint8Array.of(1)))).toBeDefined();
    const b = security2Session(key, security2Nonce(id, 0xffffffff));
    expect(error(b.seal(Uint8Array.of(1)))).toBe("decryptFailed");
    const z = security2Session(key, security2Nonce(id, 0));
    expect(error(z.seal(Uint8Array.of(1)))).toBe("protocol");
  });

  test("a key or nonce of the wrong size opens nothing", () => {
    const id = fromHex(counter.sessionId);
    expect(
      error(security2Session(new Uint8Array(31), security2Nonce(id, 1)).seal(Uint8Array.of(1))),
    ).toBe("protocol");
    expect(
      error(security2Session(fromHex(counter.key), new Uint8Array(11)).seal(Uint8Array.of(1))),
    ).toBe("protocol");
    // A 64-byte session key is used by its first 32 bytes.
    expect(
      toHex(
        value(
          security2Session(fromHex(SIREN.sessionKey), fromHex(exchange.nonce)).seal(
            fromHex("f101"),
          ),
        ) ?? new Uint8Array(),
      ),
    ).toBe(exchange.messages[0]?.sealed ?? "");
  });
});

describe("the handshake's order and the board's answers it refuses", () => {
  const r0 = decodeSessionData(fromHex(exchange.response0));
  const r1 = decodeSessionData(fromHex(exchange.response1));
  const response0 = (change: Partial<Extract<Sec2Message, { msg: "response0" }>>) =>
    r0?.msg === "response0" ? encodeSessionData({ ...r0, ...change }) : new Uint8Array();
  const response1 = (change: Partial<Extract<Sec2Message, { msg: "response1" }>>) =>
    r1?.msg === "response1" ? encodeSessionData({ ...r1, ...change }) : new Uint8Array();

  test("out of order, and once over, everything is protocol", async () => {
    const a = startSecurity2(asCode(SIREN.password));
    expect(error(await a.command1(fromHex(exchange.response0)))).toBe("protocol");
    expect(error(await a.command0())).toBe("protocol");
    const b = startSecurity2(asCode(SIREN.password));
    expect(error(await b.finish(fromHex(exchange.response1)))).toBe("protocol");
    const { client } = await clientAt("sent0");
    expect(error(await client.command0())).toBe("protocol");
    expect(error(await client.command1(fromHex(exchange.response0)))).toBe("protocol");
    const done = await clientAt("sent1");
    expect(value(await done.client.finish(fromHex(exchange.response1)))).toBeDefined();
    expect(error(await done.client.finish(fromHex(exchange.response1)))).toBe("protocol");
    expect(error(await done.client.command0())).toBe("protocol");
  });

  test("a random a by default: two attempts send different public values", async () => {
    const a = value(await startSecurity2(asCode(SIREN.password)).command0());
    const b = value(await startSecurity2(asCode(SIREN.password)).command0());
    expect(a).toBeDefined();
    expect(toHex(a ?? new Uint8Array())).not.toBe(toHex(b ?? new Uint8Array()));
    expect(a?.length).toBe(exchange.command0.length / 2);
  });

  test("a fixed a must be 32 bytes and not zero", async () => {
    for (const a of [new Uint8Array(31).fill(1), new Uint8Array(32), new Uint8Array(33).fill(1)])
      expect(
        error(await startSecurity2(asCode(SIREN.password), { clientPrivate: a }).command0()),
      ).toBe("protocol");
  });

  test("response 0: a status, a short salt, B = 0, B = N, the wrong message", async () => {
    const cases: [string, Uint8Array][] = [
      ["status 5", response0({ status: 5 })],
      ["salt of 15", response0({ salt: new Uint8Array(15).fill(3) })],
      ["no salt", response0({ salt: new Uint8Array(0) })],
      ["B = 0", response0({ publicKey: new Uint8Array(384) })],
      ["no B", response0({ publicKey: new Uint8Array(0) })],
      ["response 1 instead", fromHex(exchange.response1)],
      ["command 0 instead", fromHex(exchange.command0)],
      ["empty", new Uint8Array(0)],
    ];
    for (const [name, bytes] of cases) {
      const { client } = await clientAt("sent0");
      expect({ name, r: error(await client.command1(bytes)) }).toEqual({ name, r: "protocol" });
    }
    // The unchanged message re-encoded is the one ESP-IDF sent, and is taken.
    const { client } = await clientAt("sent0");
    expect(toHex(value(await client.command1(response0({}))) ?? new Uint8Array())).toBe(
      exchange.command1,
    );
  });

  test("response 1: a status, a short proof, a nonce of 11 or 13, a counter other than 1", async () => {
    const nonce = r1?.msg === "response1" ? r1.nonce : new Uint8Array(12);
    const withCounter = (n: number) =>
      Uint8Array.of(...nonce.slice(0, 8), ...security2Nonce(new Uint8Array(8), n).slice(8));
    const cases: [string, Uint8Array][] = [
      ["status 6", response1({ status: 6 })],
      [
        "proof of 63",
        response1({
          proof: (r1?.msg === "response1" ? r1.proof : new Uint8Array(64)).slice(0, 63),
        }),
      ],
      ["nonce of 11", response1({ nonce: nonce.slice(0, 11) })],
      ["nonce of 13", response1({ nonce: Uint8Array.of(...nonce, 0) })],
      ["counter 0", response1({ nonce: withCounter(0) })],
      ["counter 2", response1({ nonce: withCounter(2) })],
      ["response 0 instead", fromHex(exchange.response0)],
    ];
    for (const [name, bytes] of cases) {
      const { client } = await clientAt("sent1");
      expect({ name, r: error(await client.finish(bytes)) }).toEqual({ name, r: "protocol" });
    }
    const { client } = await clientAt("sent1");
    expect(value(await client.finish(response1({ nonce: withCounter(1) })))).toBeDefined();
  });
});
