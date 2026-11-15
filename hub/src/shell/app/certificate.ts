/**
 * The hub's own TLS certificate (m2-design.md section 5, "The certificate"): a P-256 key and a
 * self-signed certificate naming every address the computer has on the home network, its host
 * name and `<host>.local`, valid 800 days ‡. A new address, or the certificate's age reaching
 * 700 days ‡, means a new one. Its SHA-256 is the fingerprint the console shows and the link
 * formats carry (`hubFacts.certificateSha256`).
 *
 * No key usage extension: a self-signed certificate is its own issuer, and TLS clients that look
 * for its issuer refuse one whose key usage lacks certificate signing.
 *
 * The certificate is built here (`der.ts`) and signed with `node:crypto`; it is read back only
 * through `node:crypto`'s own X.509 parser. Every call that can throw goes through
 * `shell/safe/crypto.ts`. The private key goes to `hub_keys` and to the listener, never to a
 * record, an error or a log.
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  X509Certificate,
} from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { CERTIFICATE } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import { cryptoCall } from "../safe/crypto.ts";
import { hostKey, ipBytes } from "./addresses.ts";
import {
  bitString,
  boolean,
  oid,
  octetString,
  sequence,
  set,
  smallInteger,
  tagged,
  time,
  unsignedInteger,
  utf8String,
} from "./der.ts";

const ORIGIN = "shell/app/certificate";

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** What the certificate names: host names and addresses (section 5). */
export interface CertificateNames {
  readonly dns: readonly string[];
  readonly ips: readonly string[];
}

/** A key and its certificate, as `hub_keys` keeps them. */
export interface TlsMaterial {
  /** PKCS #8, DER. */
  readonly privateKey: Uint8Array;
  /** DER. */
  readonly certificate: Uint8Array;
}

/** What the hub reads back from its certificate. */
export interface CertificateInfo {
  readonly sha256: Uint8Array;
  readonly notBeforeMs: number;
  readonly notAfterMs: number;
  /** Every name and address, as `hostKey` makes them comparable. */
  readonly names: ReadonlySet<string>;
}

function algorithm(): Uint8Array {
  return sequence(oid(OID.ecdsaWithSha256));
}

function name(commonName: string): Uint8Array {
  return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? sequence(oid(id), boolean(true), octetString(value))
    : sequence(oid(id), octetString(value));
}

/** `subjectAltName`'s general names: `[2]` dNSName, `[7]` iPAddress (RFC 5280, 4.2.1.6). */
function altNames(names: CertificateNames): Uint8Array {
  const dns = names.dns.map((n) => tagged(2, new TextEncoder().encode(n), false));
  const ips = names.ips.flatMap((a) => {
    const bytes = ipBytes(a);
    return bytes === undefined ? [] : [tagged(7, bytes, false)];
  });
  return sequence(...dns, ...ips);
}

/** The certificate's body, to be signed. */
function tbsCertificate(
  names: CertificateNames,
  spki: Uint8Array,
  serial: Uint8Array,
  nowMs: number,
): Uint8Array {
  const commonName = `HSN hub ${names.dns[0] ?? names.ips[0] ?? ""}`.trim();
  return sequence(
    tagged(0, smallInteger(2), true),
    unsignedInteger(serial),
    algorithm(),
    name(commonName),
    // A minute back, so a client whose clock is a little behind still accepts it.
    sequence(time(nowMs - 60_000), time(nowMs + CERTIFICATE.validityMs)),
    name(commonName),
    spki,
    tagged(
      3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, altNames(names)),
      ),
      true,
    ),
  );
}

/**
 * A new key and self-signed certificate for `names`, valid from now for 800 days ‡. `serial` is
 * 16 random bytes; its top bit is cleared so the serial is positive (RFC 5280, 4.1.2.2).
 */
