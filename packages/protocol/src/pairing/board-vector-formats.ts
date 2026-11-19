/**
 * The formats of the two pairing vector files P3 adds beside the four step 0 froze
 * (`vector-formats.ts`), both made by ESP-IDF's own code (`esp-idf/make-vectors.sh`):
 *
 * - `pairing-board-script.json`: what a board running protocomm security 2 does with each write,
 *   in order, on one connection: whole pairings, a wrong code, and every refusal (public values,
 *   order, size, version, tampered, replayed and reordered sealed requests). A script for the
 *   scripted boards (P6) and a check for the real one (F1).
 * - `pairing-security2-counter.json`: the session counter at its top, where it wraps.
 *
 * Bytes are lowercase hex, as in every vector file.
 */
import { z } from "zod";

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/u, "lowercase hex, whole bytes");
const header = { schemaVersion: z.literal(1), description: z.string(), source: z.string() };

export const PAIRING_BOARD_VECTOR_FILES = {
  script: "pairing-board-script.json",
  counter: "pairing-security2-counter.json",
} as const;

export const pairingBoardScriptVectorFile = z.strictObject({
  ...header,
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        /** The board's salt and verifier, and the code, are this `pairing-srp.json` case's. */
        srpCase: z.string(),
        /** The password the phone's first attempt used, when it is not the case's. */
        wrongPassword: z.string().nullable(),
        /** The random values the board drew, in order: b for each command 0 that reached the SRP
         * code, the session id for each command 1 it accepted. */
        boardDraws: z.array(hex),
        /** The phone's a for each command 0 made from one, in order. */
        clientPrivates: z.array(hex),
        steps: z
          .array(
            z.strictObject({
              endpoint: z.enum(["proto-ver", "prov-session", "hsn-setup"]),
              request: hex,
              /** What a read returns after the write; null when the write was refused. */
              answer: hex.nullable(),
              /** The protocomm security event the board posted. */
              event: z.enum(["setupOk", "invalidSecurityParams", "credentialsMismatch"]).nullable(),
              /** The first error ESP-IDF logged, when the write was refused. */
              boardLog: z.string().nullable(),
              /** Whether the board's hsn-setup handler ran. */
              setupHandlerRan: z.boolean(),
              note: z.string().optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export const pairingCounterVectorFile = z.strictObject({
  ...header,
  srpCase: z.string(),
  /** The first 32 bytes of the case's session key: the AES-256-GCM key. */
  key: hex,
  /** The board's 8-byte session id. */
  sessionId: hex,
  cases: z
    .array(
      z.strictObject({
        name: z.string(),
        startCounter: z.int().min(0).max(0xffffffff),
        messages: z
          .array(
            z.strictObject({
              direction: z.enum(["toBoard", "toPhone"]),
              counter: z.int().min(0).max(0xffffffff),
              nonce: hex,
              plaintext: hex,
              sealed: hex,
              refused: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type PairingBoardScriptVectorFile = z.infer<typeof pairingBoardScriptVectorFile>;
export type PairingCounterVectorFile = z.infer<typeof pairingCounterVectorFile>;
