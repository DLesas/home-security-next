/**
 * The ESP-IDF application image's layout (`shell/firmware/layout.ts`; docs/m3-updates-design.md
 * section 3): an image built to the layout as ESP-IDF v6.1.1's headers state it passes whole and
 * in any pieces; each way of breaking it is found, in the piece it is in.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ESP_HEAD_BYTES, EspLayout, readEspHead } from "../../../src/shell/firmware/layout.ts";
import { espImage } from "./support.ts";

function check(image: Uint8Array, piece = image.length): string | undefined {
  const layout = new EspLayout();
  for (let at = 0; at < image.length; at += piece) layout.add(image.subarray(at, at + piece));
  return layout.finish();
}

/** The image with its checksum and appended hash made right again after a change. */
function resealed(image: Uint8Array, hashAppended = true): Uint8Array {
  const out = image.slice();
  const end = hashAppended ? out.length - 32 : out.length;
  // One segment: data from 32 to the padding; the checksum is the byte before the hash.
  const length = new DataView(out.buffer).getUint32(28, true);
  let checksum = 0xef;
  for (let i = 32; i < 32 + length; i++) checksum ^= out[i] ?? 0;
  out[end - 1] = checksum;
  if (hashAppended) out.set(createHash("sha256").update(out.subarray(0, end)).digest(), end);
  return out;
}

describe("an image built to the layout", () => {
  test("passes whole, and in pieces of every size from one byte", () => {
    const image = espImage({ size: 3000, seed: 3 });
    expect(check(image)).toBeUndefined();
    for (const piece of [1, 2, 3, 7, 16, 24, 31, 32, 33, 255, 256, 1000, 4096])
      expect(check(image, piece)).toBeUndefined();
  });

  test("with several segments, with no appended hash, and of a slot's whole size", () => {
    expect(check(espImage({ segments: 3 }))).toBeUndefined();
    expect(check(espImage({ segments: 16 }))).toBeUndefined();
    expect(check(espImage({ hashAppended: 0 }))).toBeUndefined();
    expect(check(espImage({ size: 3_670_016 }), 256 * 1024)).toBeUndefined();
  });

  test("its checksum byte ends a 16-byte block and its hash is the SHA-256 of all before", () => {
    for (const size of [1000, 1001, 1002, 1003, 1017]) {
      const image = espImage({ size });
      const end = image.length - 32;
      expect(end % 16).toBe(0);
      expect(createHash("sha256").update(image.subarray(0, end)).digest()).toEqual(
        Buffer.from(image.subarray(end)),
      );
      expect(check(image)).toBeUndefined();
    }
  });

  test("its head gives the magic, the chip and the app description's version", () => {
    const image = espImage({ version: "12.0.255" });
    expect(readEspHead(image.subarray(0, ESP_HEAD_BYTES))).toEqual({
      magic: true,
      chip: 9,
      version: "12.0.255",
    });
    expect(readEspHead(espImage({ chip: 2 }))).toMatchObject({ magic: true, chip: 2 });
    expect(readEspHead(image.subarray(0, 23))).toEqual({
      magic: true,
      chip: undefined,
      version: undefined,
    });
    expect(readEspHead(image.subarray(0, ESP_HEAD_BYTES - 1)).version).toBeUndefined();
    expect(readEspHead(espImage({ appDescMagic: 0x12345678 })).version).toBeUndefined();
    const noEnd = image.slice();
    noEnd.fill(0x31, 48, 80);
    expect(readEspHead(noEnd).version).toBeUndefined();
    const notEsp = image.slice();
    notEsp[0] = 0xe8;
    expect(readEspHead(notEsp)).toEqual({ magic: false, chip: 9, version: undefined });
  });
});

