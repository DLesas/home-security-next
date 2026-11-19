/** The scripted board's ESP-IDF security 2 handshake and encrypted setup endpoint. */
import { createHash, getDiffieHellman, timingSafeEqual } from "node:crypto";
import { fromHex, toHex } from "../../../../packages/protocol/src/bytes.ts";
import { PAIRING_SECURITY } from "../../../../packages/protocol/src/pairing/constants.ts";
import {
  decodeSessionData,
  encodeSessionData,
} from "../../../../packages/protocol/src/pairing/protobuf.ts";
import { gcmOpen, gcmSeal } from "../../../../packages/protocol/src/pairing/safe/throwing.ts";
import { security2Nonce } from "../../../../packages/protocol/src/pairing/security2.ts";
import { SRP, srpVerifier } from "../../../../packages/protocol/src/pairing/srp.ts";
import { fault, ok } from "../outcome.ts";
import type { StartPairingSecurity } from "./pairing-security.ts";

type Event = "invalidSecurityParams" | "credentialsMismatch" | "setupOk";
interface Options {
  readonly credentials?: { readonly salt: Uint8Array; readonly verifier: Uint8Array };
  readonly draw?: (size: number) => Uint8Array | undefined;
  readonly event?: (event: Event) => void;
}

/** SHA-512 over ESP-IDF's concatenated SRP fields. */
function hash(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha512");
  for (const part of parts) h.update(part);
  return new Uint8Array(h.digest());
}

/** Reads an unsigned, big-endian SRP integer. */
function integer(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt(`0x${toHex(bytes)}`) : 0n;
}

/** Encodes an SRP integer, padding only where RFC 5054 calls for it. */
function bytes(value: bigint, width = 0): Uint8Array {
  const hex = value.toString(16);
  return fromHex(hex.padStart(Math.max(width * 2, hex.length + (hex.length % 2)), "0"));
}

const primeBytes = getDiffieHellman("modp15").getPrime();
const prime = integer(primeBytes);
const generator = 5n;
const generatorHash = hash(bytes(generator, SRP.groupBytes));
const multiplier = integer(hash(primeBytes, bytes(generator, SRP.groupBytes)));
const groupProof = hash(primeBytes).map((value, i) => value ^ (generatorHash[i] ?? 0));
const user = new TextEncoder().encode(PAIRING_SECURITY.username);

/** Raises a base to an SRP exponent in the 3072-bit group. Used only by the bench. */
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (const bit of exponent.toString(2)) {
    result = (result * result) % prime;
    if (bit === "1") result = (result * base) % prime;
  }
  return result;
}

/** Creates one board security layer per link, with injectable ESP-IDF draws for replay. */
export function security2Server(options: Options = {}): StartPairingSecurity {
  const draw = options.draw ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)));
  return (code) => {
    let credentials = options.credentials;
    let pending: { key: Uint8Array; proof: Uint8Array; publicKey: Uint8Array } | undefined;
    let session: { key: Uint8Array; id: Uint8Array; counter: number } | undefined;

    return {
      get established() {
        return session !== undefined;
      },

      /** Handles the two commands and the same restart and refusal rules as ESP-IDF. */
      session(request) {
        const message = decodeSessionData(request);
        if (message?.msg === "command0") {
          pending?.key.fill(0);
          pending = undefined;
          session?.key.fill(0);
          session = undefined;
          const { publicKey, username } = message;
          if (publicKey.length !== SRP.groupBytes || username.length === 0) {
            options.event?.("invalidSecurityParams");
            return fault("failed");
          }
          if (credentials === undefined) {
            let salt = draw(SRP.saltBytes);
            // ESP-IDF v6.1.1 computes the verifier with a shortened salt if the first byte is zero.
            while (salt?.[0] === 0) salt = draw(SRP.saltBytes);
            if (salt?.length !== SRP.saltBytes) return fault("failed");
            credentials = {
              salt,
              verifier: srpVerifier(user, new TextEncoder().encode(code), salt),
            };
          }
          const { salt, verifier } = credentials;
          const privateDraw = draw(SRP.privateBytes);
          if (privateDraw?.length !== SRP.privateBytes) return fault("failed");
          const b = integer(privateDraw);
          const a = integer(publicKey) % prime;
          const v = integer(verifier);
          if (a === 0n || b === 0n || v <= 0n || v >= prime || salt.length !== SRP.saltBytes)
            return fault("failed");
          const boardPublic = (multiplier * v + power(generator, b)) % prime;
          const scramble = integer(hash(publicKey, bytes(boardPublic, SRP.groupBytes)));
          if (scramble === 0n) return fault("failed");
          const key = hash(bytes(power((a * power(v, scramble)) % prime, b)));
          const sentPublic = bytes(boardPublic);
          const proof = hash(groupProof, hash(username), salt, publicKey, sentPublic, key);
          pending = { key, proof, publicKey };
          return ok(
            encodeSessionData({ msg: "response0", status: 0, publicKey: sentPublic, salt }),
          );
        }
        if (
          message?.msg !== "command1" ||
          pending === undefined ||
          message.proof.length !== SRP.hashBytes
        )
          return fault("failed");
        if (!timingSafeEqual(pending.proof, message.proof)) {
          options.event?.("credentialsMismatch");
          return fault("mismatch");
        }
        const id = draw(PAIRING_SECURITY.sessionIdBytes);
        if (id?.length !== PAIRING_SECURITY.sessionIdBytes) return fault("failed");
        const proof = hash(pending.publicKey, pending.proof, pending.key);
        const counter = PAIRING_SECURITY.firstCounter;
        session = { id, counter, key: pending.key.slice(0, PAIRING_SECURITY.aesKeyBytes) };
        pending.key.fill(0);
        pending = undefined;
        options.event?.("setupOk");
        return ok(
          encodeSessionData({
            msg: "response1",
            status: 0,
            proof,
            nonce: security2Nonce(id, counter),
          }),
        );
      },

      /** An invalid tag leaves the counter untouched so a valid write can still follow it. */
      decrypt(data) {
        if (session === undefined || session.counter === 0) return fault("failed");
        const plain = gcmOpen(session.key, security2Nonce(session.id, session.counter), data);
        if (plain === undefined) return fault("failed");
        session.counter = (session.counter + 1) >>> 0;
        return ok(plain);
      },

      /** Encrypts a setup answer at the next counter, unless it has wrapped. */
      encrypt(data) {
        if (session === undefined || session.counter === 0) return fault("failed");
        const sealed = gcmSeal(session.key, security2Nonce(session.id, session.counter), data);
        session.counter = (session.counter + 1) >>> 0;
        return ok(sealed);
      },
    };
  };
}
