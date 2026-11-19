/**
 * The ESP-IDF application image, as `idf.py build` writes it (docs/m3-updates-design.md section
 * 3: the hub's check of a release's payload and of an owner's own build). Read from ESP-IDF
 * v6.1.1's own headers and its image check (`bootloader_support/include/esp_app_format.h`,
 * `esp_app_format/include/esp_app_desc.h`, `bootloader_support/src/esp_image_format.c`), not
 * from a real build yet (step 3a):
 *
 * ```
 * 0    24  esp_image_header_t: magic 0xE9 (0), segment count (1), SPI mode, speed and size (2, 3),
 *          entry address (4), WP pin and drive (8), chip id u16 (12; 9 is the ESP32-S3), minimum
 *          revision (14), minimum and maximum full revision (15, 17), reserved (19),
 *          hash appended (23: 1 when a SHA-256 of the image follows the checksum)
 * then, per segment (1 to 16): esp_image_segment_header_t, load address u32 and data length u32
 *          (a multiple of 4), then the data. The first segment's data starts with the 256-byte
 *          esp_app_desc_t: magic word 0xABCD5432 (0), secure version (4), reserved (8), the
 *          application's version, 32 bytes NUL-terminated (16, so offset 48 in the image)
 * then     zero padding so that the checksum byte ends a 16-byte block; the checksum: 0xEF XORed
 *          with every byte of every segment's data (the bootloader XORs 32-bit words and folds
 *          the word, which is the same with lengths a multiple of 4); segment headers excluded
 * then     when hash appended: the SHA-256 of every byte before it, the checksum included
 * ```
 *
 * Nothing may follow: a file longer than its image is refused, as is one cut short. The check
 * runs in pieces (`EspLayout.add`), as the staging job reads the file. It is the layout only:
 * segment addresses, the chip's revisions and the flash settings are the bootloader's to judge
 * (its own check at `select()`, `imageCheck`).
 */
import { createHash, type Hash } from "node:crypto";

export const ESP_IMAGE = {
  magic: 0xe9,
  /** `ESP_CHIP_ID_ESP32S3`. */
  chipEsp32s3: 9,
  headerBytes: 24,
  chipIdOffset: 12,
  hashAppendedOffset: 23,
  segmentHeaderBytes: 8,
  maxSegments: 16,
  appDescBytes: 256,
  appDescMagic: 0xabcd5432,
  /** The app description's version string: 32 bytes at offset 16 of the first segment's data. */
  versionOffset: 24 + 8 + 16,
  versionBytes: 32,
  checksumSeed: 0xef,
  hashBytes: 32,
} as const;

/** The bytes `readEspHead` wants: the header, the first segment's header and the app description. */
export const ESP_HEAD_BYTES = ESP_IMAGE.headerBytes + ESP_IMAGE.segmentHeaderBytes + 256;

/** What the first bytes of an image say, read without checking the rest. */
export interface EspHead {
  /** The magic byte is 0xE9. */
  readonly magic: boolean;
  /** The chip id, or undefined when the file is shorter than the header. */
  readonly chip: number | undefined;
  /**
   * The app description's version string, when the first segment starts with an app description
   * (its magic word) and the string ends with a NUL inside its 32 bytes; undefined otherwise.
   */
  readonly version: string | undefined;
}