describe("each way an image breaks the layout", () => {
  const good = espImage({ size: 2048, seed: 5 });
  const cases: readonly (readonly [string, (image: Uint8Array) => Uint8Array, string])[] = [
    [
      "a magic byte other than 0xE9",
      (i) => {
        const o = i.slice();
        o[0] = 0xe8;
        return o;
      },
      "not an ESP application image",
    ],
    [
      "another chip",
      (i) => {
        const o = i.slice();
        o[12] = 5;
        return o;
      },
      "an image for chip 5",
    ],
    [
      "no segment",
      (i) => {
        const o = i.slice();
        o[1] = 0;
        return o;
      },
      "0 segments: 1 to 16",
    ],
    [
      "seventeen segments",
      (i) => {
        const o = i.slice();
        o[1] = 17;
        return o;
      },
      "17 segments: 1 to 16",
    ],
    [
      "a hash-appended byte of 2",
      (i) => {
        const o = i.slice();
        o[23] = 2;
        return o;
      },
      "a hash-appended byte not 0 or 1",
    ],
    [
      "a segment length not a multiple of four",
      (i) => {
        const o = i.slice();
        new DataView(o.buffer).setUint32(28, new DataView(o.buffer).getUint32(28, true) + 1, true);
        return o;
      },
      "segment 0 is not whole words",
    ],
    [
      "a first segment too short for the app description",
      (i) => {
        const o = i.slice();
        new DataView(o.buffer).setUint32(28, 252, true);
        return o;
      },
      "the first segment holds no app description",
    ],
    [
      "a data byte changed (the checksum is wrong)",
      (i) => {
        const o = i.slice();
        o[400] = (o[400] ?? 0) ^ 0x01;
        return o;
      },
      "the image's checksum is wrong",
    ],
    [
      "the checksum byte changed",
      (i) => {
        const o = i.slice();
        const at = o.length - 33;
        o[at] = (o[at] ?? 0) ^ 0x80;
        return o;
      },
      "the image's checksum is wrong",
    ],
    [
      "a padding byte changed (the hash covers it)",
      (i) => {
        const o = i.slice();
        const at = o.length - 34;
        o[at] = (o[at] ?? 0) ^ 0x01;
        return o;
      },
      "the image's appended hash is wrong",
    ],
    [
      "the appended hash changed",
      (i) => {
        const o = i.slice();
        o[o.length - 1] = (o[o.length - 1] ?? 0) ^ 0x01;
        return o;
      },
      "the image's appended hash is wrong",
    ],
    ["cut by one byte", (i) => i.slice(0, -1), "the image is cut short"],
    ["cut inside the header", (i) => i.slice(0, 20), "the image is cut short"],
    ["cut inside a segment", (i) => i.slice(0, 500), "the image is cut short"],
    ["empty", () => new Uint8Array(0), "the image is cut short"],
    [
      "a byte after the image",
      (i) => {
        const o = new Uint8Array(i.length + 1);
        o.set(i, 0);
        return o;
      },
      "bytes after the image",
    ],
    [
      "a segment longer than the file",
      (i) => {
        const o = i.slice();
        new DataView(o.buffer).setUint32(28, 1 << 20, true);
        return o;
      },
      "the image is cut short",
    ],
  ];
  for (const [name, change, problem] of cases) {
    test(name, () => {
      const broken = change(good);
      expect(check(broken)).toBe(problem);
      expect(check(broken, 7)).toBe(problem);
    });
  }

  test("a data byte changed and the checksum and hash made right again passes: the check is the layout's", () => {
    const changed = good.slice();
    changed[1000] = (changed[1000] ?? 0) ^ 0xff;
    expect(check(changed)).toBe("the image's checksum is wrong");
    expect(check(resealed(changed))).toBeUndefined();
  });

  test("without an appended hash, the checksum alone is checked and the file ends after it", () => {
    const plain = espImage({ hashAppended: 0 });
    const changed = plain.slice();
    changed[300] = (changed[300] ?? 0) ^ 0x10;
    expect(check(changed)).toBe("the image's checksum is wrong");
    expect(check(resealed(changed, false))).toBeUndefined();
    const longer = new Uint8Array(plain.length + 32);
    longer.set(plain, 0);
    expect(check(longer)).toBe("bytes after the image");
  });
});
