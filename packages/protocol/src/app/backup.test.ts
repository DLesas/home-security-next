/**
 * The backup file (docs/m2-design.md section 9) against app-backup.json, and the rules the
 * vectors cannot show: a wrong key, the header's layout field by field, the chunk boundaries.
 */
import { describe, expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "../bytes.ts";
import {
  BACKUP_FLAGS,
  BACKUP_KNOWN_FLAGS,
  BACKUP_FORMAT,
  BACKUP_HEADER_LAYOUT,
  type BackupHeader,
} from "./backup-interface.ts";
import { backupChunkNonce, backupCodec, backupFileKey, encodeBackupHeader } from "./backup.ts";
import { backupVector, vectorFile } from "./vector-formats.ts";

const vectors = vectorFile(backupVector).parse(
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "vectors", "app-backup.json"), "utf8")),
);

const key = new Uint8Array(32).fill(7);
const header: BackupHeader = {
  format: 1,
  flags: 0,
  identity: new Uint8Array(16).fill(0xab),
  epoch: 0x0102_0304,
  madeMs: 0x0102_0304_0506,
  schema: 0x0a0b_0c0d,
  salt: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
  lastChangeMs: 0x0605_0403_0201,
};

function sealed(db: Uint8Array, h: BackupHeader = header): Uint8Array {
  const file = backupCodec.seal(key, h, db);
  if (!file.ok) throw new Error(file.error);
  return file.value;
}

function opened(file: Uint8Array, withKey: Uint8Array = key): string {
  const result = backupCodec.open(withKey, file);
  return result.ok ? `ok ${toHex(result.value.database)}` : result.error;
}

describe("app-backup.json", () => {
  test("covers one chunk, an empty database, a full chunk and three chunks", () => {
    expect(vectors.vectors.length).toBe(4);
    const expects = new Set<string>(vectors.vectors.flatMap((v) => v.tamper.map((t) => t.expect)));
    expect([...expects].toSorted()).toEqual(
      ["badFormat", "badMagic", "cut", "decryptFailed", "truncated"].toSorted(),
    );
  });

  test.each(vectors.vectors.map((v) => [v.name, v] as const))("%s", (_, v) => {
    const backupKey = fromHex(v.backupKey);
    const read = backupCodec.readHeader(fromHex(v.file));
    if (!read.ok) throw new Error(read.error);
    const encoded = encodeBackupHeader(read.value);
    expect(encoded.ok && toHex(encoded.value)).toBe(v.header);
    const file = backupCodec.seal(backupKey, read.value, fromHex(v.database));
    expect(file.ok && toHex(file.value)).toBe(v.file);
    expect(opened(fromHex(v.file), backupKey)).toBe(`ok ${v.database}`);
    for (const t of v.tamper) expect(opened(fromHex(t.file), backupKey)).toBe(t.expect);
  });

  test("the file key is RFC 5869's HKDF-SHA256, as Node computes it; the nonce is big-endian", () => {
    // Bun's node:crypto has no ChaCha20-Poly1305, so only the key and the nonce are checked
    // against another implementation; the chunks against @noble/ciphers above.
    for (const v of vectors.vectors) {
      const salt = fromHex(v.header).subarray(38, 46);
      const node = new Uint8Array(
        hkdfSync("sha256", fromHex(v.backupKey), salt, "hsn-backup/1", 32),
      );
      expect(toHex(backupFileKey(fromHex(v.backupKey), salt))).toBe(toHex(node));
    }
    expect(toHex(backupChunkNonce(0x0102))).toBe("000000000000000000000102");
  });
});

