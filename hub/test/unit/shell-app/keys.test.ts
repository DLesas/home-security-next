/**
 * The hub's keys for apps and what the shell tells the core before the listeners open
 * (m2-design.md sections 2, 4 and 5): the static X25519 key and the TLS certificate made at the
 * first start, written now in `hub_keys` and kept across starts; the certificate naming every
 * address, the host name and `<host>.local`, valid 800 days ‡, made again for a new address or at
 * 700 days ‡; its SHA-256 in `hubFacts`, followed by `timeZone`; the private keys in no error.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { appIdentityBytes, CERTIFICATE, LISTENER_PORTS } from "@hsn/protocol/app";
import { ensureHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { hostKey, hostNames, ipBytes, splitHost } from "../../../src/shell/app/addresses.ts";
import { ensureAppKeys, readHubKeysRow } from "../../../src/shell/app/app-keys.ts";
import {
  makeCertificate,
  readCertificate,
  renewalReason,
  storedMaterial,
} from "../../../src/shell/app/certificate.ts";
import { startupInputs, systemTimeZone } from "../../../src/shell/app/facts.ts";
import { HUB_VERSION } from "../../../src/shell/hub-facts.ts";
import { randomBytes } from "../../../src/shell/safe/crypto.ts";
import { expectNoKeyLeaks, noteKey, noteValue } from "../setup/support/leak-guard.ts";
import { openTestStore, TestClock, tempDir } from "../storage/fixtures.ts";

const folders: { remove(): void }[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

afterAll(() => {
  expectNoKeyLeaks();
});

const NAMES = { dns: ["hub", "hub.local"], ips: ["192.168.1.20", "fd00::20"] };
const NOW = Date.UTC(2026, 10, 15);
const random = (n: number) => randomBytes(n, "test");

describe("the certificate", () => {
  test("names every address, the host name and <host>.local, and is valid 800 days ‡", () => {
    const made = makeCertificate(NAMES, NOW, new Uint8Array(16).fill(0xff))._unsafeUnwrap();
    noteKey(made.privateKey);
    const parsed = new X509Certificate(made.certificate);
    expect(parsed.subjectAltName).toBe(
      "DNS:hub, DNS:hub.local, IP Address:192.168.1.20, IP Address:FD00:0:0:0:0:0:0:20",
    );
    expect(Date.parse(parsed.validTo) - NOW).toBe(CERTIFICATE.validityMs);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.serialNumber.startsWith("7F")).toBe(true);
    const info = readCertificate(made.certificate)._unsafeUnwrap();
    expect(info.sha256).toEqual(sha256(made.certificate));
    expect(storedMaterial(made.privateKey, made.certificate).isOk()).toBe(true);
  });

  test("is made again for a name it lacks, at 700 days ‡, or once expired; not otherwise", () => {
    const made = makeCertificate(NAMES, NOW, new Uint8Array(16).fill(1))._unsafeUnwrap();
    noteKey(made.privateKey);
    const info = readCertificate(made.certificate)._unsafeUnwrap();
    expect(renewalReason(info, NAMES, NOW)).toBeUndefined();
    expect(renewalReason(info, { dns: ["hub"], ips: ["192.168.1.20"] }, NOW)).toBeUndefined();
    expect(
      renewalReason(info, { ...NAMES, ips: [...NAMES.ips, "192.168.1.21"] }, NOW),
    ).toBeDefined();
    expect(
      renewalReason(info, { ...NAMES, ips: ["fd00:0::20", "192.168.1.20"] }, NOW),
    ).toBeUndefined();
    expect(renewalReason(info, NAMES, NOW + CERTIFICATE.renewAfterMs - 120_000)).toBeUndefined();
    expect(renewalReason(info, NAMES, NOW + CERTIFICATE.renewAfterMs)).toBeDefined();
    expect(renewalReason(info, NAMES, NOW + CERTIFICATE.validityMs)).toBeDefined();
  });

  test("a stored key that is not the certificate's is not used", () => {
    const a = makeCertificate(NAMES, NOW, new Uint8Array(16).fill(2))._unsafeUnwrap();
    const b = makeCertificate(NAMES, NOW, new Uint8Array(16).fill(3))._unsafeUnwrap();
    noteKey(a.privateKey);
    noteKey(b.privateKey);
    expect(storedMaterial(a.privateKey, b.certificate).isErr()).toBe(true);
    expect(storedMaterial(null, b.certificate).isErr()).toBe(true);
  });
});

describe("addresses and names", () => {
  test("IPv4 and IPv6 text to bytes, whatever way an address is written", () => {
    expect(ipBytes("192.168.1.20")).toEqual(Uint8Array.of(192, 168, 1, 20));
    expect(hostKey("FD00::20")).toBe(hostKey("fd00:0:0:0:0:0:0:20"));
    expect(hostKey("::ffff:192.168.1.20")).toBe(hostKey("::ffff:c0a8:114"));
    expect(ipBytes("fe80::1%en0")?.length).toBe(16);
    for (const bad of ["256.1.1.1", "1.2.3", "1::2::3", "hub", "1:2:3:4:5:6:7:8:9"])
      expect(ipBytes(bad)).toBeUndefined();
  });

  test("a Host header's host and port", () => {
    expect(splitHost("hub.local:8444")).toEqual({ host: "hub.local", port: 8444 });
    expect(splitHost("[fd00::20]:8444")).toEqual({ host: "fd00::20", port: 8444 });
    for (const bad of ["hub.local", "hub:0", "hub:70000", "a b:1", "[fd00::20]", "x@y:1"])
      expect(splitHost(bad)).toBeUndefined();
  });

  test("the host names: the name and <name>.local", () => {
    expect(hostNames("My-Hub.local")).toEqual(["my-hub", "my-hub.local"]);
    expect(hostNames("pi")).toEqual(["pi", "pi.local"]);
    expect(hostNames("bad name")).toEqual([]);
  });
});

describe("the app keys in hub_keys", () => {
  async function store() {
    const dir = tempDir("hsn-a2-keys-");
    const opened = openTestStore(dir.path, new TestClock());
    folders.push({
      remove: () => {
        opened.db.close(true);
        dir.remove();
      },
    });
    (await ensureHubKeys(opened.snapshot.hubKeys, opened.writer)).match(
      () => undefined,
      () => undefined,
    );
    return opened;
  }

  test("are made at the first start, written now, and the snapshot carries the public key only", async () => {
    const opened = await store();
    const keys = ensureAppKeys(opened.db, opened.writer, NAMES, NOW, random)._unsafeUnwrap();
    noteKey(keys.staticPrivate);
    noteKey(keys.tls.privateKey);
    const row = readHubKeysRow(opened.db)._unsafeUnwrap();
    expect(row?.appStaticPublic).toEqual(keys.staticPublic);
    expect(row?.tlsCertificate).toEqual(keys.tls.certificate);
    expect(keys.identity).toEqual(appIdentityBytes(sha256, keys.staticPublic));
    const snapshot = opened.reader.snapshot()._unsafeUnwrap();
    expect(snapshot.m2.appKeys).toEqual({ appStaticPublic: keys.staticPublic });
    noteValue(snapshot);
    expect(opened.writer.staged).toBe(0);
  });

  test("are kept at the next start, and the certificate is made again only for a new address", async () => {
    const opened = await store();
    const first = ensureAppKeys(opened.db, opened.writer, NAMES, NOW, random)._unsafeUnwrap();
    const again = ensureAppKeys(
      opened.db,
      opened.writer,
      NAMES,
      NOW + 1000,
      random,
    )._unsafeUnwrap();
    noteKey(first.staticPrivate);
    noteKey(first.tls.privateKey);
    expect(again.staticPrivate).toEqual(first.staticPrivate);
    expect(again.tls.certificate).toEqual(first.tls.certificate);
    const moved = ensureAppKeys(
      opened.db,
      opened.writer,
      { ...NAMES, ips: ["192.168.7.7"] },
      NOW + 2000,
      random,
    )._unsafeUnwrap();
    noteKey(moved.tls.privateKey);
    expect(moved.staticPrivate).toEqual(first.staticPrivate);
    expect(moved.tls.certificate).not.toEqual(first.tls.certificate);
    expect(readHubKeysRow(opened.db)._unsafeUnwrap()?.tlsCertificate).toEqual(
      moved.tls.certificate,
    );
    // The signing keys in the same row are untouched.
    expect(readHubKeysRow(opened.db)._unsafeUnwrap()?.signingPublic).toEqual(
      opened.reader.snapshot()._unsafeUnwrap().hubKeys?.signingPublic,
    );
  });

  test("need the signing keys first, and say so without a key in the error", () => {
    const dir = tempDir("hsn-a2-keys-");
    const opened = openTestStore(dir.path, new TestClock());
    folders.push({
      remove: () => {
        opened.db.close(true);
        dir.remove();
      },
    });
    const refused = ensureAppKeys(opened.db, opened.writer, NAMES, NOW, random);
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) noteValue(refused.error);
  });
});

describe("what the core is told before the listeners open", () => {
  test("hubFacts with the certificate's SHA-256, then timeZone", () => {
    const sha = sha256(Uint8Array.of(1));
    expect(startupInputs(["192.168.1.20"], sha, "Europe/London")).toEqual([
      {
        kind: "hubFacts",
        version: HUB_VERSION,
        addresses: ["192.168.1.20"],
        appsPort: LISTENER_PORTS.lan,
        consolePort: LISTENER_PORTS.console,
        certificateSha256: sha,
      },
      { kind: "timeZone", zone: "Europe/London" },
    ]);
  });

  test("the system's time zone is a zone name", () => {
    expect(systemTimeZone()).toMatch(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/u);
  });
});

describe("the certificate, checked independently by OpenSSL", () => {
  const openssl = Bun.which("openssl");
  if (openssl === null) {
    test.skip("openssl is not on this computer: the independent check is skipped", () => undefined);
    return;
  }

  function run(args: readonly string[], stdin?: Uint8Array): { code: number; out: string } {
    const done = Bun.spawnSync([openssl ?? "openssl", ...args], {
      stdin: stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: done.exitCode, out: done.stdout.toString() + done.stderr.toString() };
  }

  test("version 3, P-256, CA false (critical), server authentication, the names, 800 days, self-signed, its key", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { pem } = await import("../../../src/shell/app/certificate.ts");
    const now = Date.now();
    const made = makeCertificate(
      NAMES,
      now,
      crypto.getRandomValues(new Uint8Array(16)),
    )._unsafeUnwrap();
    noteKey(made.privateKey);
    const dir = mkdtempSync(join(tmpdir(), "hsn-a2-ossl-"));
    const cert = join(dir, "c.pem");
    const key = join(dir, "k.pem");
    writeFileSync(cert, pem("CERTIFICATE", made.certificate));
    writeFileSync(key, pem("PRIVATE KEY", made.privateKey), { mode: 0o600 });
    const text = run(["x509", "-in", cert, "-noout", "-text"]);
    rmSync(key);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Version: 3 (0x2)");
    expect(text.out).toMatch(/ASN1 OID: prime256v1|NIST CURVE: P-256/u);
    expect(text.out).toContain("Signature Algorithm: ecdsa-with-SHA256");
    expect(text.out).toMatch(/X509v3 Basic Constraints: critical\s+CA:FALSE/u);
    expect(text.out).toMatch(/X509v3 Extended Key Usage:\s*\n\s+TLS Web Server Authentication/u);
    expect(text.out).toMatch(
      /DNS:hub, DNS:hub\.local, IP Address:192\.168\.1\.20, IP Address:FD00:0:0:0:0:0:0:20/u,
    );
    const dates = run(["x509", "-in", cert, "-noout", "-startdate", "-enddate"]).out;
    const start = Date.parse(/notBefore=(.+)/u.exec(dates)?.[1] ?? "");
    const end = Date.parse(/notAfter=(.+)/u.exec(dates)?.[1] ?? "");
    expect(end - start).toBe(CERTIFICATE.validityMs + 60_000);
    expect(run(["verify", "-check_ss_sig", "-CAfile", cert, cert]).out).toContain(": OK");
    writeFileSync(key, pem("PRIVATE KEY", made.privateKey), { mode: 0o600 });
    const fromKey = run(["pkey", "-in", key, "-pubout"]);
    rmSync(key);
    const fromCert = run(["x509", "-in", cert, "-noout", "-pubkey"]);
    expect(fromKey.code).toBe(0);
    expect(fromKey.out.trim()).toBe(fromCert.out.trim());
    rmSync(dir, { recursive: true, force: true });
  });

  test.each([127, 128, 300])(
    "a name of %i bytes reads back whole, through both parsers",
    async (length) => {
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { pem } = await import("../../../src/shell/app/certificate.ts");
      // Labels of 60 characters, joined by dots, cut to exactly `length` bytes (none ends a dot).
      const long = `${"a".repeat(60)}.`.repeat(6).slice(0, length);
      expect(long.length).toBe(length);
      const names = { dns: [long], ips: ["fe80::1"] };
      const made = makeCertificate(names, NOW, new Uint8Array(16).fill(9))._unsafeUnwrap();
      noteKey(made.privateKey);
      expect(new X509Certificate(made.certificate).subjectAltName).toBe(
        `DNS:${long}, IP Address:FE80:0:0:0:0:0:0:1`,
      );
      expect(
        renewalReason(readCertificate(made.certificate)._unsafeUnwrap(), names, NOW),
      ).toBeUndefined();
      const dir = mkdtempSync(join(tmpdir(), "hsn-a2-ossl-"));
      writeFileSync(join(dir, "c.pem"), pem("CERTIFICATE", made.certificate));
      const text = run(["x509", "-in", join(dir, "c.pem"), "-noout", "-ext", "subjectAltName"]);
      rmSync(dir, { recursive: true, force: true });
      expect(text.out).toContain(`DNS:${long}`);
      expect(text.out).toContain("IP Address:FE80:0:0:0:0:0:0:1");
    },
  );
});

describe("the encoder's edges", () => {
  test("a serial whose top bit was set is made positive", () => {
    const made = makeCertificate(NAMES, NOW, new Uint8Array(16).fill(0xff))._unsafeUnwrap();
    noteKey(made.privateKey);
    expect(new X509Certificate(made.certificate).serialNumber).toBe(`7F${"FF".repeat(15)}`);
  });

  test("lengths: short below 128, then 0x81 and 0x82 forms", async () => {
    const { element } = await import("../../../src/shell/app/der.ts");
    expect([...element(0x04, new Uint8Array(127)).subarray(0, 2)]).toEqual([0x04, 127]);
    expect([...element(0x04, new Uint8Array(128)).subarray(0, 3)]).toEqual([0x04, 0x81, 128]);
    expect([...element(0x04, new Uint8Array(300)).subarray(0, 4)]).toEqual([
      0x04, 0x82, 0x01, 0x2c,
    ]);
  });

  test("times: UTCTime before 2050, GeneralizedTime from it", async () => {
    const { time } = await import("../../../src/shell/app/der.ts");
    const text = (bytes: Uint8Array) => [
      bytes[0],
      Buffer.from(bytes.subarray(2)).toString("latin1"),
    ];
    expect(text(time(Date.UTC(2049, 11, 31, 23, 59, 59)))).toEqual([0x17, "491231235959Z"]);
    expect(text(time(Date.UTC(2050, 0, 1, 0, 0, 0)))).toEqual([0x18, "20500101000000Z"]);
    // A certificate made in 2049 ends in 2052: both encodings in one, both read back.
    const made = makeCertificate(
      NAMES,
      Date.UTC(2049, 5, 1),
      new Uint8Array(16).fill(4),
    )._unsafeUnwrap();
    noteKey(made.privateKey);
    const parsed = new X509Certificate(made.certificate);
    expect(Date.parse(parsed.validFrom)).toBe(Date.UTC(2049, 5, 1) - 60_000);
    expect(Date.parse(parsed.validTo)).toBe(Date.UTC(2049, 5, 1) + CERTIFICATE.validityMs);
  });

  test("an IPv6 address is its 16 bytes", () => {
    const made = makeCertificate(
      { dns: [], ips: ["2001:db8::8a2e:370:7334"] },
      NOW,
      new Uint8Array(16).fill(2),
    )._unsafeUnwrap();
    noteKey(made.privateKey);
    expect(new X509Certificate(made.certificate).subjectAltName).toBe(
      "IP Address:2001:DB8:0:0:0:8A2E:370:7334",
    );
  });
});