export function makeCertificate(
  names: CertificateNames,
  nowMs: number,
  serial: Uint8Array,
): Result<TlsMaterial, HubError> {
  const pair = cryptoCall(ORIGIN, "make the TLS key", () =>
    generateKeyPairSync("ec", { namedCurve: "P-256" }),
  );
  if (pair.isErr()) return err(pair.error);
  const { privateKey, publicKey } = pair.value;
  const positive = serial.slice();
  positive[0] = (positive[0] ?? 0) & 0x7f;
  return cryptoCall(ORIGIN, "sign the certificate", () => {
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const tbs = tbsCertificate(names, spki, positive, nowMs);
    const signature = new Uint8Array(sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }));
    return {
      privateKey: new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" })),
      certificate: sequence(tbs, algorithm(), bitString(signature)),
    };
  });
}

/** The names `subjectAltName` lists, comparable (`hostKey`). */
function namesIn(subjectAltName: string | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of (subjectAltName ?? "").split(/,\s*/u)) {
    const dns = /^DNS:(.+)$/u.exec(entry);
    const ip = /^IP Address:(.+)$/u.exec(entry);
    if (dns?.[1] !== undefined) names.add(hostKey(dns[1]));
    if (ip?.[1] !== undefined) names.add(hostKey(ip[1]));
  }
  return names;
}

/** Reads the certificate back with `node:crypto`'s parser; a certificate it refuses is an error. */
export function readCertificate(der: Uint8Array): Result<CertificateInfo, HubError> {
  return cryptoCall(ORIGIN, "read the certificate", () => {
    const parsed = new X509Certificate(der);
    return {
      sha256: sha256(der),
      notBeforeMs: Date.parse(parsed.validFrom),
      notAfterMs: Date.parse(parsed.validTo),
      names: namesIn(parsed.subjectAltName),
    };
  });
}

/** Whether the private key is the certificate's: a stored pair must match before it is served. */
export function keyMatches(material: TlsMaterial): Result<boolean, HubError> {
  return cryptoCall(ORIGIN, "check the TLS key", () => {
    const key = createPrivateKey({
      key: Buffer.from(material.privateKey),
      format: "der",
      type: "pkcs8",
    });
    const fromCertificate = new X509Certificate(material.certificate).publicKey.export({
      type: "spki",
      format: "der",
    });
    const fromKey = createPublicKey(key).export({ type: "spki", format: "der" });
    return Buffer.compare(fromCertificate, fromKey) === 0;
  });
}

/**
 * Why a new certificate is needed, or undefined: a name or address it does not carry, its age at
 * 700 days ‡ or more, or a validity that has not started or has ended (section 5).
 */
export function renewalReason(
  info: CertificateInfo,
  names: CertificateNames,
  nowMs: number,
): string | undefined {
  const wanted = [...names.dns, ...names.ips].map(hostKey);
  const missing = wanted.find((n) => !info.names.has(n));
  if (missing !== undefined) return "a name or address it does not carry";
  if (Number.isNaN(info.notBeforeMs) || Number.isNaN(info.notAfterMs)) return "no validity";
  if (nowMs < info.notBeforeMs - 86_400_000) return "it is not valid yet";
  if (nowMs >= info.notAfterMs) return "it has expired";
  if (nowMs - info.notBeforeMs >= CERTIFICATE.renewAfterMs) return "it is 700 days old";
  return undefined;
}

/** DER as PEM, for `Bun.serve`'s `tls`. */
export function pem(label: "CERTIFICATE" | "PRIVATE KEY", der: Uint8Array): string {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/gu, "$1\n")
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** `ok` with the material when `stored` is a usable pair, else the reason it is not. */
export function storedMaterial(
  privateKey: Uint8Array | null,
  certificate: Uint8Array | null,
): Result<TlsMaterial, string> {
  if (privateKey === null || certificate === null) return err("none stored");
  const material = { privateKey, certificate };
  const matches = keyMatches(material);
  if (matches.isErr()) return err("the stored key or certificate cannot be read");
  return matches.value ? ok(material) : err("the stored key is not the certificate's");
}
