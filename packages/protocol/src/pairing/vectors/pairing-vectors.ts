/**
 * Writes the pairing vectors made from our own rules (docs/m3-design.md section 5), in the formats
 * `../vector-formats.ts` freezes: `pairing-code.json` (codes as people type them),
 * `pairing-board-qr.json` (the board's QR code) and `pairing-advert.json` (the advertisement's
 * service data). Fixed values only: `pairing-vectors.test.ts` fails if a committed file differs
 * from what this writes. Run `bun packages/protocol/src/pairing/vectors/pairing-vectors.ts`.
 *
 * The expected values are the package's own reading; `verify/verify-pairing-vectors.mjs` reads
 * every case again from the rules alone, and the tests pin the check characters by hand. The four
 * ESP-IDF files (`pairing-srp.json`, `pairing-security2.json`, `pairing-board-script.json`,
 * `pairing-security2-counter.json`) are not written here: `../esp-idf/make-vectors.sh` makes them
 * from ESP-IDF's own code.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toHex } from "../../bytes.ts";
import {
  checkPairingCode,
  formatPairingCode,
  makePairingCode,
  pairingCodeSecret,
  readBoardQr,
  readPairAdvert,
} from "../code.ts";
import type { PairingCodeText } from "../types.ts";

export const PAIRING_VECTOR_DIRECTORY = join(import.meta.dir, "..", "..", "..", "vectors");

/** The files this generator writes. */
export const PAIRING_RULE_VECTOR_FILES = {
  code: "pairing-code.json",
  boardQr: "pairing-board-qr.json",
  advert: "pairing-advert.json",
} as const;

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** A fixed secret's code; every secret below is in range, which the tests check by reading. */
const code = (secret: bigint): PairingCodeText =>
  makePairingCode(secret) ?? ("" as PairingCodeText);

/** A good case as the reader reads it; null fields if it is refused, which the tests catch. */
function readCase(name: string, text: string): Json {
  const read = checkPairingCode(text);
  return read.ok
    ? {
        name,
        text,
        code: read.code,
        shown: formatPairingCode(read.code),
        secret: pairingCodeSecret(read.code).toString(),
      }
    : { name, text, code: null, shown: null, secret: null };
}

// ----- pairing-code.json -----

const SIREN = code(0x5_b3dd_4c2bn & ((1n << 35n) - 1n));
/** Secret characters 1010101: a code with ones and zeros to type as look-alikes. */
const ONES_AND_ZEROS = code((1n << 30n) | (1n << 20n) | (1n << 10n) | 1n);

/** A code with its 1s typed as I, L, i and l in turn, and its 0s as O and o. */
function lookAlikes(text: string): string {
  const ones = ["I", "L", "i", "l"];
  const zeros = ["O", "o"];
  let one = 0;
  let zero = 0;
  return Array.from(text)
    .map((ch) =>
      ch === "1" ? (ones[one++ % 4] ?? ch) : ch === "0" ? (zeros[zero++ % 2] ?? ch) : ch,
    )
    .join("");
}

