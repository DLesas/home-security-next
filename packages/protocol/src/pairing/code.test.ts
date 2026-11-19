/**
 * The pairing code, the board's QR code and the advertisement (code.ts): the check characters
 * pinned by hand, every malformed form refused with its reason, every single-character mistake
 * and adjacent swap caught, and the vector files read case by case.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex, toHex } from "../bytes.ts";
import {
  type BoardQrRead,
  checkBoardQr,
  checkPairingCode,
  formatBoardQr,
  formatPairingCode,
  makePairingCode,
  pairAdvertName,
  pairingCodeSecret,
  type PairingCodeRefusal,
  readBoardQr,
  readPairAdvert,
  readPairingCode,
  sameChip,
} from "./code.ts";
import type {
  FormatBoardQr,
  FormatPairingCode,
  PairingCodeText,
  ReadBoardQr,
  ReadPairAdvert,
  ReadPairingCode,
} from "./types.ts";
import {
  pairingAdvertVectorFile,
  pairingBoardQrVectorFile,
  pairingCodeVectorFile,
} from "./vector-formats.ts";

const VECTORS = join(import.meta.dir, "..", "..", "vectors");
const read = (name: string): unknown => JSON.parse(readFileSync(join(VECTORS, name), "utf8"));

// The frozen types are what these functions are.
const frozen: [ReadPairingCode, FormatPairingCode, ReadBoardQr, FormatBoardQr, ReadPairAdvert] = [
  readPairingCode,
  formatPairingCode,
  readBoardQr,
  formatBoardQr,
  readPairAdvert,
];
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const code = (text: string): PairingCodeText => text as PairingCodeText;

describe("the pairing code", () => {
  test("the frozen signatures", () => {
    expect(frozen).toHaveLength(5);
  });

  test("check characters, worked by hand: the value mod 37, then *~$=U", () => {
    // 0000000 is 0: check 0. 0000001 is 1: check 1. 000000Z is 31: check Z.
    expect(makePairingCode(0n)).toBe(code("00000000"));
    expect(makePairingCode(1n)).toBe(code("00000011"));
    expect(makePairingCode(31n)).toBe(code("000000ZZ"));
    // 32 to 36 are the five extra symbols; 37 wraps to 0.
    expect(makePairingCode(32n)).toBe(code("0000010*"));
    expect(makePairingCode(33n)).toBe(code("0000011~"));
    expect(makePairingCode(34n)).toBe(code("0000012$"));
    expect(makePairingCode(35n)).toBe(code("0000013="));
    expect(makePairingCode(36n)).toBe(code("0000014U"));
    expect(makePairingCode(37n)).toBe(code("00000150"));
    // ZZZZZZZ is 2^35 - 1 = 34359738367 = 37 × 928641577 + 18, and 18 is J.
    expect(makePairingCode((1n << 35n) - 1n)).toBe(code("ZZZZZZZJ"));
    // The most significant character first: 1000000 is 32^6 = 1073741824 = 37 × 29020049 + 11 (B).
    expect(makePairingCode(1n << 30n)).toBe(code("1000000B"));
  });

  test("secrets out of range make no code", () => {
    expect(makePairingCode(-1n)).toBeUndefined();
    expect(makePairingCode(1n << 35n)).toBeUndefined();
  });

  test("the secret reads back, and the display's form", () => {
    for (const secret of [0n, 1n, 36n, 12_345_678_901n, (1n << 35n) - 1n]) {
      const made = makePairingCode(secret);
      expect(made).toBeDefined();
      if (made === undefined) continue;
      expect(pairingCodeSecret(made)).toBe(secret);
      expect(readPairingCode(formatPairingCode(made))).toBe(made);
      expect(formatPairingCode(made)).toMatch(/^.{4}-.{4}$/u);
    }
    expect(formatPairingCode(code("WPYX9D3F"))).toBe("WPYX-9D3F");
  });

  test("forgiveness: case, spaces, dashes, I and L as 1, O as 0", () => {
    const right = code("0000014U");
    for (const typed of [
      "0000-014U",
      "0000014u",
      " 0000 014U ",
      "0000\u2010014U",
      "0000\u2011014U",
      "0000\u2012014U",
      "0000\u2013014U",
      "0000\u2014014U",
      "0000\u2212014U",
      "oooo-o14u",
      "OOOO-014U",
      "0000\u00a0014U",
      "0-0-0-0-0-1-4-U",
    ])
      expect(readPairingCode(typed)).toBe(right);
    expect(readPairingCode("ILil-OoOo")).toBeUndefined();
    const ones = makePairingCode((1n << 30n) | (1n << 20n) | (1n << 10n) | 1n);
    expect(ones).toBe(code("1010101~"));
    expect(readPairingCode("IoLOiol~")).toBe(code("1010101~"));
  });

  test("every malformed form is refused, with a reason that carries nothing of the text", () => {
    const cases: [string, PairingCodeRefusal][] = [
      ["", "empty"],
      ["   ", "empty"],
      ["-- -", "empty"],
      ["0000-014", "tooShort"],
      ["A", "tooShort"],
      ["0000-014U0", "tooLong"],
      ["ABCD-EFGH-JKMN", "tooLong"],
      ["U000-014U", "badCharacter"],
      ["*000-014U", "badCharacter"],
      ["0000-0#4U", "badCharacter"],
      ["0000_014U", "badCharacter"],
      ["0000.014U", "badCharacter"],
      ["0000-014#", "badCharacter"],
      ["\u0131000-014U", "badCharacter"],
      ["\uff10000-014U", "badCharacter"],
      ["0000-014\u00dc", "badCharacter"],
      ["0000-0140", "badCheck"],
      ["0000-014*", "badCheck"],
      ["0000-015U", "badCheck"],
    ];
    for (const [text, refusal] of cases) {
      const result = checkPairingCode(text);
      expect({ text, result }).toEqual({ text, result: { ok: false, refusal } });
      expect(readPairingCode(text)).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(text === "" ? "\u0000" : text);
    }
  });

  test("a bad character is reported before the length; a check symbol is bad only among the first 7", () => {
    expect(checkPairingCode("U00")).toEqual({ ok: false, refusal: "badCharacter" });
    expect(checkPairingCode("000000U00")).toEqual({ ok: false, refusal: "badCharacter" });
    expect(checkPairingCode("000000000U")).toEqual({ ok: false, refusal: "tooLong" });
    expect(checkPairingCode("0000000U0")).toEqual({ ok: false, refusal: "tooLong" });
    expect(checkPairingCode("0000000#0")).toEqual({ ok: false, refusal: "badCharacter" });
  });

  test("the check catches every single-character mistake and every adjacent swap", () => {
    const right = makePairingCode(24_492_461_099n);
    expect(right).toBe(code("PSXTK1B3"));
    if (right === undefined) return;
    const symbols = `${CROCKFORD}*~$=U`;
    let tried = 0;
    for (let i = 0; i < 8; i++) {
      for (const ch of i < 7 ? CROCKFORD : symbols) {
        if (ch === right[i]) continue;
        const wrong = right.slice(0, i) + ch + right.slice(i + 1);
        expect({ wrong, read: readPairingCode(wrong) }).toEqual({ wrong, read: undefined });
        tried++;
      }
    }
    expect(tried).toBe(7 * 31 + 36);
    for (let i = 0; i < 7; i++) {
      const a = right[i] ?? "";
      const b = right[i + 1] ?? "";
      if (a === b) continue;
      const swapped = right.slice(0, i) + b + a + right.slice(i + 2);
      expect(readPairingCode(swapped)).toBeUndefined();
    }
  });

  test("pairing-code.json, case by case", () => {
    const file = pairingCodeVectorFile.parse(read("pairing-code.json"));
    let good = 0;
    for (const c of file.cases) {
      const got = readPairingCode(c.text);
      const text: string | null = got ?? null;
      expect({ name: c.name, got: text }).toEqual({ name: c.name, got: c.code });
      if (got === undefined) continue;
      good++;
      expect(formatPairingCode(got)).toBe(c.shown ?? "");
      expect(pairingCodeSecret(got).toString()).toBe(c.secret ?? "");
      expect(makePairingCode(pairingCodeSecret(got))).toBe(got);
    }
    // 17 texts are codes; 14 are not.
    expect(good).toBe(17);
    expect(file.cases).toHaveLength(31);
  });
});

describe("the board's QR code", () => {
  const chip = fromHex("3c71bf9a4f2a");

  test("written and read back, the check character percent-encoded", () => {
    for (const c of ["PSXTK1B3", "0000012$", "0000013=", "0000010*", "0000011~", "0000014U"]) {
      const text = formatBoardQr({ code: code(c), chipId: chip });
      const qr = readBoardQr(text);
      expect(qr?.code).toBe(code(c));
      expect(toHex(qr?.chipId ?? new Uint8Array())).toBe("3c71bf9a4f2a");
    }
    expect(formatBoardQr({ code: code("0000012$"), chipId: chip })).toBe(
      "hsn://pair/1?c=0000012%24&d=3c71bf9a4f2a",
    );
    expect(formatBoardQr({ code: code("PSXTK1B3"), chipId: chip })).toBe(
      "hsn://pair/1?c=PSXTK1B3&d=3c71bf9a4f2a",
    );
    // A chip id of the wrong size gives a text no reader takes.
    expect(readBoardQr(formatBoardQr({ code: code("PSXTK1B3"), chipId: chip.slice(1) }))).toBe(
      undefined,
    );
  });

  test("each refusal and its reason", () => {
    const cases: [string, BoardQrRead][] = [
      ["hsn://pair/2?c=PSXTK1B3&d=3c71bf9a4f2a", { ok: false, refusal: "notPairing" }],
      ["hsn://pair/1", { ok: false, refusal: "notPairing" }],
      ["https://example.com/?c=PSXTK1B3", { ok: false, refusal: "notPairing" }],
      ["hsn://pair/1?d=3c71bf9a4f2a", { ok: false, refusal: "noCode" }],
      ["hsn://pair/1?c=&d=3c71bf9a4f2a", { ok: false, refusal: "noCode" }],
      ["hsn://pair/1?c=PSXTK1B3&c=PSXTK1B3&d=3c71bf9a4f2a", { ok: false, refusal: "noCode" }],
      [
        "hsn://pair/1?c=PSXTK1B0&d=3c71bf9a4f2a",
        { ok: false, refusal: "badCode", code: "badCheck" },
      ],
      ["hsn://pair/1?c=PSXT&d=3c71bf9a4f2a", { ok: false, refusal: "badCode", code: "tooShort" }],
      ["hsn://pair/1?c=PSXTK1B3", { ok: false, refusal: "badChip" }],
      ["hsn://pair/1?c=PSXTK1B3&d=", { ok: false, refusal: "badChip" }],
      ["hsn://pair/1?c=PSXTK1B3&d=3C71BF9A4F2A", { ok: false, refusal: "badChip" }],
      ["hsn://pair/1?c=PSXTK1B3&d=3c71bf9a4f2", { ok: false, refusal: "badChip" }],
      ["hsn://pair/1?c=PSXTK1B3&d=3c71bf9a4f2a0", { ok: false, refusal: "badChip" }],
      ["hsn://pair/1?c=PSXTK1B3&d=3c71bf9a4f2a&d=3c71bf9a4f2a", { ok: false, refusal: "badChip" }],
    ];
    for (const [text, expected] of cases)
      expect({ text, r: checkBoardQr(text) }).toEqual({ text, r: expected });
  });

  test("pairing-board-qr.json, case by case", () => {
    const file = pairingBoardQrVectorFile.parse(read("pairing-board-qr.json"));
    for (const c of file.cases) {
      const qr = readBoardQr(c.text);
      const mine: { code: string; chipId: string } | null =
        qr === undefined ? null : { code: qr.code, chipId: toHex(qr.chipId) };
      expect({ name: c.name, qr: mine }).toEqual({
        name: c.name,
        qr: c.qr,
      });
    }
    expect(file.cases.filter((c) => c.qr !== null)).toHaveLength(7);
  });
});

describe("the advertisement", () => {
  const chip = fromHex("3c71bf9a4f2a");

  test("the scan response name written and read", () => {
    expect(readPairAdvert(pairAdvertName(chip) ?? null)).toEqual({ chipSuffix: "4f2a" });
    expect(readPairAdvert("hsn-pair-4F2A")).toBeUndefined();
    expect(readPairAdvert("hsn-pair-4f2")).toBeUndefined();
    expect(readPairAdvert("hsn-pair-14f2a")).toBeUndefined();
    expect(readPairAdvert("hsn-pair-4g2a")).toBeUndefined();
    expect(readPairAdvert("hsn-00004f2a")).toBeUndefined();
    expect(readPairAdvert("hsn-pair-4f2a\n")).toBeUndefined();
  });

  test("the local name and comparing chips", () => {
    expect(pairAdvertName(chip)).toBe("hsn-pair-4f2a");
    expect(pairAdvertName(chip.slice(1))).toBeUndefined();
    expect(sameChip(chip, fromHex("3c71bf9a4f2a"))).toBe(true);
    expect(sameChip(chip, fromHex("3c71bf9a4f2b"))).toBe(false);
    expect(sameChip(chip.slice(1), chip.slice(1))).toBe(false);
  });

  test("pairing-advert.json, case by case", () => {
    const file = pairingAdvertVectorFile.parse(read("pairing-advert.json"));
    for (const c of file.cases) {
      const advert = readPairAdvert(c.localName);
      expect({
        name: c.name,
        advert: advert ?? null,
      }).toEqual({ name: c.name, advert: c.advert });
    }
    expect(file.cases.filter((c) => c.advert !== null)).toHaveLength(5);
  });
});