describe("the header (section 9)", () => {
  test("each field at the offset BACKUP_HEADER_LAYOUT gives, little-endian", () => {
    const encoded = encodeBackupHeader(header);
    if (!encoded.ok) throw new Error(encoded.error);
    const bytes = encoded.value;
    const field = (name: string) => {
      const entry = BACKUP_HEADER_LAYOUT.find(([n]) => n === name);
      return entry === undefined ? "" : toHex(bytes.subarray(entry[1], entry[1] + entry[2]));
    };
    expect(bytes.length).toBe(64);
    expect(field("magic")).toBe(toHex(new TextEncoder().encode("HSNB")));
    expect(field("format")).toBe("01");
    expect(field("flags")).toBe("00");
    expect(field("identity")).toBe("ab".repeat(16));
    expect(field("epoch")).toBe("04030201");
    expect(field("madeMs")).toBe("0605040302010000");
    expect(field("schema")).toBe("0d0c0b0a");
    expect(field("salt")).toBe("0102030405060708");
    expect(field("lastChangeMs")).toBe("0102030405060000");
    expect(field("reserved")).toBe("00".repeat(10));
  });

  test("flag bit 0 is retired: no flag is known, and a header with it set is refused", () => {
    expect(BACKUP_KNOWN_FLAGS).toBe(0);
    expect(Object.keys(BACKUP_FLAGS)).toEqual([]);
    expect(encodeBackupHeader({ ...header, flags: 1 }).ok).toBe(false);
    const file = sealed(new Uint8Array(5));
    for (const bit of [0x01, 0x02, 0x80]) {
      const flagged = file.slice();
      flagged[5] = bit;
      const read = backupCodec.readHeader(flagged);
      expect(read.ok ? "ok" : read.error).toBe("badFormat");
      expect(opened(flagged)).toBe("badFormat");
    }
  });

  test("reads back what it wrote", () => {
    const read = backupCodec.readHeader(sealed(new Uint8Array(5)));
    expect(read.ok && read.value).toEqual(header);
  });

  test("a header that cannot be written is refused", () => {
    const bad: Partial<BackupHeader>[] = [
      { format: 2 },
      { flags: 1 },
      { flags: 2 },
      { flags: -1 },
      { identity: new Uint8Array(15) },
      { salt: new Uint8Array(9) },
      { epoch: 2 ** 32 },
      { schema: -1 },
      { madeMs: 2 ** 53 },
      { lastChangeMs: 1.5 },
    ];
    for (const change of bad) {
      const result = backupCodec.seal(key, { ...header, ...change }, new Uint8Array(1));
      expect(result.ok ? "accepted" : result.error).toBe("badFormat");
    }
    expect(backupCodec.seal(new Uint8Array(31), header, new Uint8Array(1)).ok).toBe(false);
  });
});

describe("chunks (section 9)", () => {
  test("a wrong backup key is refused", () => {
    expect(opened(sealed(new Uint8Array(100)), new Uint8Array(32).fill(8))).toBe("decryptFailed");
    expect(opened(sealed(new Uint8Array(100)), new Uint8Array(31))).toBe("decryptFailed");
  });

  test("each size around a chunk's end gives the chunks it should, and reads back", () => {
    const C = BACKUP_FORMAT.chunkBytes;
    for (const [size, chunks] of [
      [0, 1],
      [1, 1],
      [C - 1, 1],
      [C, 1],
      [C + 1, 2],
      [2 * C, 2],
    ] as const) {
      const db = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
      const file = sealed(db);
      expect(file.length).toBe(64 + size + 16 * chunks);
      expect(opened(file)).toBe(`ok ${toHex(db)}`);
    }
  });

  test("a file cut at each chunk's end is refused as cut, and nowhere is it accepted", () => {
    const C = BACKUP_FORMAT.chunkBytes + 16;
    const file = sealed(new Uint8Array(3 * BACKUP_FORMAT.chunkBytes + 10));
    expect(opened(file.slice(0, 64 + C))).toBe("cut");
    expect(opened(file.slice(0, 64 + 2 * C))).toBe("cut");
    expect(opened(file.slice(0, 64 + 3 * C))).toBe("cut");
    for (const end of [64 + 1, 64 + 16, 64 + C - 1, 64 + C + 17, file.length - 1]) {
      expect(opened(file.slice(0, end)).startsWith("ok")).toBe(false);
    }
  });
});