function codeCases(): Json[] {
  const siren = formatPairingCode(SIREN);
  const [first = "", second = ""] = siren.split("-");
  const typed: [string, string][] = [
    ["as the display shows it", siren],
    ["without the dash", SIREN],
    ["lower case", siren.toLowerCase()],
    ["spaces and dashes anywhere", ` ${first.slice(0, 2)} ${first.slice(2)}--${second} `],
    ["an en dash from a phone's keyboard", `${first}\u2013${second}`],
    ["a non-breaking space in place of the dash", `${first}\u00a0${second}`],
    ["a tab and a new line", `\t${first}\n${second}`],
    ["the smallest secret, all zeros", formatPairingCode(code(0n))],
    ["the largest secret", formatPairingCode(code((1n << 35n) - 1n))],
    ["check character 32, *", formatPairingCode(code(32n))],
    ["check character 33, ~", formatPairingCode(code(33n))],
    ["check character 34, $", formatPairingCode(code(34n))],
    ["check character 35, =", formatPairingCode(code(35n))],
    ["check character 36, U", formatPairingCode(code(36n))],
    ["check character 36 typed as a lower-case u", formatPairingCode(code(36n)).toLowerCase()],
    ["I and L read as 1, O as 0", lookAlikes(ONES_AND_ZEROS)],
    ["only Os", "OOOO-OOOO"],
  ];
  const refused: [string, string][] = [
    ["empty", ""],
    ["only spaces and dashes", " - -- "],
    ["seven characters", SIREN.slice(0, 7)],
    ["nine characters", `${SIREN}0`],
    ["twelve characters, a linking code", "ABCD-EFGH-JKMN"],
    ["U among the secret characters", `U${SIREN.slice(1)}`],
    ["a check symbol among the secret characters", `*${SIREN.slice(1)}`],
    ["a character outside the alphabet", `${SIREN.slice(0, 3)}#${SIREN.slice(4)}`],
    ["a dotless i, which upper-cases to I", `\u0131${SIREN.slice(1)}`],
    ["full-width digits", "\uff10".repeat(8)],
    ["the wrong check character", `${SIREN.slice(0, 7)}${SIREN.endsWith("0") ? "1" : "0"}`],
    ["two characters swapped", `${SIREN[1] ?? ""}${SIREN[0] ?? ""}${SIREN.slice(2)}`],
    [
      "one character changed",
      `${SIREN.slice(0, 2)}${SIREN[2] === "7" ? "8" : "7"}${SIREN.slice(3)}`,
    ],
    ["an underscore as the separator", `${first}_${second}`],
  ];
  return [
    ...typed.map(([name, text]) => readCase(name, text)),
    ...refused.map(([name, text]): Json => ({ name, text, code: null, shown: null, secret: null })),
  ];
}

// ----- pairing-board-qr.json -----

const CHIP = "3c71bf9a4f2a";

function qrCases(): Json[] {
  const dollar = code(34n);
  const equals = code(35n);
  const texts: [string, string][] = [
    ["a siren's display", `hsn://pair/1?c=${SIREN}&d=${CHIP}`],
    ["the chip id first", `hsn://pair/1?d=${CHIP}&c=${SIREN}`],
    [
      "a check character $, percent-encoded",
      `hsn://pair/1?c=${encodeURIComponent(dollar)}&d=${CHIP}`,
    ],
    [
      "a check character =, percent-encoded",
      `hsn://pair/1?c=${encodeURIComponent(equals)}&d=${CHIP}`,
    ],
    ["a check character =, not encoded", `hsn://pair/1?c=${equals}&d=${CHIP}`],
    ["a parameter a newer board adds, ignored", `hsn://pair/1?c=${SIREN}&d=${CHIP}&v=2`],
    [
      "the code with its dash and in lower case",
      `hsn://pair/1?c=${formatPairingCode(SIREN).toLowerCase()}&d=${CHIP}`,
    ],
    ["another version", `hsn://pair/2?c=${SIREN}&d=${CHIP}`],
    ["the scheme in capitals", `HSN://pair/1?c=${SIREN}&d=${CHIP}`],
    ["a link code's QR code", `hsn://link/1?c=${SIREN}&d=${CHIP}`],
    ["no query", "hsn://pair/1"],
    ["no code", `hsn://pair/1?d=${CHIP}`],
    ["an empty code", `hsn://pair/1?c=&d=${CHIP}`],
    ["the code twice", `hsn://pair/1?c=${SIREN}&c=${SIREN}&d=${CHIP}`],
    [
      "a code with the wrong check character",
      `hsn://pair/1?c=${SIREN.slice(0, 7)}${SIREN.endsWith("0") ? "1" : "0"}&d=${CHIP}`,
    ],
    ["no chip id", `hsn://pair/1?c=${SIREN}`],
    ["the chip id twice", `hsn://pair/1?c=${SIREN}&d=${CHIP}&d=${CHIP}`],
    ["the chip id in capitals", `hsn://pair/1?c=${SIREN}&d=${CHIP.toUpperCase()}`],
    ["a chip id of 5 bytes", `hsn://pair/1?c=${SIREN}&d=${CHIP.slice(2)}`],
    ["a chip id of 7 bytes", `hsn://pair/1?c=${SIREN}&d=${CHIP}00`],
    ["a chip id that is not hex", `hsn://pair/1?c=${SIREN}&d=3c71bf9a4f2g`],
  ];
  // The first seven are a board's QR code; the rest are not, and are written as null unread.
  return texts.map(([name, text], i) => {
    const qr = i < 7 ? readBoardQr(text) : undefined;
    return {
      name,
      text,
      qr: qr === undefined ? null : { code: qr.code, chipId: toHex(qr.chipId) },
    };
  });
}

