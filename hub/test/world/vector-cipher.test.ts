/**
 * The vector cipher against the protocol package's vector files (hub-design.md section 11):
 * every to-hub case opens to its message, and every canonical from-hub case seals to its exact
 * bytes, through the `DeviceCipher` interface the core uses.
 */
import { describe, expect, test } from "bun:test";
import { decodeMessage, Direction, toHex } from "@hsn/protocol";
import { deviceId } from "../../src/core/model/ids.ts";
import { VectorCipher } from "./vector-cipher.ts";
import { packetVectors } from "./vectors.ts";

const cipher = VectorCipher.fromVectors();
const vectors = packetVectors();

describe("the vector cipher", () => {
  test("knows every address of the vector files, each with its one key", () => {
    const addresses = new Set(vectors.map((v) => v.address));
    expect(cipher.devices.map((d) => d.address).sort()).toEqual([...addresses].sort());
    for (const v of vectors)
      expect(toHex(cipher.deviceFor(v.address)?.key ?? new Uint8Array())).toBe(toHex(v.key));
  });

  const toHub = vectors.filter((v) => v.direction === Direction.ToHub);
  test.each(toHub.map((v) => [`${v.file} › ${v.name}`, v] as const))("opens %s", (_, v) => {
    const device = cipher.deviceFor(v.address)?.device ?? deviceId(-1);
    const opened = cipher.open(device, v.packet, { binding: v.binding, maxLength: v.maxLength });
    const expected = decodeMessage(v.plaintext);
    expect(expected.ok).toBe(true);
    expect(opened.isOk()).toBe(true);
    if (!expected.ok || opened.isErr()) return;
    expect(opened.value.header.counter).toBe(v.counter);
    expect(opened.value.message).toEqual(expected.value);
  });

  const fromHub = vectors.filter((v) => v.direction === Direction.FromHub && v.canonical);
  test.each(fromHub.map((v) => [`${v.file} › ${v.name}`, v] as const))("seals %s", (_, v) => {
    const device = cipher.deviceFor(v.address)?.device ?? deviceId(-1);
    const message = decodeMessage(v.plaintext);
    expect(message.ok).toBe(true);
    if (!message.ok) return;
    const sealed = cipher.seal(device, message.value, {
      direction: Direction.FromHub,
      address: v.address,
      counter: v.counter,
      binding: v.binding,
      maxLength: v.maxLength,
    });
    expect(sealed.isOk() && toHex(sealed.value)).toBe(toHex(v.packet));
  });

  test("an unknown device fails as the design says: badTag to open, a crypto error to seal", () => {
    const [first] = toHub;
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(
      cipher
        .open(deviceId(999), first.packet, { binding: first.binding, maxLength: first.maxLength })
        .isErr(),
    ).toBe(true);
    const sealed = cipher.seal(
      deviceId(999),
      { type: 0x82 },
      {
        direction: Direction.FromHub,
        address: 1,
        counter: 1,
        binding: new Uint8Array(4),
        maxLength: 255,
      },
    );
    expect(sealed.isErr() && sealed.error.kind).toBe("crypto");
  });

  test("a bad binding is an error, not an exception", () => {
    const device = cipher.devices[0]?.device ?? deviceId(-1);
    const sealed = cipher.seal(
      device,
      { type: 0x82 },
      {
        direction: Direction.FromHub,
        address: 1,
        counter: 1,
        binding: new Uint8Array(3),
        maxLength: 255,
      },
    );
    expect(sealed.isErr() && sealed.error.message).toContain("binding");
  });
});
