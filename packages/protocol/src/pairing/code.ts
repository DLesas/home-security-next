/**
 * The pairing code, the board's QR code and the pairing advertisement (docs/m3-design.md section 5,
 * protocol.md section 10, "Pairing over Bluetooth"), as the frozen types in `types.ts` give them.
 *
 * The code is 8 characters of Crockford base32, shown `XXXX-XXXX`: 7 of secret (35 bits, most
 * significant first) and a check character, the secret's value mod 37 written with Crockford's
 * alphabet then `*~$=U`, as the linking code's is (m2-design section 5). It is read with the same
 * forgiveness: case, spaces and dashes are ignored, `I` and `L` read as `1`, `O` as `0`. Two
 * choices of this file, stricter or kinder than the linking code's reader and listed in P3's report:
 * a character outside ASCII is refused rather than upper-cased (so a dotless i, U+0131, is not read as `1`), and the
 * dashes a phone's keyboard may put in place of `-` (U+2010 to U+2014, U+2212) count as dashes.
 *
 * Nothing here logs, and no refusal carries the text it refused: a pairing code is a secret.
 */
import { PAIR_ADVERT, PAIR_QR, PAIRING_CODE } from "./constants.ts";
import type { BoardQr, PairAdvert, PairingCodeText } from "./types.ts";

/**
 * §10's chip identifier, 6 bytes: `usb/setup.ts`'s CHIP_ID_LENGTH, not imported from there because
 * that module reaches `node:crypto`, which the phone does not have; this folder imports nothing
 * that does (a test checks).
 */
const CHIP_ID_LENGTH = 6;

/** Crockford's alphabet, and the five check symbols for 32 to 36. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CHECK_SYMBOLS = "*~$=U";
const CODE_CHARS = PAIRING_CODE.secretChars + PAIRING_CODE.checkChars;
const SECRET_LIMIT = 1n << BigInt(PAIRING_CODE.secretBits);

/** Whitespace, and the dashes a keyboard may type: hyphen-minus, U+2010 to U+2014, U+2212. */
const IGNORED = /[\s\-\u2010-\u2014\u2212]/gu;

/** Why a text is not a pairing code, for the app to word. Never carries the text. */
export type PairingCodeRefusal =
  /** Nothing but spaces and dashes. */
  | "empty"
  /** Fewer than 8 characters once spaces and dashes are taken out. */
  | "tooShort"
  /** More than 8. */
  | "tooLong"
  /** A character that is not in the code's alphabet (or not ASCII). */
  | "badCharacter"
  /** 8 good characters whose check character does not match: a typing mistake. */
  | "badCheck";

export type CodeRead =
  | { readonly ok: true; readonly code: PairingCodeText }
  | { readonly ok: false; readonly refusal: PairingCodeRefusal };

function checkSymbol(value: bigint): string {
  const n = Number(value % 37n);
  return n < 32 ? (CROCKFORD[n] ?? "") : (CHECK_SYMBOLS[n - 32] ?? "");
}

/** Reads a pairing code as a person types it, or as a QR code's `c=` gives it, with the reason. */
export function checkPairingCode(text: string): CodeRead {
  const stripped = text.replace(IGNORED, "");
  if (stripped === "") return { ok: false, refusal: "empty" };
  // Refused before upper-casing, which maps some non-ASCII letters onto ASCII ones.
  if (!/^[\x21-\x7e]*$/u.test(stripped)) return { ok: false, refusal: "badCharacter" };
  const clean = stripped.toUpperCase().replace(/[IL]/gu, "1").replace(/O/gu, "0");
  let value = 0n;
  for (const ch of clean.slice(0, PAIRING_CODE.secretChars)) {
    const digit = CROCKFORD.indexOf(ch);
    if (digit < 0) return { ok: false, refusal: "badCharacter" };
    value = value * 32n + BigInt(digit);
  }
  const check = clean.slice(PAIRING_CODE.secretChars);
  for (const ch of check)
    if (!CROCKFORD.includes(ch) && !CHECK_SYMBOLS.includes(ch))
      return { ok: false, refusal: "badCharacter" };
  if (clean.length < CODE_CHARS) return { ok: false, refusal: "tooShort" };
  if (clean.length > CODE_CHARS) return { ok: false, refusal: "tooLong" };
  if (check !== checkSymbol(value)) return { ok: false, refusal: "badCheck" };
  return { ok: true, code: clean as PairingCodeText };
}

/** `ReadPairingCode`: the code, or undefined when the text is not one. */
export function readPairingCode(text: string): PairingCodeText | undefined {
  const read = checkPairingCode(text);
  return read.ok ? read.code : undefined;
}

/** `FormatPairingCode`: `XXXX-XXXX`, as the display shows it. */
export function formatPairingCode(code: PairingCodeText): string {
  const [first] = PAIRING_CODE.groups;
  return `${code.slice(0, first)}-${code.slice(first)}`;
}

