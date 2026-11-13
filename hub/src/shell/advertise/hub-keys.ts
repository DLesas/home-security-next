/**
 * The hub's firmware-signing key pair (hub-design.md section 9; protocol.md §9): P-256, made at
 * the first start with Web Crypto and written through at once, before the boot event reads the
 * snapshot, so the core has the public key and identity that pairing data and mDNS carry. The
 * private half (PKCS #8) goes to the writer and nowhere else: it is never returned, printed,
 * logged or recorded.
 *
 * Every call into Web Crypto goes through `shell/safe/crypto.ts` (section 10).
 */
import { HUB_IDENTITY_LENGTH, hubIdentity, SIGNING_KEY_LENGTH } from "@hsn/protocol";
import type { Result } from "neverthrow";
import { err, errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { HubKeysRow } from "../../core/model/rows.ts";
import type { Writer } from "../../ports/writer.ts";
import { cryptoCall, subtle as safeSubtle } from "../safe/crypto.ts";

const ORIGIN = "shell/advertise/hub-keys";

/** The hub's keys as the core sees them: never the private half (`DurableSnapshot.hubKeys`). */
export type HubPublicKeys = Omit<HubKeysRow, "signingPrivate">;

/** A P-256 public key exported raw: 0x04, then X and Y (SEC 1). */
const UNCOMPRESSED_POINT = 0x04;
const RAW_PUBLIC_LENGTH = 1 + SIGNING_KEY_LENGTH;

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

function cryptoError(message: string): HubError {
  return { kind: "crypto", origin: ORIGIN, message };
}

const identityOf = (key: Uint8Array) =>
  cryptoCall(ORIGIN, "the hub identity could not be computed", () => hubIdentity(key));

/** X then Y, 64 bytes (§9), from Web Crypto's raw export. */
function publicXY(raw: Uint8Array): Result<Uint8Array, HubError> {
  if (raw.length !== RAW_PUBLIC_LENGTH || raw[0] !== UNCOMPRESSED_POINT) {
    return err(cryptoError("the public key is not an uncompressed P-256 point"));
  }
  return ok(raw.slice(1));
}

/** A new key pair and its identity (§9). */
export function makeHubKeys(
  subtle: SubtleCrypto = crypto.subtle,
): ResultAsync<HubKeysRow, HubError> {
  const generated = safeSubtle(
    ORIGIN,
    "the signing key pair could not be made",
    (s) => s.generateKey(ALGORITHM, true, ["sign", "verify"]),
    subtle,
  );
  return generated.andThen((pair) =>
    ResultAsync.combine([
      safeSubtle(
        ORIGIN,
        "the private key could not be exported",
        (s) => s.exportKey("pkcs8", pair.privateKey),
        subtle,
      ),
      safeSubtle(
        ORIGIN,
        "the public key could not be exported",
        (s) => s.exportKey("raw", pair.publicKey),
        subtle,
      ),
    ]).andThen(([pkcs8, raw]) =>
      publicXY(new Uint8Array(raw)).andThen((signingPublic) =>
        identityOf(signingPublic).map((identity): HubKeysRow => ({
          signingPrivate: new Uint8Array(pkcs8),
          signingPublic,
          identity,
        })),
      ),
    ),
  );
}

/** The public half and identity, checked: the identity must be the hash of the key (§9). */
export function checkHubKeys(keys: HubPublicKeys): Result<HubPublicKeys, HubError> {
  if (
    keys.signingPublic.length !== SIGNING_KEY_LENGTH ||
    keys.identity.length !== HUB_IDENTITY_LENGTH
  ) {
    return err({
      kind: "config",
      origin: ORIGIN,
      message: "the stored hub keys have the wrong length",
    });
  }
  return identityOf(keys.signingPublic).andThen((identity) =>
    identity.every((byte, i) => byte === keys.identity[i])
      ? ok(keys)
      : err<HubPublicKeys, HubError>({
          kind: "config",
          origin: ORIGIN,
          message: "the stored hub identity is not the hash of the stored signing key",
        }),
  );
}

/**
 * The hub's keys at start: those stored, checked, or at the first start a new pair, staged as a
 * `hub_keys` row written now and committed before this returns. Only the public half comes back,
 * for the boot snapshot.
 */
export function ensureHubKeys(
  stored: HubPublicKeys | undefined,
  writer: Pick<Writer, "stage" | "flush">,
  subtle: SubtleCrypto = crypto.subtle,
): ResultAsync<HubPublicKeys, HubError> {
  if (stored !== undefined) {
    const checked = checkHubKeys(stored);
    return checked.isOk() ? okAsync(checked.value) : errAsync(checked.error);
  }
  return makeHubKeys(subtle).andThen((row) => {
    writer.stage([
      { kind: "write", durability: "now", op: { table: "hub_keys", op: "upsert", row } },
    ]);
    const committed = writer.flush("now");
    return committed.isOk()
      ? okAsync({ signingPublic: row.signingPublic, identity: row.identity })
      : errAsync<HubPublicKeys, HubError>(committed.error);
  });
}
