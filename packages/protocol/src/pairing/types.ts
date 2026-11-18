/**
 * Pairing over Bluetooth's types and the interfaces of its implementations (docs/m3-design.md
 * sections 5 and 10, item 4). Frozen by the joint step 0. P3 writes the implementations here
 * (`code.ts`, `srp.ts`, `security2.ts`, beside these files), checked against vectors made from
 * ESP-IDF v6.1.1's sources; the phone's Bluetooth link (`GattLink`) and `openSetupSession` over
 * it are the app's (`app/src/platform/`, step 0c).
 */
import { z } from "zod";
import { PAIR_PROTOCOL_LABEL } from "./constants.ts";

/** A pairing code as read: its 8 characters, upper case, without the dash; the SRP password. */
export type PairingCodeText = string & { readonly __pairingCode: true };

/** Reads a pairing code as a person types it, or as a QR code's `c=` gives it; undefined if not one. */
export type ReadPairingCode = (text: string) => PairingCodeText | undefined;
/** Writes a pairing code for the display: `XXXX-XXXX`. */
export type FormatPairingCode = (code: PairingCodeText) => string;

/** What a board's QR code carries (m3-design section 5, "The display"). */
export interface BoardQr {
  readonly code: PairingCodeText;
  /** §10's chip id, 6 bytes. */
  readonly chipId: Uint8Array;
}
export type ReadBoardQr = (text: string) => BoardQr | undefined;
export type FormatBoardQr = (qr: BoardQr) => string;

/** A board's pairing advertisement's service data (format 1), as the phone reads it. */
export interface PairAdvert {
  readonly format: 1;
  /** §6's Role value, as read (unlisted values pass through). */
  readonly role: number;
  readonly chipId: Uint8Array;
}
export type ReadPairAdvert = (serviceData: Uint8Array) => PairAdvert | undefined;

/**
 * `proto-ver`'s answer, UTF-8 JSON, read in the clear before the session: the protocol's label,
 * the board's role, chip id and firmware, and protocomm's security version †.
 */
export const pairVersion = z
  .strictObject({
    v: z.literal(PAIR_PROTOCOL_LABEL),
    role: z.int().min(0).max(255),
    chip: z.string().regex(/^[0-9a-f]{12}$/u, "12 lowercase hex digits"),
    firmware: z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u, "MAJOR.MINOR.PATCH"),
    sec: z.literal(2),
  })
  .readonly();
export type PairVersion = z.infer<typeof pairVersion>;

/** Why pairing's security layer failed. */
export type PairSecurityFault =
  /** The board's proof did not verify: the code is not this board's. */
  | "wrongCode"
  /** A message out of turn, of the wrong shape, or a status other than success. */
  | "protocol"
  /** A tag that did not verify, or the counter used up. */
  | "decryptFailed";

export type PairResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PairSecurityFault };

/**
 * The phone's side of protocomm security 2 (P3): SRP6a with the code as the password, then
 * AES-256-GCM. Every message is a protobuf `Sec2Payload`, written to `prov-session` and its answer
 * read back. Random values are the implementation's; vectors give fixed ones.
 */
export interface Security2Client {
  /** Session command 0: the user name and the client's public value A. */
  command0(): Promise<PairResult<Uint8Array>>;
  /** Reads response 0 (the board's B and salt) and writes command 1 (the client's proof). */
  command1(response0: Uint8Array): Promise<PairResult<Uint8Array>>;
  /** Reads response 1: checks the board's proof and takes its nonce; the session is then open. */
  finish(response1: Uint8Array): Promise<PairResult<Security2Session>>;
}

/** An open security 2 session: each request sealed, each answer opened, the counter stepping. */
export interface Security2Session {
  seal(plaintext: Uint8Array): PairResult<Uint8Array>;
  open(ciphertext: Uint8Array): PairResult<Uint8Array>;
}

/** Starts the phone's side for one pairing attempt; `fixed` holds the vectors' random values. */
export type StartSecurity2 = (
  code: PairingCodeText,
  fixed?: { readonly clientPrivate: Uint8Array },
) => Security2Client;
