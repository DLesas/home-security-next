/**
 * Keys made for one test, never real ones (docs/m3-m4-plan.md, rule 6): an APNs authentication
 * key as Apple hands it out (a P-256 key in PKCS #8 PEM, the `.p8` file ‡), with a key id and a
 * team id of Apple's form (ten characters ‡); and a Google service account file as the Firebase
 * console makes it (JSON with an RSA key in PKCS #8 PEM ‡), whose `token_uri` points at the FCM
 * stand-in. `writeSecretFile` writes one as the push role expects to find it: readable only by
 * its owner.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fail, ok, type Result } from "./result.ts";
import { attempt } from "./safe/attempt.ts";

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Ten characters of Apple's identifier form ‡. */
function appleIdentifier(): string {
  return Array.from(randomBytes(10), (b) => ALPHANUMERIC[b % ALPHANUMERIC.length] ?? "A").join("");
}

export interface ApnsTestKey {
  readonly keyId: string;
  readonly teamId: string;
  /** The `.p8` file's text: PKCS #8 PEM. */
  readonly privatePem: string;
  /** SPKI PEM, which the stand-in checks JWTs against. */
  readonly publicPem: string;
}

/** A fresh APNs key, key id and team id. */
export function makeApnsTestKey(): Result<ApnsTestKey, string> {
  const made = attempt(() => generateKeyPairSync("ec", { namedCurve: "P-256" }));
  if (!made.ok) return fail(made.error);
  return ok({
    keyId: appleIdentifier(),
    teamId: appleIdentifier(),
    privatePem: made.value.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicPem: made.value.publicKey.export({ type: "spki", format: "pem" }),
  });
}

export interface FcmTestAccount {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly privatePem: string;
  readonly publicPem: string;
}

/** A fresh service account with a 2,048-bit RSA key. */
export function makeFcmTestAccount(): Result<FcmTestAccount, string> {
  const made = attempt(() => generateKeyPairSync("rsa", { modulusLength: 2048 }));
  if (!made.ok) return fail(made.error);
  const projectId = `standin-${randomBytes(4).toString("hex")}`;
  return ok({
    projectId,
    clientEmail: `firebase-adminsdk@${projectId}.iam.gserviceaccount.com`,
    privateKeyId: randomBytes(20).toString("hex"),
    privatePem: made.value.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicPem: made.value.publicKey.export({ type: "spki", format: "pem" }),
  });
}

/** The service account file's text, as the Firebase console makes it ‡, with `token_uri` given. */
export function serviceAccountJson(account: FcmTestAccount, tokenUri: string): string {
  return JSON.stringify(
    {
      type: "service_account",
      project_id: account.projectId,
      private_key_id: account.privateKeyId,
      private_key: account.privatePem,
      client_email: account.clientEmail,
      client_id: "100000000000000000000",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: tokenUri,
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/standin",
      universe_domain: "googleapis.com",
    },
    null,
    2,
  );
}

/** Writes `text` to `<folder>/<name>`, readable and writable only by its owner (0600). */
export function writeSecretFile(
  folder: string,
  name: string,
  text: string,
): Result<string, string> {
  const path = join(folder, name);
  const written = attempt(() => {
    writeFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  });
  return written.ok ? ok(path) : fail(written.error);
}
