/** Random bytes into every decoder: none may throw, whatever arrives. Seeded, so repeatable. */
import { describe, expect, test } from "bun:test";
import {
  cobsDecode,
  concatBytes,
  decodeMessage,
  decodePairingData,
  decodeReplayWindow,
  decodeSetupMessage,
  Direction,
  MaxPacketLength,
  MessageType,
  NO_BINDING,
  openPacket,
  readPacketHeader,
  sealPacket,
  UsbFrameDecoder,
} from "../src/index.ts";
import { sealRaw } from "../scripts/vectors/packets.ts";

/** Mulberry32: a tiny deterministic generator, good enough to spread test inputs. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const next = random(0x5eed);
const randomBytes = (maxLength: number): Uint8Array =>
  Uint8Array.from({ length: Math.floor(next() * (maxLength + 1)) }, () => Math.floor(next() * 256));

const key = new Uint8Array(16).fill(7);
const device = { key, address: 0x01020304 };
const ITERATIONS = 3000;

describe("fuzz", () => {
  test("header parsing and opening never throw", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const bytes = randomBytes(300);
      if (bytes.length > 0 && next() < 0.5) bytes[0] = next() < 0.5 ? 0x10 : 0x18;
      for (const maxLength of [MaxPacketLength.Radio, MaxPacketLength.Link]) {
        readPacketHeader(bytes, maxLength);
        for (const expectedDirection of [Direction.ToHub, Direction.FromHub]) {
          const result = openPacket(bytes, {
            key,
            expectedDirection,
            binding: NO_BINDING,
            maxLength,
          });
          expect(result.ok).toBe(false);
        }
      }
    }
  });

  test("every body decoder never throws", () => {
    for (const type of Object.values(MessageType)) {
      for (let i = 0; i < ITERATIONS / 10; i++) {
        decodeMessage(concatBytes(Uint8Array.of(type), randomBytes(80)));
      }
    }
    for (let i = 0; i < ITERATIONS; i++) decodeMessage(randomBytes(80));
  });

  test("authenticated random plaintexts never make opening throw", () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const plaintext = randomBytes(60);
      const { packet } = sealRaw({
        device,
        direction: Direction.ToHub,
        counter: 1 + i,
        binding: NO_BINDING,
        plaintext,
      });
      const opened = openPacket(packet, {
        key,
        expectedDirection: Direction.ToHub,
        binding: NO_BINDING,
        maxLength: 255,
      });
      if (plaintext.length === 0)
        expect(opened).toEqual({ ok: false, error: { code: "truncated" } });
    }
  });

  test("a valid packet with any one byte changed is refused", () => {
    for (let i = 0; i < ITERATIONS / 3; i++) {
      const packet = sealPacket(
        { type: MessageType.SirenCommand, action: 1, soundSeconds: i },
        {
          key,
          direction: Direction.FromHub,
          address: 1 + i,
          counter: 1 + i,
          binding: NO_BINDING,
          maxLength: 255,
        },
      );
      const index = Math.floor(next() * packet.length);
      packet[index] = (packet[index] ?? 0) ^ (1 + Math.floor(next() * 255));
      const result = openPacket(packet, {
        key,
        expectedDirection: Direction.FromHub,
        binding: NO_BINDING,
        maxLength: 255,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("USB, setup, pairing and stored-state decoders never throw", () => {
    const frames = new UsbFrameDecoder();
    for (let i = 0; i < ITERATIONS; i++) {
      const bytes = randomBytes(200);
      cobsDecode(bytes);
      frames.push(bytes);
      decodeSetupMessage(bytes);
      decodeSetupMessage(concatBytes(Uint8Array.of(0xf1, 1 + Math.floor(next() * 5)), bytes));
      decodePairingData(bytes);
      decodePairingData(concatBytes(Uint8Array.of(1), bytes));
      decodeReplayWindow(bytes.subarray(0, 12));
    }
  });
});
