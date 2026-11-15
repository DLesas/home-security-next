/**
 * Sealing and opening a backup in pieces (docs/m2-design.md section 9): identical to the one-call
 * form for every way of cutting the input, refusals at the piece where each becomes knowable,
 * nothing released before its tag verifies, a bounded hold, and keys wiped.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "../bytes.ts";
import { BACKUP_FORMAT, type BackupHeader } from "./backup-interface.ts";
import {
  backupChunkAd,
  backupChunkNonce,
  backupCodec,
  backupFileKey,
  backupOpener,
  backupSealer,
  encodeBackupHeader,
  type PieceOpener,
  type PieceSealer,
} from "./backup.ts";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { backupVector, vectorFile } from "./vector-formats.ts";

const C = BACKUP_FORMAT.chunkBytes;
const S = C + 16;
const H = BACKUP_FORMAT.headerBytes;
const key = new Uint8Array(32).fill(9);
const header: BackupHeader = {
  format: 1,
  flags: 0,
  identity: new Uint8Array(16).fill(1),
  epoch: 2,
  madeMs: 1_794_096_000_000,
  schema: 2,
  salt: Uint8Array.from([8, 7, 6, 5, 4, 3, 2, 1]),
  lastChangeMs: 1_794_000_000_000,
};
const isZero = (b: Uint8Array) => b.every((x) => x === 0);

function db(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 13 + (i >>> 9)) & 0xff);
}

function oneCall(database: Uint8Array): Uint8Array {
  const file = backupCodec.seal(key, header, database);
  if (!file.ok) throw new Error(file.error);
  return file.value;
}

function sealer(): PieceSealer {
  const s = backupSealer(key, header);
  if (!s.ok) throw new Error(s.error);
  return s.value;
}

function opener(file: Uint8Array, withKey: Uint8Array = key): PieceOpener {
  const o = backupOpener(withKey, file.subarray(0, H));
  if (!o.ok) throw new Error(o.error);
  return o.value;
}

/** Cuts `bytes` into pieces of the sizes given, repeating the pattern. */
function pieces(bytes: Uint8Array, sizes: readonly number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const n = sizes[i % sizes.length] ?? 1;
    out.push(bytes.subarray(at, at + n));
    at += n;
  }
  return out;
}

function sealInPieces(database: Uint8Array, sizes: readonly number[]): Uint8Array {
  const s = sealer();
  const parts: Uint8Array[] = [s.headerBytes];
  for (const piece of pieces(database, sizes)) {
    const held = s.holding().bytes;
    const added = s.add(piece);
    if (!added.ok) throw new Error(added.error);
    const chunks = added.value;
    // Each call's work is bounded by its input: it seals only the chunks its bytes complete.
    expect(chunks.length).toBeLessThanOrEqual(Math.floor((held + piece.length) / C));
    expect(s.holding().bytes).toBeLessThanOrEqual(C);
    parts.push(...chunks);
  }
  const last = s.finish();
  if (!last.ok) throw new Error(last.error);
  parts.push(last.value);
  return Buffer.concat(parts);
}

/** Opens in pieces; the outcome, the plaintext released before it, and at which piece it failed. */
function openInPieces(file: Uint8Array, sizes: readonly number[]) {
  const o = opener(file);
  const released: Uint8Array[] = [];
  const body = pieces(file.subarray(H), sizes);
  for (const [i, piece] of body.entries()) {
    const held = o.holding().bytes;
    const r = o.add(piece);
    if (!r.ok) return { outcome: r.error, released: Buffer.concat(released), at: i, opener: o };
    expect(r.value.length).toBeLessThanOrEqual(Math.floor((held + piece.length) / S));
    expect(o.holding().bytes).toBeLessThanOrEqual(S);
    released.push(...r.value);
  }
  const last = o.finish();
  if (!last.ok) {
    return { outcome: last.error, released: Buffer.concat(released), at: body.length, opener: o };
  }
  released.push(last.value);
  return { outcome: "ok", released: Buffer.concat(released), at: body.length, opener: o };
}

const SIZES = [0, 1, 100, C - 1, C, C + 1, 2 * C, 2 * C + 1000, 3 * C];
const CUTS: readonly (readonly [string, readonly number[]])[] = [
  ["in one piece", [10 * S]],
  ["a chunk at a time", [C]],
  ["pieces straddling chunk ends", [C - 7, 15, C + 3]],
  ["odd pieces", [1, 4093, 65_537, 300]],
  ["256 KB pieces", [256 * 1024]],
];

