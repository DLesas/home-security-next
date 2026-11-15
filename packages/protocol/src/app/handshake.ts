/**
 * The payloads of the channel's handshakes (docs/m2-design.md section 5): a session (IK), a link
 * and a restore (XXpsk3). Each is UTF-8 JSON in its Noise message.
 */
import { z } from "zod";
import { requestFrame } from "./envelope.ts";
import {
  base64urlBytes,
  bootValue,
  clientKind,
  clientRef,
  displayName,
  liveRevision,
  personRef,
  wallMs,
} from "./values.ts";

const version = z.int().min(1).max(0xffff);

/** A feature's name: 1 to 32 characters, `^[a-z][a-zA-Z0-9]*$` (section 5). */
const featureName = z
  .string()
  .max(32)
  .regex(/^[a-z][a-zA-Z0-9]*$/u, "a feature's name");

/** The features version 1 defines: none. Each later one is defined in section 5 when added. */
export const HUB_FEATURES: readonly string[] = [];

/** A range of channel versions a client speaks, lowest first. */
export const protoRange = z
  .tuple([version, version])
  .refine(([min, max]) => min <= max, "the lower version first");

/** IK message 1, client → hub: the versions it speaks, its app's version, and `first`. */
export const clientHello = z
  .strictObject({
    proto: protoRange,
    app: z.string().min(1).max(64),
    /** A request acted on at once (stack.md, D51); it may be replayed, so it must carry `seq`. */
    first: requestFrame.optional(),
  })
  .readonly();

/** IK message 2, hub → client: `proto` is the highest version both speak. */
export const hubHello = z
  .strictObject({
    proto: version,
    hub: z.string().min(1).max(64),
    boot: bootValue,
    rev: liveRevision,
    client: z
      .strictObject({ id: clientRef, person: personRef.nullable(), kind: clientKind })
      .readonly(),
    /**
     * Optional capabilities of this hub that change no message's shape (section 5). Version 1
     * defines none and the hub sends `[]`; a client ignores a name it does not know and works
     * fully with none.
     */
    features: z.array(featureName).max(32).readonly(),
  })
  .readonly();

/**
 * XXpsk3 message 1 (in clear), for linking and restore: the versions the new client speaks, and
 * the token's lookup: 8 hex digits for a 128-bit secret, or a typed code's 4-character token id
 * (linking only; restore never uses a typed code).
 */
export const linkHello = z
  .strictObject({
    proto: protoRange,
    find: z.union([
      z.string().regex(/^[0-9a-f]{8}$/u, "8 hex digits"),
      z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}$/u, "a typed code's token id"),
    ]),
  })
  .readonly();

/**
 * XXpsk3 message 2's payload, hub → new client, for linking and restore: the hub's version and
 * the highest channel version both speak. With none, the hub closes before message 2, which is
 * no failed try.
 */
export const linkHubPayload = z
  .strictObject({
    hub: z.string().min(1).max(64),
    proto: version,
    /** Linking: the token makes a new person whose name was not given, so the client asks for one; false for a restore. */
    askName: z.boolean(),
  })
  .readonly();

/** XXpsk3 message 3, new client → hub: only a name and a kind, nothing it must keep secret. */
export const linkRequest = z
  .strictObject({
    name: displayName,
    kind: z.enum(["web", "phone"]),
    person: z.strictObject({ name: displayName }).readonly().optional(),
  })
  .readonly();

/** The backup key and its epoch, as a phone holds them (D78, section 9). */
export const backupKeyPayload = z
  .strictObject({ key: base64urlBytes.length(43), epoch: z.int().min(0) })
  .readonly();

/** Message 4, the hub's first transport message: the client's number and person; a phone's backup key. */
export const linkResult = z
  .strictObject({
    client: clientRef,
    person: personRef.nullable(),
    backupKey: backupKeyPayload.optional(),
  })
  .readonly();

// ----- Restore (section 5, "Restore's messages"; section 9) -----
// Messages 1 and 2 are `linkHello` and `linkHubPayload`, under the restore prologue.

/** Restore message 3, phone → hub: nothing secret. */
export const restoreHello = z.strictObject({ app: z.string().min(1).max(64) }).readonly();

/**
 * Restore message 4, hub → phone, the first transport message, which proves the hub knows the
 * pre-shared key: the file's hub identity (26 characters), its backup key's epoch, when it was
 * made, and how old its people and permissions are.
 */
export const restoreOffer = z
  .strictObject({
    identity: z.string().regex(/^[a-z2-7]{26}$/u, "26 characters of lower-case base32"),
    epoch: z.int().min(0),
    madeMs: wallMs,
    lastChangeMs: wallMs,
  })
  .readonly();

/**
 * Restore message 5, phone → hub: the backup key, sent only after message 4 decrypted, and only
 * for the identity and epoch it names.
 */
export const restoreKey = backupKeyPayload;

/**
 * Restore message 6, hub → phone; then the hub closes, and on success restarts as the restored hub
 * (m2-design.md section 9). A file whose first chunk does not open with the phone's key is
 * `wrongKey` ("this key does not open that backup"); any later failure (`truncated`, `cut`, or
 * `decryptFailed` after chunk 0) is a damaged file, `badFile` ("the backup file is damaged or
 * incomplete; choose another"), on the phone and on the console alike.
 * TODO(A7): the phone's and the console's restore pages say `badFile` as above, apart from
 * `wrongKey`.
 */
export const restoreResult = z
  .discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true) }).readonly(),
    z
      .strictObject({
        ok: z.literal(false),
        reason: z.enum(["wrongKey", "badFile", "expired", "busy"]),
      })
      .readonly(),
  ])
  .readonly();

export type ClientHello = z.infer<typeof clientHello>;
export type HubHello = z.infer<typeof hubHello>;
export type LinkHello = z.infer<typeof linkHello>;
export type LinkHubPayload = z.infer<typeof linkHubPayload>;
export type LinkRequest = z.infer<typeof linkRequest>;
export type LinkResult = z.infer<typeof linkResult>;
export type BackupKeyPayload = z.infer<typeof backupKeyPayload>;
export type RestoreHello = z.infer<typeof restoreHello>;
export type RestoreOffer = z.infer<typeof restoreOffer>;
export type RestoreKey = z.infer<typeof restoreKey>;
export type RestoreResult = z.infer<typeof restoreResult>;
