/**
 * A TLS key and self-signed certificate for loopback, made for each test: a P-256 key, valid for
 * a day, naming `localhost`, 127.0.0.1 and ::1. A test passes the certificate to the client as
 * its only trusted authority, as the push role's `--test-ca` does, so nothing trusts it beyond
 * that test. Built as the hub's own certificate is (hub/src/shell/app/certificate.ts): a little
 * DER, signed with `node:crypto`.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { fail, ok, type Result } from "./result.ts";
import { attempt } from "./safe/attempt.ts";

/** PEM text, as `node:http2`, `Bun.serve` and Bun's clients take it. */
export interface LoopbackTls {
  readonly key: string;
  readonly cert: string;
}

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
  const body = Buffer.concat(contents);
  return Buffer.concat([Uint8Array.of(tag), length(body.length), body]);
}

const seq = (...items: readonly Uint8Array[]) => tlv(0x30, ...items);

function oid(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups: number[] = [];
    for (let v = arc; ; v = Math.floor(v / 128)) {
      groups.unshift((v % 128) | (groups.length === 0 ? 0 : 0x80));
      if (v < 128) break;
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

function utcTime(ms: number): Uint8Array {
  const iso = new Date(ms).toISOString(); // 2026-11-18T10:00:00.000Z
  const text = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, new TextEncoder().encode(text));
}

function name(commonName: string): Uint8Array {
  return seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode(commonName)))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return critical
    ? seq(oid(id), tlv(0x01, Uint8Array.of(0xff)), tlv(0x04, value))
    : seq(oid(id), tlv(0x04, value));
}

function pem(label: string, der: Uint8Array): string {
  const body = Buffer.from(der)
    .toString("base64")
    .replace(/(.{64})/gu, "$1\n")
    .trimEnd();
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** A fresh key and certificate for loopback, valid from a minute ago for a day. */
export function loopbackTls(nowMs: number): Result<LoopbackTls, string> {
  const made = attempt(() => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
    const serial = new Uint8Array(randomBytes(16));
    // Positive and minimal in DER: the top bit clear, and the first byte never zero.
    serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x40;
    const algorithm = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
    const altNames = seq(
      tlv(0x82, new TextEncoder().encode("localhost")),
      tlv(0x87, Uint8Array.of(127, 0, 0, 1)),
      tlv(0x87, Uint8Array.of(...new Array<number>(15).fill(0), 1)),
    );
    const tbs = seq(
      tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
      tlv(0x02, serial),
      algorithm,
      name("push stand-in"),
      seq(utcTime(nowMs - 60_000), utcTime(nowMs + 24 * 3600_000)),
      name("push stand-in"),
      spki,
      tlv(
        0xa3,
        seq(
          extension("2.5.29.19", true, seq()),
          extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
          extension("2.5.29.17", false, altNames),
        ),
      ),
    );
    const signature = new Uint8Array(sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }));
    const certificate = seq(tbs, algorithm, tlv(0x03, Uint8Array.of(0), signature));
    return {
      key: privateKey.export({ type: "pkcs8", format: "pem" }),
      cert: pem("CERTIFICATE", certificate),
    };
  });
  return made.ok ? ok(made.value) : fail(`make the loopback certificate: ${made.error}`);
}
