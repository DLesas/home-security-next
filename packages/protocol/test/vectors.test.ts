/**
 * The committed vector files must be exactly what the generator writes, and must read back
 * through the library the way vectors/README.md describes.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Direction,
  encodeMessage,
  fromHex,
  hubIdentity,
  type MaxPacketLength,
  openPacket,
  packetNonce,
  toHex,
} from "../src/index.ts";
import { VECTOR_DIRECTORY } from "../scripts/generate-vectors.ts";
import { errorJson, fieldsJson, type Json } from "../scripts/vectors/json.ts";
import { DEVICE_VECTOR_FILES, vectorFiles } from "../scripts/vectors/files.ts";
import { APP_VECTOR_FILES } from "../src/app/vector-formats.ts";
import { RELAY_VECTOR_FILES } from "../src/relay/vector-formats.ts";

const generated = vectorFiles();
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(VECTOR_DIRECTORY, name), "utf8"));

describe("committed vectors", () => {
  test("the generator makes exactly its list, and every file beside them is the app's or the relay's", () => {
    expect([...generated.keys()].sort()).toEqual([...DEVICE_VECTOR_FILES].sort());
    const committed = readdirSync(VECTOR_DIRECTORY).filter((name) => name.endsWith(".json"));
    const device: ReadonlySet<string> = new Set(DEVICE_VECTOR_FILES);
    const app: ReadonlySet<string> = new Set(Object.keys(APP_VECTOR_FILES));
    // The relay's (m4-design.md section 11): their own generator and test in src/relay/vectors/.
    const relay: ReadonlySet<string> = new Set(Object.values(RELAY_VECTOR_FILES));
    for (const name of DEVICE_VECTOR_FILES)
      expect([name, committed.includes(name)]).toEqual([name, true]);
    expect(
      committed.filter((name) => !device.has(name) && !app.has(name) && !relay.has(name)),
    ).toEqual([]);
  });

  test.each([...generated.keys()])(
    "%s matches the generator (run `bun run vectors` to update)",
    (name) => {
      expect(readFileSync(join(VECTOR_DIRECTORY, name), "utf8")).toBe(generated.get(name) ?? "");
    },
  );
});

interface PacketVector {
  readonly name: string;
  readonly canonical: boolean;
  readonly key: string;
  readonly direction: Direction;
  readonly address: number;
  readonly counter: number;
  readonly binding: string;
  readonly maxLength: MaxPacketLength;
  readonly messageType: number;
  readonly fields: Json;
  readonly plaintext: string;
  readonly nonce: string;
  readonly associatedData: string;
  readonly packet: string;
}

interface RejectedVector {
  readonly name: string;
  readonly key: string;
  readonly expectedDirection: Direction;
  readonly binding: string;
  readonly maxLength: MaxPacketLength;
  readonly packet: string;
  readonly error: string;
  readonly messageType?: number;
}

// Shapes are fixed by the generator, which the tests above compare byte for byte.
const messageFiles = [...generated.keys()].filter(
  (name) => (read(name) as { messageType?: number }).messageType !== undefined,
);
const packetCases = messageFiles.flatMap((name) => (read(name) as { cases: PacketVector[] }).cases);
const rejected = (read("rejected-packets.json") as { packets: RejectedVector[] }).packets;

describe("valid packet vectors read back through the library", () => {
  test.each(packetCases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const opened = openPacket(fromHex(c.packet), {
      key: fromHex(c.key),
      expectedDirection: c.direction,
      binding: fromHex(c.binding),
      maxLength: c.maxLength,
    });
    if (!opened.ok) throw new Error(opened.error.code);
    const { header, message } = opened.value;
    expect(header).toEqual({ direction: c.direction, address: c.address, counter: c.counter });
    expect<number>(message.type).toBe(c.messageType);
    expect(fieldsJson(message)).toEqual(c.fields);
    expect(toHex(packetNonce(c.address, c.direction, c.counter))).toBe(c.nonce);
    expect(c.associatedData).toBe(c.packet.slice(0, 18) + c.binding);
    if (c.canonical) expect(toHex(encodeMessage(message))).toBe(c.plaintext);
  });
});

describe("rejected packet vectors are rejected with their error", () => {
  test.each(rejected.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const result = openPacket(fromHex(c.packet), {
      key: fromHex(c.key),
      expectedDirection: c.expectedDirection,
      binding: fromHex(c.binding),
      maxLength: c.maxLength,
    });
    if (result.ok) throw new Error("accepted");
    const expected: Json =
      c.messageType === undefined
        ? { error: c.error }
        : { error: c.error, messageType: c.messageType };
    expect(errorJson(result.error)).toEqual(expected);
  });
});

describe("cross-checks inside the vectors", () => {
  test("carried packets are other cases' packets, except the 255-byte one", () => {
    const allPackets = new Set(packetCases.map((c) => c.packet));
    const carried = packetCases.filter((c) => c.messageType === 0x21 || c.messageType === 0xa1);
    for (const c of carried) {
      const inner = (c.fields as { packet: string }).packet;
      if (inner.length === 2 * 255) expect(inner.slice(0, 2)).toBe("10");
      else expect(allPackets.has(inner)).toBe(true);
    }
  });

  test("the signing key is RFC 6979 A.2.5's, and each hub identity is computed from it", () => {
    const file = read("pairing-data.json") as {
      signingPrivateKey: string;
      valid: { name: string; fields: { hubIdentity: string; firmwareSigningKey: string } }[];
    };
    expect(file.signingPrivateKey).toBe(
      "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721",
    );
    const publicKey =
      "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6" +
      "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299";
    for (const { name, fields } of file.valid) {
      expect(fields.firmwareSigningKey).toBe(publicKey);
      const matches = fields.hubIdentity === toHex(hubIdentity(fromHex(publicKey)));
      expect(matches).toBe(!name.includes("does not match"));
    }
  });
});