describe("sealing in pieces gives exactly the one-call file", () => {
  for (const size of SIZES) {
    test.each(CUTS)(`a database of ${size} bytes, %s`, (_, sizes) => {
      const database = db(size);
      expect(toHex(sealInPieces(database, sizes))).toBe(toHex(oneCall(database)));
    });
  }

  test("one byte at a time", () => {
    for (const size of [0, 1, C, C + 1, 2 * C + 5]) {
      const database = db(size);
      expect(toHex(sealInPieces(database, [1]))).toBe(toHex(oneCall(database)));
    }
  });

  test("the vectors, in pieces, give their files byte for byte", () => {
    const vectors = vectorFile(backupVector).parse(
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "..", "vectors", "app-backup.json"), "utf8"),
      ),
    );
    for (const v of vectors.vectors) {
      const read = backupCodec.readHeader(fromHex(v.file));
      if (!read.ok) throw new Error(read.error);
      const s = backupSealer(fromHex(v.backupKey), read.value);
      if (!s.ok) throw new Error(s.error);
      const parts: Uint8Array[] = [s.value.headerBytes];
      for (const piece of pieces(fromHex(v.database), [C - 1, 3])) {
        const added = s.value.add(piece);
        if (!added.ok) throw new Error(added.error);
        parts.push(...added.value);
      }
      const last = s.value.finish();
      if (!last.ok) throw new Error(last.error);
      expect(toHex(Buffer.concat([...parts, last.value]))).toBe(v.file);
      // And every tampered file, opened in pieces, is refused as the vector says.
      for (const t of v.tamper) {
        const file = fromHex(t.file);
        const o = backupOpener(fromHex(v.backupKey), file.subarray(0, H));
        let outcome: string = o.ok ? "ok" : o.error;
        if (o.ok) {
          for (const piece of pieces(file.subarray(H), [C - 1, 3])) {
            const r = o.value.add(piece);
            if (!r.ok) {
              outcome = r.error;
              break;
            }
          }
          if (outcome === "ok") {
            const last = o.value.finish();
            outcome = last.ok ? "ok" : last.error;
          }
        }
        expect(outcome).toBe(t.expect);
      }
    }
  });

  test("after finish, add and finish are refused as finished; the key and the held bytes are wiped", () => {
    const s = sealer();
    expect(s.add(db(C + 10)).ok).toBe(true);
    expect(isZero(s.holding().key)).toBe(false);
    expect(s.finish().ok).toBe(true);
    expect(isZero(s.holding().key)).toBe(true);
    expect(isZero(s.holding().held)).toBe(true);
    const add = s.add(db(1));
    expect(add.ok ? "ok" : add.error).toBe("finished");
    const finish = s.finish();
    expect(finish.ok ? "ok" : finish.error).toBe("finished");
  });

  test("a bad key or header is refused at the start", () => {
    expect(backupSealer(new Uint8Array(31), header).ok).toBe(false);
    expect(backupSealer(key, { ...header, flags: 4 }).ok).toBe(false);
  });
});

