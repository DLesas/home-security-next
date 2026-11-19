/**
 * The hand-written protobuf (protobuf.ts) against the bytes ESP-IDF's protobuf-c made
 * (`pairing-security2.json`, `pairing-board-script.json`), and its strictness edge by edge.
 */
import { describe, expect, test } from "bun:test";
import { fromHex, toHex } from "../bytes.ts";
import { decodeSessionData, encodeSessionData, type Sec2Message } from "./protobuf.ts";
import { espIdfVectors } from "./vectors/esp-idf-vectors.ts";

const { security2, script } = espIdfVectors();
const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe("security 2's messages, byte for byte as protobuf-c makes them", () => {
  test("every command and response of every exchange decodes and encodes back exactly", () => {
    for (const c of security2.cases) {
      for (const [field, msg] of [
        ["command0", "command0"],
        ["response0", "response0"],
        ["command1", "command1"],
        ["response1", "response1"],
      ] as const) {
        const message = decodeSessionData(fromHex(c[field]));
        expect(message?.msg).toBe(msg);
        if (message === undefined) continue;
        expect(toHex(encodeSessionData(message))).toBe(c[field]);
      }
    }
  });

  test("every prov-session write the board took, and every answer, reads as a message", () => {
    let n = 0;
    for (const s of script.cases)
      for (const step of s.steps) {
        if (step.endpoint !== "prov-session" || step.answer === null) continue;
        expect(decodeSessionData(fromHex(step.request))).toBeDefined();
        expect(decodeSessionData(fromHex(step.answer))).toBeDefined();
        n++;
      }
    expect(n).toBe(12);
  });

  test("the fields, as the board's response 0 has them", () => {
    const r0 = decodeSessionData(fromHex(security2.cases[0].response0));
    expect(r0?.msg).toBe("response0");
    if (r0?.msg !== "response0") return;
    expect(r0.status).toBe(0);
    expect(r0.publicKey).toHaveLength(384);
    expect(r0.salt).toHaveLength(16);
  });

  test("proto3: zero and empty values are left out, the oneof's message is always written", () => {
    // msg 0 (Command0) and an empty user name are left out; sc0 (20) stays, empty.
    const m: Sec2Message = { msg: "command0", username: bytes(), publicKey: bytes() };
    expect(toHex(encodeSessionData(m))).toBe("10026203a20100");
    expect(decodeSessionData(fromHex("10026203a20100"))).toEqual(m);
    // Status 0 is left out; status 1 is written.
    const r: Sec2Message = { msg: "response1", status: 1, proof: bytes(7), nonce: bytes() };
    expect(toHex(encodeSessionData(r))).toBe("1002620a0803ba01050801120107");
    expect(decodeSessionData(encodeSessionData(r))).toEqual(r);
    // A field written though zero reads as zero.
    expect(decodeSessionData(fromHex("100262070800a201021200"))).toEqual({
      msg: "command0",
      username: bytes(),
      publicKey: bytes(),
    });
  });

  test("long values: a 384-byte key's length takes two bytes", () => {
    const key = new Uint8Array(384).fill(0xab);
    const m: Sec2Message = { msg: "command0", username: bytes(0x68), publicKey: key };
    const encoded = encodeSessionData(m);
    // Payload 394 bytes (8a 03), sc0 390 (86 03), the key 384 (80 03).
    expect(toHex(encoded.slice(0, 12))).toBe("1002628a03a20186030a0168");
    expect(toHex(encoded.slice(12, 15))).toBe("128003");
    expect(decodeSessionData(encoded)).toEqual(m);
  });
});

describe("reading is strict", () => {
  const good = encodeSessionData({ msg: "command1", proof: new Uint8Array(64).fill(1) });

  test("the good message reads", () => {
    expect(decodeSessionData(good)?.msg).toBe("command1");
  });

  test("not security 2: version missing, version 1, sec0 or sec1 in place of sec2", () => {
    const inner = good.slice(2);
    expect(decodeSessionData(inner)).toBeUndefined();
    expect(decodeSessionData(Uint8Array.from([0x10, 0x01, ...inner]))).toBeUndefined();
    expect(decodeSessionData(fromHex("1002"))).toBeUndefined();
    // Field 10 (sec0) or 11 (sec1) instead of 12.
    expect(
      decodeSessionData(Uint8Array.from([0x10, 0x02, 0x52, ...inner.slice(1)])),
    ).toBeUndefined();
    expect(
      decodeSessionData(Uint8Array.from([0x10, 0x02, 0x5a, ...inner.slice(1)])),
    ).toBeUndefined();
  });

  test("a payload that does not match msg, none, or two", () => {
    // msg 2 (Command1) with sc0 (20).
    expect(decodeSessionData(fromHex("100262050802a20100"))).toBeUndefined();
    // msg 2 with sc1 reads; msg 10 is no message.
    expect(decodeSessionData(fromHex("100262050802b20100"))).toEqual({
      msg: "command1",
      proof: bytes(),
    });
    expect(decodeSessionData(fromHex("10026205080ab20100"))).toBeUndefined();
    // msg 2 and no payload.
    expect(decodeSessionData(fromHex("100262020802"))).toBeUndefined();
    // msg 2 with sc1 and sr1.
    expect(decodeSessionData(fromHex("100262080802b20100ba0100"))).toBeUndefined();
    // msg 4: no such message.
    expect(decodeSessionData(fromHex("100262050804b20100"))).toBeUndefined();
  });

  test("a field not listed, twice, or of the wrong wire type", () => {
    // Command1 with field 2 as well.
    expect(decodeSessionData(fromHex("1002620b0802b201060a01011201ff"))).toBeUndefined();
    // The same without it reads.
    expect(decodeSessionData(fromHex("100262080802b201030a0101"))).toEqual({
      msg: "command1",
      proof: bytes(1),
    });
    // client_proof twice.
    expect(decodeSessionData(fromHex("1002620b0802b201060a01010a0102"))).toBeUndefined();
    // client_proof as a varint.
    expect(decodeSessionData(fromHex("100262070802b201020801"))).toBeUndefined();
    // sec_ver twice.
    expect(decodeSessionData(fromHex("1002100262050802b20100"))).toBeUndefined();
    // A 64-bit or 32-bit field.
    expect(decodeSessionData(fromHex("1002620e0802b20109090102030405060708"))).toBeUndefined();
    expect(decodeSessionData(fromHex("1002620a0802b201050d01020304"))).toBeUndefined();
  });

  test("cut short, a length past the end, bytes left over, varints too long", () => {
    for (let n = 0; n < good.length; n++)
      expect({ n, m: decodeSessionData(good.slice(0, n)) }).toEqual({ n, m: undefined });
    expect(decodeSessionData(Uint8Array.from([...good, 0x00]))).toBeUndefined();
    // A varint of 6 bytes, and one over 32 bits in 5.
    expect(decodeSessionData(fromHex("10828080808000"))).toBeUndefined();
    expect(decodeSessionData(fromHex("108280808010"))).toBeUndefined();
    // A status of 2^32, which protobuf-c would cut to 32 bits and read as 0, Success: refused.
    expect(decodeSessionData(fromHex("1002620d0801aa01080880808080101200"))).toBeUndefined();
    expect(decodeSessionData(fromHex("1002620d0801aa010808ffffffff0f1200"))).toEqual({
      msg: "response0",
      status: 0xffffffff,
      publicKey: bytes(),
      salt: bytes(),
    });
    // The largest 5-byte varint is read (as a sec_ver that is not 2).
    expect(decodeSessionData(fromHex("10ffffffff0f"))).toBeUndefined();
  });
});