/** The code's 35-bit secret, most significant character first. */
export function pairingCodeSecret(code: PairingCodeText): bigint {
  let value = 0n;
  for (const ch of code.slice(0, PAIRING_CODE.secretChars))
    value = value * 32n + BigInt(CROCKFORD.indexOf(ch));
  return value;
}

/**
 * The code for a 35-bit secret, as a board makes it from its random number generator; undefined
 * when the secret is out of range. For the scripted boards and the vectors.
 */
export function makePairingCode(secret: bigint): PairingCodeText | undefined {
  if (secret < 0n || secret >= SECRET_LIMIT) return undefined;
  let digits = "";
  let value = secret;
  for (let i = 0; i < PAIRING_CODE.secretChars; i++) {
    digits = (CROCKFORD[Number(value & 31n)] ?? "") + digits;
    value >>= 5n;
  }
  return (digits + checkSymbol(secret)) as PairingCodeText;
}

// ----- The board's QR code -----

/** Why a text is not a board's QR code. */
export type BoardQrRefusal =
  /** Not `hsn://pair/1?…`: another QR code (a link code, a web address). */
  | "notPairing"
  /** `c=` missing, empty or given twice. */
  | "noCode"
  /** `c=` is there but is not a pairing code. */
  | "badCode"
  /** `d=` missing, given twice, or not 12 lower-case hex digits. */
  | "badChip";

export type BoardQrRead =
  | { readonly ok: true; readonly qr: BoardQr }
  | {
      readonly ok: false;
      readonly refusal: BoardQrRefusal;
      /** With `badCode`, why the code is not one. */
      readonly code?: PairingCodeRefusal;
    };

const HEX12 = /^[0-9a-f]{12}$/u;

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function lowerHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Reads the text a camera found: `hsn://pair/1?c=<code>&d=<chip id>`. Other parameters are
 * ignored, as a newer board may add some; `c` or `d` given twice is refused, since the two could
 * differ. The code is read with `checkPairingCode`'s forgiveness, the chip id must be exact.
 */
export function checkBoardQr(text: string): BoardQrRead {
  const prefix = `${PAIR_QR.prefix}?`;
  if (!text.startsWith(prefix)) return { ok: false, refusal: "notPairing" };
  const params = new URLSearchParams(text.slice(prefix.length));
  const codes = params.getAll(PAIR_QR.codeParam);
  const chips = params.getAll(PAIR_QR.chipParam);
  const [codeText] = codes;
  if (codes.length !== 1 || codeText === undefined || codeText === "")
    return { ok: false, refusal: "noCode" };
  const code = checkPairingCode(codeText);
  if (!code.ok) return { ok: false, refusal: "badCode", code: code.refusal };
  const [chip] = chips;
  if (chips.length !== 1 || chip === undefined || !HEX12.test(chip))
    return { ok: false, refusal: "badChip" };
  return { ok: true, qr: { code: code.code, chipId: hexBytes(chip) } };
}

/** `ReadBoardQr`: what the QR code carries, or undefined when it is not a board's. */
export function readBoardQr(text: string): BoardQr | undefined {
  const read = checkBoardQr(text);
  return read.ok ? read.qr : undefined;
}

/**
 * `FormatBoardQr`: the text a board's display encodes, the code without its dash and
 * percent-encoded (its check character may be `$` or `=`). A chip id that is not 6 bytes gives a
 * text `readBoardQr` refuses (`badChip`), since the frozen type returns a string.
 */
export function formatBoardQr(qr: BoardQr): string {
  return `${PAIR_QR.prefix}?${PAIR_QR.codeParam}=${encodeURIComponent(qr.code)}&${PAIR_QR.chipParam}=${lowerHex(qr.chipId)}`;
}

// ----- The advertisement -----

/** Reads the last two chip bytes from a pairing scan response's local name. */
export function readPairAdvert(name: string | null): PairAdvert | undefined {
  if (!name?.startsWith(PAIR_ADVERT.namePrefix)) return undefined;
  const chipSuffix = name.slice(PAIR_ADVERT.namePrefix.length);
  if (chipSuffix.length !== PAIR_ADVERT.nameHexDigits || /[^0-9a-f]/u.test(chipSuffix))
    return undefined;
  return { chipSuffix };
}

/** The local name in a pairing window: `hsn-pair-` and the chip id's last 4 hex digits. */
export function pairAdvertName(chipId: Uint8Array): string | undefined {
  if (chipId.length !== CHIP_ID_LENGTH) return undefined;
  return PAIR_ADVERT.namePrefix + lowerHex(chipId).slice(-PAIR_ADVERT.nameHexDigits);
}

/** True when two chip ids are the same 6 bytes: a scanned QR's board and a connected board's. */
export function sameChip(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === CHIP_ID_LENGTH && b.length === CHIP_ID_LENGTH && lowerHex(a) === lowerHex(b);
}