// ----- pairing-advert.json -----

function advertCases(): Json[] {
  const data: [string, string | null][] = [
    ["a board", "hsn-pair-4f2a"],
    ["leading zeros", "hsn-pair-0001"],
    ["all zero", "hsn-pair-0000"],
    ["all high", "hsn-pair-ffff"],
    ["another board", "hsn-pair-abcd"],
    ["uppercase hex", "hsn-pair-4F2A"],
    ["too few digits", "hsn-pair-4f2"],
    ["extra digits", "hsn-pair-14f2a"],
    ["invalid hex", "hsn-pair-4g2a"],
    ["update service's local name", "hsn-00004f2a"],
    ["scan response has not arrived", null],
    ["empty", ""],
  ];
  return data.map(([name, localName]) => {
    const advert = readPairAdvert(localName);
    return { name, localName, advert: advert === undefined ? null : { ...advert } };
  });
}

/** Every file, by name, as the exact text written. */
export function pairingRuleVectorFiles(): Map<string, string> {
  const files: [string, string, Json[]][] = [
    [
      PAIRING_RULE_VECTOR_FILES.code,
      "Pairing codes as people type them (m3-design.md section 5): 8 characters of Crockford base32, " +
        "shown XXXX-XXXX, 7 of secret (35 bits, the first character most significant) and a check " +
        "character, the secret mod 37 written with Crockford's alphabet (0123456789ABCDEFGHJKMNPQRSTVWXYZ) " +
        "then *~$=U for 32 to 36. Reading: whitespace and dashes (-, U+2010 to U+2014, U+2212) are " +
        "ignored; then any character outside printable ASCII is refused; then the text is upper-cased " +
        "and I and L read as 1, O as 0. The first 7 must be in Crockford's alphabet, the 8th in it or " +
        "a check symbol, and the 8th must be the 7's check. code is the 8 canonical characters (the " +
        "SRP password), shown the display's form, secret the 35-bit value in decimal; all null when " +
        "the text is not a code.",
      codeCases(),
    ],
    [
      PAIRING_RULE_VECTOR_FILES.boardQr,
      "The board's QR code: hsn://pair/1?c=<code>&d=<chip id>, prefix exact. Parameters as a URL " +
        "query (percent-decoding, + as a space); others are ignored; c and d each exactly once. c is " +
        "read as a typed code (pairing-code.json). d is exactly 12 lowercase hex digits, the 6-byte " +
        "chip id. qr is null when the text is not a board's QR code.",
      qrCases(),
    ],
    [
      PAIRING_RULE_VECTOR_FILES.advert,
      "The pairing advertisement carries only flags and the protocomm service UUID. The scan response " +
        "carries hsn-pair- followed by the last four lowercase hex digits of the chip id. Invalid " +
        "or missing names read as null.",
      advertCases(),
    ],
  ];
  return new Map(
    files.map(([name, description, cases]) => [
      name,
      `${JSON.stringify({ schemaVersion: 1, description, cases }, null, 2)}\n`,
    ]),
  );
}

if (import.meta.main) {
  for (const [name, text] of pairingRuleVectorFiles())
    writeFileSync(join(PAIRING_VECTOR_DIRECTORY, name), text);
  console.log(`wrote ${Object.keys(PAIRING_RULE_VECTOR_FILES).length} pairing vector files`);
}
