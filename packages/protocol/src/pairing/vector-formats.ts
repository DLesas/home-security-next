/**
 * The file formats of pairing's vectors (docs/m3-design.md section 10, item 4), as Zod schemas
 * that a test reads each file with. P3 writes the files: `pairing-code.json` and
 * `pairing-board-qr.json` from our own rules, `pairing-srp.json` and `pairing-security2.json`
 * made from ESP-IDF v6.1.1's sources (`esp_srp`, protocomm's security 2) with fixed random values.
 * Bytes are lowercase hex, as in every vector file (vectors/README.md).
 */
import { z } from "zod";

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u, "lowercase hex, whole bytes");
const header = { schemaVersion: z.literal(1), description: z.string() };

/** `pairing-code.json`: texts as a person types them, and what each reads as. */
export const pairingCodeVectorFile = z.strictObject({
  ...header,
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        /** As typed, or as the display shows it. */
        text: z.string(),
        /** The canonical 8 characters, or null when the text is not a code. */
        code: z.string().length(8).nullable(),
        /** The display's form, `XXXX-XXXX`, when `code` is not null. */
        shown: z.string().length(9).nullable(),
        /** The 35-bit secret as a decimal string, when `code` is not null. */
        secret: z.string().regex(/^\d+$/u).nullable(),
      }),
    )
    .min(1),
});

/** `pairing-board-qr.json`: QR texts and what each carries. */
export const pairingBoardQrVectorFile = z.strictObject({
  ...header,
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        text: z.string(),
        /** Null when the text is not a board's QR code. */
        qr: z.strictObject({ code: z.string().length(8), chipId: hex }).nullable(),
      }),
    )
    .min(1),
});

/** `pairing-advert.json`: service data and what it reads as. */
export const pairingAdvertVectorFile = z.strictObject({
  ...header,
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        serviceData: hex,
        advert: z
          .strictObject({ format: z.literal(1), role: z.int().min(0).max(255), chipId: hex })
          .nullable(),
      }),
    )
    .min(1),
});

/**
 * `pairing-srp.json`: SRP6a over RFC 5054's 3,072-bit group with SHA-512, as `esp_srp` computes
 * it, from fixed private values: every intermediate, so a mismatch can be found.
 */
export const pairingSrpVectorFile = z.strictObject({
  ...header,
  /** The ESP-IDF version and files the values were made from. */
  source: z.string(),
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        username: z.string(),
        /** The pairing code, the password. */
        password: z.string(),
        salt: hex,
        verifier: hex,
        clientPrivate: hex,
        clientPublic: hex,
        devicePrivate: hex,
        devicePublic: hex,
        u: hex,
        sessionKey: hex,
        clientProof: hex,
        deviceProof: hex,
      }),
    )
    .min(1),
});

/**
 * `pairing-security2.json`: a whole security 2 exchange as protobuf bytes, then sealed requests
 * and answers with their nonces, for one fixed SRP case of `pairing-srp.json` (named by `srpCase`).
 */
export const pairingSecurity2VectorFile = z.strictObject({
  ...header,
  source: z.string(),
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        srpCase: z.string(),
        command0: hex,
        response0: hex,
        command1: hex,
        response1: hex,
        /** The board's session id and first counter, as response 1's nonce. */
        nonce: hex,
        messages: z
          .array(
            z.strictObject({
              direction: z.enum(["toBoard", "toPhone"]),
              nonce: hex,
              plaintext: hex,
              sealed: hex,
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type PairingSrpVectorFile = z.infer<typeof pairingSrpVectorFile>;
export type PairingSecurity2VectorFile = z.infer<typeof pairingSecurity2VectorFile>;
