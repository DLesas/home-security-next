// Under Node: writes vectors made with the built-in AES-CCM and checks ccm.ts against them.
// Under Bun (no built-in CCM): reads the same vectors and checks ccm.ts against them.
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ccmEncrypt, ccmDecrypt } from "./src/ccm.ts";

type V = { key: string; nonce: string; aad: string; pt: string; ct: string; tag: string };
const file = "ccm-vectors.json";
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

if (!isBun) {
  const vectors: V[] = [];
  for (let i = 0; i < 300; i++) {
    const key = crypto.randomBytes(16), nonce = crypto.randomBytes(13);
    const aad = crypto.randomBytes(i % 40), pt = crypto.randomBytes(i % 70);
    const tagLen = [4, 8, 16][i % 3];
    const c = crypto.createCipheriv("aes-128-ccm", key, nonce, { authTagLength: tagLen });
    c.setAAD(aad, { plaintextLength: pt.length });
    const ct = Buffer.concat([c.update(pt), c.final()]);
    vectors.push({ key: hex(key), nonce: hex(nonce), aad: hex(aad), pt: hex(pt), ct: hex(ct), tag: hex(c.getAuthTag()) });
  }
  writeFileSync(file, JSON.stringify(vectors));
}
if (!existsSync(file)) throw new Error("run under Node first to create the vectors");
const vectors: V[] = JSON.parse(readFileSync(file, "utf8"));

// RFC 3610 packet vector #1
const rfc = ccmEncrypt(Buffer.from("c0c1c2c3c4c5c6c7c8c9cacbcccdcecf", "hex"), Buffer.from("00000003020100a0a1a2a3a4a5", "hex"),
  Buffer.from("0001020304050607", "hex"), Buffer.from("08090a0b0c0d0e0f101112131415161718191a1b1c1d1e", "hex"), 8);
const rfcOk = hex(rfc.ciphertext) + hex(rfc.tag) === "588c979a61c663d2f066d0c2c0f989806d5f6b61dac38417e8d12cfdf926e0";

let pass = 0, tamperRejected = 0;
for (const v of vectors) {
  const [key, nonce, aad, pt, ct, tag] = [v.key, v.nonce, v.aad, v.pt, v.ct, v.tag].map((h) => Buffer.from(h, "hex"));
  const e = ccmEncrypt(key, nonce, aad, pt, tag.length);
  const d = ccmDecrypt(key, nonce, aad, ct, tag);
  if (hex(e.ciphertext) === v.ct && hex(e.tag) === v.tag && d !== null && hex(d) === v.pt) pass++;
  const badTag = Buffer.from(tag); badTag[0] ^= 1;
  if (ccmDecrypt(key, nonce, aad, ct, badTag) === null) tamperRejected++;
}
console.log(`${isBun ? "Bun" : "Node"}: RFC 3610 vector ${rfcOk ? "PASS" : "FAIL"}; ${pass}/${vectors.length} match the built-in AES-CCM; ${tamperRejected}/${vectors.length} tampered tags rejected`);
if (!rfcOk || pass !== vectors.length || tamperRejected !== vectors.length) process.exit(1);
