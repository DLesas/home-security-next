/**
 * The publisher's credentials (docs/m4-design.md section 3, "The operator's keys"; section 5):
 * the APNs key (a `.p8` file: PKCS #8 PEM, P-256 ‡) with its key id and team id, and the
 * Firebase service account (a JSON file with an RSA key ‡). Read once at start, from paths given
 * on the command line, through `safe/fs.ts`'s checks: never from the program's folder, never a
 * file others may read. Their text is not kept, logged or put in an error.
 */
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { type PushError, pushError } from "./errors.ts";
import type { ApnsSigner, GoogleAccount } from "./jwt.ts";
import { privateKeyFromPem } from "./safe/crypto.ts";
import { readSecretFile, type SecretFileRules } from "./safe/fs.ts";
import { parseJson } from "./safe/json.ts";

const ORIGIN = "push/credentials";

/** An Apple key id or team id: ten upper-case letters and digits ‡. */
export const APPLE_ID = /^[A-Z0-9]{10}$/u;

/** Reads the APNs key and checks it is a P-256 key; `keyId` and `teamId` come from the command line. */
export function readApnsKey(
  path: string,
  keyId: string,
  teamId: string,
  rules: SecretFileRules,
): Result<ApnsSigner, PushError> {
  if (!APPLE_ID.test(keyId)) {
    return err(pushError("config", ORIGIN, "the APNs key id is not ten letters and digits"));
  }
  if (!APPLE_ID.test(teamId)) {
    return err(pushError("config", ORIGIN, "the Apple team id is not ten letters and digits"));
  }
  return readSecretFile(path, "the APNs key", rules)
    .andThen((pem) => privateKeyFromPem(pem, "the APNs key"))
    .andThen((key) =>
      key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1"
        ? ok({ keyId, teamId, key })
        : err(pushError("credentials", ORIGIN, "the APNs key is not a P-256 private key")),
    );
}

/** The fields of a service account file the push role reads ‡; others are ignored. */
const serviceAccountFile = z.object({
  type: z.literal("service_account"),
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/u),
  private_key_id: z.string().min(1).max(128),
  private_key: z.string().min(1),
  client_email: z.string().regex(/^[^\s@]+@[^\s@]+$/u),
  token_uri: z.url({ protocol: /^https$/u }),
});

export interface FcmAccount extends GoogleAccount {
  readonly projectId: string;
}

/** Reads the Firebase service account and checks its key is an RSA private key. */
export function readFcmAccount(
  path: string,
  rules: SecretFileRules,
): Result<FcmAccount, PushError> {
  return readSecretFile(path, "the FCM service account", rules)
    .andThen((text) => parseJson(text, "credentials", ORIGIN, "the FCM service account"))
    .andThen((json) => {
      const parsed = serviceAccountFile.safeParse(json);
      if (!parsed.success) {
        // Only the fields' names: their values may be the key.
        const fields = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
        return err(
          pushError(
            "credentials",
            ORIGIN,
            `the FCM service account lacks or misstates: ${fields.join(", ")}`,
          ),
        );
      }
      const file = parsed.data;
      return privateKeyFromPem(file.private_key, "the FCM service account's key").andThen((key) =>
        key.asymmetricKeyType === "rsa"
          ? ok({
              projectId: file.project_id,
              clientEmail: file.client_email,
              privateKeyId: file.private_key_id,
              key,
              tokenUri: file.token_uri,
            })
          : err(pushError("credentials", ORIGIN, "the FCM service account's key is not RSA")),
      );
    });
}
