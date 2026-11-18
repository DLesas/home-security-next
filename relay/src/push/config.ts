/**
 * The push role's command line (docs/m4-design.md section 3, "Self-hosting" and "The operator's
 * keys"). Every key and credential is a path, read once at start through `safe/fs.ts`'s checks:
 *
 * ```text
 * bun relay/src/push/main.ts
 *   --socket <path>              the local socket the operator's relay opens
 *   [--socket-mode 600|660]      600 when the relay runs as the same account, 660 with a shared group
 *   [--listen <host:port> --tls-cert <path> --tls-key <path>]   for self-hosted relays
 *   [--apns-key <.p8 path> --apns-key-id <id> --apns-team <id> [--apns-topic <bundle id>]]
 *   [--fcm-account <service account path>]
 *   [--refused-relays <path>]    relay identities the operator refuses, one a line; read again on SIGHUP
 *   [--releases-socket <path>]   the releases role's forwarding socket (operated service only); without
 *                                it, release frames are answered with an empty offer and `unavailable`
 *   [--apns-production <origin> --apns-development <origin> --fcm-origin <origin> --test-ca <path>]
 *                                the stand-ins' addresses and certificate, for tests only
 * ```
 *
 * At least one listener and at least one of APNs and FCM. Nothing here is logged but the error.
 */
import { DEPLOYMENT } from "@hsn/deployment";
import { IDENTITY_TEXT, type PushEnvironment } from "@hsn/protocol/relay";
import { err, ok, type Result } from "neverthrow";
import { APNS_ORIGINS } from "./apns.ts";
import { type FcmAccount, readApnsKey, readFcmAccount } from "./credentials.ts";
import { type PushError, pushError } from "./errors.ts";
import { FCM_ORIGIN } from "./fcm.ts";
import type { ApnsSigner } from "./jwt.ts";
import { parseOptions } from "./safe/args.ts";
import { readPlainFile, readSecretFile, type SecretFileRules } from "./safe/fs.ts";

const ORIGIN = "push/config";

export const OPTION_NAMES = [
  "socket",
  "socket-mode",
  "listen",
  "tls-cert",
  "tls-key",
  "apns-key",
  "apns-key-id",
  "apns-team",
  "apns-topic",
  "fcm-account",
  "refused-relays",
  "releases-socket",
  "apns-production",
  "apns-development",
  "fcm-origin",
  "test-ca",
] as const;

export interface PushRoleConfig {
  readonly socketPath: string | undefined;
  readonly socketMode: number;
  readonly tcp:
    | {
        readonly hostname: string;
        readonly port: number;
        readonly tls: { readonly key: string; readonly cert: string };
      }
    | undefined;
  readonly apns:
    | {
        readonly signer: ApnsSigner;
        readonly topic: string;
        readonly origins: Readonly<Record<PushEnvironment, string>>;
      }
    | undefined;
  readonly fcm: { readonly account: FcmAccount; readonly origin: string } | undefined;
  readonly refusedPath: string | undefined;
  readonly releasesSocket: string | undefined;
  readonly testCa: string | undefined;
}

const configError = (message: string) => err(pushError("config", ORIGIN, message));

/** An origin as the stand-ins have it: `https://host:port`, nothing after. */
function origin(text: string | undefined, fallback: string): Result<string, PushError> {
  if (text === undefined) return ok(fallback);
  return /^https:\/\/[^/\s]+$/u.test(text)
    ? ok(text)
    : configError("an origin is https://host:port");
}

/** Reads the command line and every file it names. */
export function readConfig(
  args: readonly string[],
  rules: SecretFileRules,
): Result<PushRoleConfig, PushError> {
  const parsed = parseOptions(args, OPTION_NAMES);
  if (parsed.isErr()) return err(parsed.error);
  const o = parsed.value;
  const socketPath = o.socket;
  const modeText = o["socket-mode"] ?? "600";
  if (modeText !== "600" && modeText !== "660") return configError("--socket-mode is 600 or 660");

  let tcp: PushRoleConfig["tcp"];
  const listen = o.listen;
  if (listen !== undefined) {
    const match = /^(.+):(\d{1,5})$/u.exec(listen);
    const port = Number(match?.[2]);
    const hostname = match?.[1]?.replace(/^\[(.+)\]$/u, "$1");
    if (hostname === undefined || !(port >= 0 && port <= 65535)) {
      return configError("--listen is host:port");
    }
    const certPath = o["tls-cert"];
    const keyPath = o["tls-key"];
    if (certPath === undefined || keyPath === undefined) {
      return configError("--listen needs --tls-cert and --tls-key");
    }
    const cert = readPlainFile(certPath, "the TLS certificate");
    if (cert.isErr()) return err(cert.error);
    const key = readSecretFile(keyPath, "the TLS key", rules);
    if (key.isErr()) return err(key.error);
    tcp = { hostname, port, tls: { key: key.value, cert: cert.value } };
  }
  if (socketPath === undefined && tcp === undefined)
    return configError("give --socket, --listen or both");

  let apns: PushRoleConfig["apns"];
  const apnsKey = o["apns-key"];
  if (apnsKey !== undefined) {
    const keyId = o["apns-key-id"];
    const team = o["apns-team"];
    if (keyId === undefined || team === undefined) {
      return configError("--apns-key needs --apns-key-id and --apns-team");
    }
    const signer = readApnsKey(apnsKey, keyId, team, rules);
    if (signer.isErr()) return err(signer.error);
    const production = origin(o["apns-production"], APNS_ORIGINS.production);
    const development = origin(o["apns-development"], APNS_ORIGINS.development);
    if (production.isErr()) return err(production.error);
    if (development.isErr()) return err(development.error);
    apns = {
      signer: signer.value,
      topic: o["apns-topic"] ?? DEPLOYMENT.ios.bundleId,
      origins: { production: production.value, development: development.value },
    };
  }

  let fcm: PushRoleConfig["fcm"];
  const fcmPath = o["fcm-account"];
  if (fcmPath !== undefined) {
    const account = readFcmAccount(fcmPath, rules);
    if (account.isErr()) return err(account.error);
    const fcmOrigin = origin(o["fcm-origin"], FCM_ORIGIN);
    if (fcmOrigin.isErr()) return err(fcmOrigin.error);
    fcm = { account: account.value, origin: fcmOrigin.value };
  }
  if (apns === undefined && fcm === undefined) {
    return configError("give --apns-key, --fcm-account or both");
  }

  let testCa: string | undefined;
  const caPath = o["test-ca"];
  if (caPath !== undefined) {
    const ca = readPlainFile(caPath, "the test certificate authority");
    if (ca.isErr()) return err(ca.error);
    testCa = ca.value;
  }

  return ok({
    socketPath,
    socketMode: modeText === "660" ? 0o660 : 0o600,
    tcp,
    apns,
    fcm,
    refusedPath: o["refused-relays"],
    releasesSocket: o["releases-socket"],
    testCa,
  });
}

/**
 * The refused relay keys' file: one relay identity a line (26 characters of base32, as
 * `formatIdentity` writes it); blank lines and lines starting with `#` are skipped.
 */
export function readRefused(path: string): Result<ReadonlySet<string>, PushError> {
  return readPlainFile(path, "the refused relays").andThen((text) => {
    const refused = new Set<string>();
    const lines = text.split(/\r?\n/u);
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      if (!IDENTITY_TEXT.test(line)) {
        return configError(`the refused relays, line ${index + 1}: not a relay identity`);
      }
      refused.add(line);
    }
    return ok(refused);
  });
}