describe("opening in pieces", () => {
  for (const size of SIZES) {
    test.each(CUTS)(`a database of ${size} bytes, %s`, (_, sizes) => {
      const database = db(size);
      const r = openInPieces(oneCall(database), sizes);
      expect(r.outcome).toBe("ok");
      expect(toHex(r.released)).toBe(toHex(database));
    });
  }

  test("one byte at a time", () => {
    const database = db(2 * C + 5);
    const r = openInPieces(oneCall(database), [1]);
    expect(r.outcome).toBe("ok");
    expect(toHex(r.released)).toBe(toHex(database));
  });

  const file = oneCall(db(2 * C + 1000));
  const h = file.subarray(0, H);
  const [c0, c1, c2] = [0, 1, 2].map((i) => file.subarray(H + i * S, H + (i + 1) * S));
  const chunked = (...parts: Uint8Array[]) => Buffer.concat([h, ...parts]);
  /** A chunk sealed by hand at a position with a chosen last-chunk byte. */
  const forged = (i: number, last: boolean, plain: Uint8Array) =>
    chacha20poly1305(
      backupFileKey(key, header.salt),
      backupChunkNonce(i),
      backupChunkAd(h, last),
    ).encrypt(plain);

  test("reordered chunks: refused at the piece that shows the first chunk is not chunk 0", () => {
    const r = openInPieces(chunked(c1 ?? h, c0 ?? h, c2 ?? h), [S]);
    expect([r.outcome, r.at, r.released.length]).toEqual(["decryptFailed", 1, 0]);
  });

  test("a repeated chunk: refused at the piece after the repeat", () => {
    const r = openInPieces(chunked(c0 ?? h, c1 ?? h, c1 ?? h, c2 ?? h), [S]);
    expect([r.outcome, r.at, r.released.length]).toEqual(["decryptFailed", 3, 2 * C]);
  });

  test("a missing last-chunk flag (cut at a chunk's end): cut at finish", () => {
    const r = openInPieces(chunked(c0 ?? h, c1 ?? h), [S]);
    expect([r.outcome, r.at, r.released.length]).toEqual(["cut", 2, C]);
  });

  test("a false last-chunk flag (a chunk marked last with more after it): refused when more comes", () => {
    const marked = forged(0, true, db(C));
    const r = openInPieces(chunked(marked, forged(1, true, db(10))), [S]);
    expect([r.outcome, r.at, r.released.length]).toEqual(["decryptFailed", 1, 0]);
  });

  test("data after a full last chunk: refused at the piece that brings it", () => {
    const full = oneCall(db(2 * C));
    const r = openInPieces(Buffer.concat([full, Uint8Array.of(0)]), [S]);
    expect([r.outcome, r.at, r.released.length]).toEqual(["decryptFailed", 2, C]);
  });

  test("data after a short last chunk: refused at finish, the only point it is knowable", () => {
    const r = openInPieces(Buffer.concat([file, Uint8Array.of(0)]), [S]);
    expect([r.outcome, r.at]).toEqual(["decryptFailed", 3]);
  });

  test("truncation: nothing after the header, or less than a tag, is truncated", () => {
    expect(openInPieces(h, [S]).outcome).toBe("truncated");
    expect(openInPieces(file.subarray(0, H + 2 * S + 10), [S]).outcome).toBe("truncated");
    expect(openInPieces(file.subarray(0, H + 2 * S + 500), [S]).outcome).toBe("decryptFailed");
  });

  test("nothing of a chunk is released before its tag verifies", () => {
    const bad = file.slice();
    bad[H + 2 * S - 1] = (bad[H + 2 * S - 1] ?? 0) ^ 1; // chunk 1's tag
    const r = openInPieces(bad, [1]);
    expect(r.outcome).toBe("decryptFailed");
    expect(toHex(r.released)).toBe(toHex(db(C)));
  });

  test("a failure wipes the key and the held bytes, and every later call is refused", () => {
    const r = openInPieces(chunked(c1 ?? h, c0 ?? h), [S]);
    expect(isZero(r.opener.holding().key)).toBe(true);
    expect(isZero(r.opener.holding().held)).toBe(true);
    const again = r.opener.add(c2 ?? h);
    expect(again.ok ? "ok" : again.error).toBe("finished");
    const finish = r.opener.finish();
    expect(finish.ok ? "ok" : finish.error).toBe("finished");
  });

  test("finish wipes the key; after it every call is refused", () => {
    const o = opener(file);
    expect(o.add(file.subarray(H)).ok).toBe(true);
    expect(isZero(o.holding().key)).toBe(false);
    expect(o.finish().ok).toBe(true);
    expect(isZero(o.holding().key)).toBe(true);
    expect(isZero(o.holding().held)).toBe(true);
    const add = o.add(new Uint8Array(1));
    expect(add.ok ? "ok" : add.error).toBe("finished");
    const finish = o.finish();
    expect(finish.ok ? "ok" : finish.error).toBe("finished");
  });

  test("a wrong key, and the header's own refusals, at the start", () => {
    const wrong = opener(file, new Uint8Array(32).fill(1));
    expect(wrong.add(file.subarray(H)).ok).toBe(false);
    expect(backupOpener(new Uint8Array(31), h).ok).toBe(false);
    expect(backupOpener(key, h.subarray(0, 63)).ok).toBe(false);
    expect(backupOpener(key, file.subarray(0, 65)).ok).toBe(false);
    const encoded = encodeBackupHeader(header);
    expect(encoded.ok && toHex(opener(file).header.salt)).toBe(toHex(header.salt));
  });
});