function u32At(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/** The image's magic, chip and app version, from its first `ESP_HEAD_BYTES` (or fewer) bytes. */
export function readEspHead(head: Uint8Array): EspHead {
  const magic = head[0] === ESP_IMAGE.magic;
  const chip =
    head.length >= ESP_IMAGE.headerBytes
      ? (head[ESP_IMAGE.chipIdOffset] ?? 0) | ((head[ESP_IMAGE.chipIdOffset + 1] ?? 0) << 8)
      : undefined;
  const desc = ESP_IMAGE.headerBytes + ESP_IMAGE.segmentHeaderBytes;
  if (!magic || head.length < desc + ESP_IMAGE.appDescBytes)
    return { magic, chip, version: undefined };
  if (u32At(head, desc) !== ESP_IMAGE.appDescMagic) return { magic, chip, version: undefined };
  const field = head.subarray(ESP_IMAGE.versionOffset, ESP_IMAGE.versionOffset + 32);
  const end = field.indexOf(0);
  if (end < 0) return { magic, chip, version: undefined };
  const text = new TextDecoder("utf-8", { fatal: false }).decode(field.subarray(0, end));
  return { magic, chip, version: text };
}

type Want =
  | { readonly kind: "header" }
  | { readonly kind: "segmentHeader"; readonly index: number }
  | { readonly kind: "segmentData"; readonly index: number; left: number }
  | { readonly kind: "padding"; left: number }
  | { readonly kind: "checksum" }
  | { readonly kind: "hash" }
  | { readonly kind: "end" };

/**
 * The layout check over the whole image, in order, a piece at a time: `add` each piece, then
 * `finish`. The first problem found is kept; later pieces are then ignored.
 */
export class EspLayout {
  #want: Want = { kind: "header" };
  /** Bytes of a fixed-size part (the header, a segment header, the hash) gathered so far. */
  #held = new Uint8Array(0);
  #segments = 0;
  #hashAppended = false;
  #checksum: number = ESP_IMAGE.checksumSeed;
  /** Bytes taken so far: every byte up to the checksum is in the appended hash. */
  #at = 0;
  readonly #hash: Hash = createHash("sha256");
  #problem: string | undefined;

  /** The first problem found, if any. */
  get problem(): string | undefined {
    return this.#problem;
  }

  add(piece: Uint8Array): void {
    let at = 0;
    while (at < piece.length && this.#problem === undefined) {
      at += this.#take(piece.subarray(at));
    }
  }

  /** The file has ended: undefined when the image is whole and right, else what is wrong. */
  finish(): string | undefined {
    if (this.#problem !== undefined) return this.#problem;
    if (this.#want.kind !== "end") return "the image is cut short";
    return undefined;
  }

  #fail(problem: string): number {
    this.#problem = problem;
    return 0;
  }

  /** Gathers a fixed-size part; the part when whole, else undefined and the bytes taken. */
  #gather(bytes: Uint8Array, size: number): { taken: number; whole: Uint8Array | undefined } {
    const need = size - this.#held.length;
    const part = bytes.subarray(0, need);
    const held = new Uint8Array(this.#held.length + part.length);
    held.set(this.#held, 0);
    held.set(part, this.#held.length);
    if (held.length < size) {
      this.#held = held;
      return { taken: part.length, whole: undefined };
    }
    this.#held = new Uint8Array(0);
    return { taken: part.length, whole: held };
  }

  /** Hashes what is part of the image before its appended hash. */
  #covered(bytes: Uint8Array): void {
    this.#hash.update(bytes);
    this.#at += bytes.length;
  }

  #take(bytes: Uint8Array): number {
    const want = this.#want;
    switch (want.kind) {
      case "header": {
        const { taken, whole } = this.#gather(bytes, ESP_IMAGE.headerBytes);
        this.#covered(bytes.subarray(0, taken));
        if (whole === undefined) return taken;
        if (whole[0] !== ESP_IMAGE.magic) return this.#fail("not an ESP application image");
        const chip = (whole[12] ?? 0) | ((whole[13] ?? 0) << 8);
        if (chip !== ESP_IMAGE.chipEsp32s3) return this.#fail(`an image for chip ${chip}`);
        const segments = whole[1] ?? 0;
        if (segments < 1 || segments > ESP_IMAGE.maxSegments)
          return this.#fail(`${segments} segments: 1 to ${ESP_IMAGE.maxSegments}`);
        const appended = whole[ESP_IMAGE.hashAppendedOffset];
        if (appended !== 0 && appended !== 1) return this.#fail("a hash-appended byte not 0 or 1");
        this.#segments = segments;
        this.#hashAppended = appended === 1;
        this.#want = { kind: "segmentHeader", index: 0 };
        return taken;
      }
      case "segmentHeader": {
        const { taken, whole } = this.#gather(bytes, ESP_IMAGE.segmentHeaderBytes);
        this.#covered(bytes.subarray(0, taken));
        if (whole === undefined) return taken;
        const length = u32At(whole, 4);
        if (length % 4 !== 0) return this.#fail(`segment ${want.index} is not whole words`);
        if (want.index === 0 && length < ESP_IMAGE.appDescBytes)
          return this.#fail("the first segment holds no app description");
        this.#want =
          length === 0
            ? this.#afterSegment(want.index)
            : { kind: "segmentData", index: want.index, left: length };
        return taken;
      }
      case "segmentData": {
        const part = bytes.subarray(0, want.left);
        for (const byte of part) this.#checksum ^= byte;
        this.#covered(part);
        want.left -= part.length;
        if (want.left === 0) this.#want = this.#afterSegment(want.index);
        return part.length;
      }
      case "padding": {
        const part = bytes.subarray(0, want.left);
        this.#covered(part);
        want.left -= part.length;
        if (want.left === 0) this.#want = { kind: "checksum" };
        return part.length;
      }
      case "checksum": {
        const byte = bytes[0] ?? 0;
        this.#covered(bytes.subarray(0, 1));
        if (byte !== this.#checksum) return this.#fail("the image's checksum is wrong");
        this.#want = this.#hashAppended ? { kind: "hash" } : { kind: "end" };
        return 1;
      }
      case "hash": {
        const { taken, whole } = this.#gather(bytes, ESP_IMAGE.hashBytes);
        if (whole === undefined) return taken;
        const digest = new Uint8Array(this.#hash.digest());
        if (!digest.every((b, i) => b === whole[i]))
          return this.#fail("the image's appended hash is wrong");
        this.#want = { kind: "end" };
        return taken;
      }
      case "end":
        return this.#fail("bytes after the image");
    }
  }

  /** What comes after segment `index`: the next segment, or the padding before the checksum. */
  #afterSegment(index: number): Want {
    if (index + 1 < this.#segments) return { kind: "segmentHeader", index: index + 1 };
    // The checksum byte ends a 16-byte block: the image so far plus padding plus it.
    const left = (16 - ((this.#at + 1) % 16)) % 16;
    return left === 0 ? { kind: "checksum" } : { kind: "padding", left };
  }
}
