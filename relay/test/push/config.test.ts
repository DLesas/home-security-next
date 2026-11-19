/**
 * The push role's command line and key files: each refused as section 3's "The operator's keys"
 * has it (readable by others, another account's, inside the program's folder, not of its kind),
 * and no refusal quoting what it read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { readConfig, readRefused } from "../../src/push/config.ts";
import { readApnsKey, readFcmAccount } from "../../src/push/credentials.ts";
import { serviceAccountJson, writeSecretFile } from "../../../tools/push-standins/src/index.ts";
import { expectNoSecret, pemLines, REPO, type StandIns, standIns } from "./helpers.ts";

let open: StandIns | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const rules = () => ({ programFolder: REPO, uid: process.getuid?.() });

async function setUp() {
  const s = await standIns();
  open = s;
  const base = [
    "--socket",
    join(s.folder, "push.sock"),
    "--apns-key",
    s.apnsKeyPath,
    "--apns-key-id",
    s.apnsKey.keyId,
    "--apns-team",
    s.apnsKey.teamId,
    "--fcm-account",
    s.fcmAccountPath,
  ];
  const secrets = [...pemLines(s.apnsKey.privatePem), ...pemLines(s.account.privatePem)];
  return { s, base, secrets };
}

const message = (result: { isErr(): boolean; error?: unknown }) => JSON.stringify(result);

describe("the command line", () => {
  test("a full one reads both services, the real origins by default", async () => {
    const { s, base } = await setUp();
    const config = readConfig(base, rules())._unsafeUnwrap();
    expect(config.socketMode).toBe(0o600);
    expect(config.apns?.origins).toEqual({
      production: "https://api.push.apple.com",
      development: "https://api.sandbox.push.apple.com",
    });
    expect(config.apns?.signer.keyId).toBe(s.apnsKey.keyId);
    expect(config.fcm?.origin).toBe("https://fcm.googleapis.com");
    expect(config.fcm?.account.projectId).toBe(s.account.projectId);
    expect(config.fcm?.account.tokenUri).toBe(s.fcm.tokenUri);
    expect(config.tcp).toBeUndefined();
    expect(config.releasesSocket).toBeUndefined();
    const withReleases = readConfig(
      [...base, "--releases-socket", "/run/hsn/releases.sock"],
      rules(),
    );
    expect(withReleases._unsafeUnwrap().releasesSocket).toBe("/run/hsn/releases.sock");
  });

  test("refusals: no listener, no service, a half-given APNs key, a bad mode, a bad origin, --listen without TLS", async () => {
    const { s, base } = await setUp();
    const cases: [readonly string[], string][] = [
      [
        [
          "--apns-key",
          s.apnsKeyPath,
          "--apns-key-id",
          s.apnsKey.keyId,
          "--apns-team",
          s.apnsKey.teamId,
        ],
        "give --socket, --listen or both",
      ],
      [["--socket", "x.sock"], "give --apns-key, --fcm-account or both"],
      [
        ["--socket", "x.sock", "--apns-key", s.apnsKeyPath],
        "--apns-key needs --apns-key-id and --apns-team",
      ],
      [[...base, "--socket-mode", "666"], "--socket-mode is 600 or 660"],
      [[...base, "--apns-production", "http://127.0.0.1:1"], "an origin is https://host:port"],
      [[...base, "--listen", "0.0.0.0:443"], "--listen needs --tls-cert and --tls-key"],
      [[...base, "--listen", "nonsense"], "--listen is host:port"],
      [
        [...base.slice(0, 6), "--apns-team", "lowercase1"],
        "the Apple team id is not ten letters and digits",
      ],
    ];
    for (const [args, expected] of cases) {
      const result = readConfig(args, rules());
      expect(result.isErr() ? result.error.message : "accepted").toBe(expected);
    }
  });

  test("an unexpected argument is refused without quoting it", async () => {
    const { base } = await setUp();
    const result = readConfig([...base, "SECRET-VALUE-0123"], rules());
    expect(result.isErr()).toBe(true);
    expect(message(result)).not.toContain("SECRET-VALUE-0123");
    expect(message(result)).toContain("ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL");
  });
});

describe("the key files", () => {
  // Windows access lists do not expose POSIX group and other permission bits.
  test.skipIf(process.platform === "win32")(
    "readable by the group or others: refused",
    async () => {
      const { s, secrets } = await setUp();
      for (const mode of [0o640, 0o604, 0o620]) {
        chmodSync(s.apnsKeyPath, mode);
        const result = readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, rules());
        expect(result.isErr() ? result.error.message : "read").toBe(
          "the APNs key may be read by others; make it 0600",
        );
        expectNoSecret(message(result), secrets);
      }
      chmodSync(s.apnsKeyPath, 0o400);
      expect(readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, rules()).isOk()).toBe(
        true,
      );
    },
  );

  test("another account's: refused", async () => {
    const { s } = await setUp();
    const uid = process.getuid?.() ?? 0;
    const result = readFcmAccount(s.fcmAccountPath, { programFolder: REPO, uid: uid + 1 });
    expect(result.isErr() ? result.error.message : "read").toBe(
      "the FCM service account belongs to another account",
    );
  });

  test("inside the program's folder: refused, even through another path", async () => {
    const { s } = await setUp();
    const result = readApnsKey(s.apnsKeyPath, s.apnsKey.keyId, s.apnsKey.teamId, {
      programFolder: s.folder,
      uid: process.getuid?.(),
    });
    expect(result.isErr() ? result.error.message : "read").toBe(
      "the APNs key is inside the program's folder; keep it outside",
    );
    const viaDots = join(s.folder, "..", s.folder.split("/").at(-1) ?? "", "AuthKey.p8");
    expect(
      readApnsKey(viaDots, s.apnsKey.keyId, s.apnsKey.teamId, {
        programFolder: s.folder,
        uid: process.getuid?.(),
      }).isErr(),
    ).toBe(true);
  });

  test("missing: refused with the code only", async () => {
    const { s } = await setUp();
    const result = readApnsKey(
      join(s.folder, "nope.p8"),
      s.apnsKey.keyId,
      s.apnsKey.teamId,
      rules(),
    );
    expect(result.isErr() ? result.error : undefined).toMatchObject({
      kind: "credentials",
      detail: { code: "ENOENT" },
    });
  });

  test("not of its kind: an RSA key for APNs, a P-256 key in the service account", async () => {
    const { s, secrets } = await setUp();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const rsaPath = writeSecretFile(s.folder, "rsa.p8", rsa);
    expect(rsaPath.ok).toBe(true);
    const wrongApns = readApnsKey(
      join(s.folder, "rsa.p8"),
      s.apnsKey.keyId,
      s.apnsKey.teamId,
      rules(),
    );
    expect(wrongApns.isErr() ? wrongApns.error.message : "read").toBe(
      "the APNs key is not a P-256 private key",
    );
    const ecAccount = serviceAccountJson({ ...s.account, privatePem: ec }, s.fcm.tokenUri);
    writeSecretFile(s.folder, "ec.json", ecAccount);
    const wrongFcm = readFcmAccount(join(s.folder, "ec.json"), rules());
    expect(wrongFcm.isErr() ? wrongFcm.error.message : "read").toBe(
      "the FCM service account's key is not RSA",
    );
    expectNoSecret(message(wrongApns) + message(wrongFcm), [
      ...secrets,
      ...pemLines(rsa),
      ...pemLines(ec),
    ]);
  });

  test("a service account that is not JSON, or lacks fields: refused, naming fields only", async () => {
    const { s, secrets } = await setUp();
    const text = serviceAccountJson(s.account, s.fcm.tokenUri);
    writeSecretFile(s.folder, "broken.json", text.slice(0, text.length - 40));
    const broken = readFcmAccount(join(s.folder, "broken.json"), rules());
    expect(broken.isErr() ? broken.error.message : "read").toBe(
      "the FCM service account is not JSON",
    );
    const parsed = JSON.parse(text) as Record<string, unknown>;
    writeSecretFile(
      s.folder,
      "partial.json",
      JSON.stringify({ ...parsed, type: "user", token_uri: "http://insecure" }),
    );
    const partial = readFcmAccount(join(s.folder, "partial.json"), rules());
    expect(partial.isErr() ? partial.error.message : "read").toBe(
      "the FCM service account lacks or misstates: type, token_uri",
    );
    writeSecretFile(
      s.folder,
      "badkey.json",
      JSON.stringify({
        ...parsed,
        private_key: "-----BEGIN PRIVATE KEY-----\nAAAAsecretish\n-----END PRIVATE KEY-----\n",
      }),
    );
    const badKey = readFcmAccount(join(s.folder, "badkey.json"), rules());
    expect(badKey.isErr()).toBe(true);
    expectNoSecret(message(broken) + message(partial) + message(badKey), [
      ...secrets,
      "AAAAsecretish",
    ]);
  });

  // This case proves refusal specifically through the TLS key's POSIX mode.
  test.skipIf(process.platform === "win32")("the TLS key is read as a secret too", async () => {
    const { s, base } = await setUp();
    const keyPath = join(s.folder, "tls.key");
    writeFileSync(keyPath, "not a key", { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    const result = readConfig(
      [...base, "--listen", "127.0.0.1:0", "--tls-cert", keyPath, "--tls-key", keyPath],
      rules(),
    );
    expect(result.isErr() ? result.error.message : "read").toBe(
      "the TLS key may be read by others; make it 0600",
    );
  });
});

describe("the refused relays", () => {
  test("one identity a line, comments and blanks skipped; anything else refused with its line", async () => {
    const { s } = await setUp();
    const path = join(s.folder, "refused");
    const a = "a".repeat(26);
    const b = "b".repeat(26);
    writeFileSync(path, `# operator's list\n\n${a}\n  ${b}  \n`);
    expect([...readRefused(path)._unsafeUnwrap()]).toEqual([a, b]);
    writeFileSync(path, `${a}\nnot-an-identity\n`);
    const result = readRefused(path);
    expect(result.isErr() ? result.error.message : "read").toBe(
      "the refused relays, line 2: not a relay identity",
    );
  });
});
