/**
 * The browser's derivations from a code (`src/hub/digest.ts`) are the protocol package's, byte for
 * byte: against its own functions and against the vectors.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nodeSha256 } from "@hsn/protocol";
import {
  appIdentityBytes,
  formatIdentity,
  secretLookup,
  secretPsk,
  typedPsk,
} from "@hsn/protocol/app";
import {
  identityOf,
  lookupOfSecret,
  pskOfSecret,
  pskOfTypedSecret,
  toHex,
} from "../src/hub/digest";

const VECTORS = join(
  import.meta.dir,
  "..",
  "..",
  "packages",
  "protocol",
  "vectors",
  "app-link-secrets.json",
);

describe("derivations from a code", () => {
  test("match the protocol package's on random inputs", async () => {
    for (let i = 0; i < 20; i++) {
      const secret = crypto.getRandomValues(new Uint8Array(16));
      expect(await pskOfSecret(secret)).toEqual(secretPsk(nodeSha256, secret));
      expect(await lookupOfSecret(secret)).toBe(secretLookup(nodeSha256, secret));
      const key = crypto.getRandomValues(new Uint8Array(32));
      expect(await identityOf(key)).toBe(formatIdentity(appIdentityBytes(nodeSha256, key)));
      const typed = BigInt(i) * 1_000_003n;
      expect(await pskOfTypedSecret(typed)).toEqual(typedPsk(nodeSha256, typed));
    }
  });

  test("match the vectors' pre-shared keys and lookups", async () => {
    const file = JSON.parse(readFileSync(VECTORS, "utf8")) as {
      vectors: readonly Record<string, unknown>[];
    };
    let checked = 0;
    for (const v of file.vectors) {
      if (typeof v.secret === "string" && typeof v.psk === "string" && v.secret.length === 32) {
        const secret = Uint8Array.from(Buffer.from(v.secret, "hex"));
        expect(toHex(await pskOfSecret(secret))).toBe(v.psk);
        if (typeof v.lookup === "string") expect(await lookupOfSecret(secret)).toBe(v.lookup);
        if (typeof v.hubStaticPublic === "string" && typeof v.identity === "string")
          expect(await identityOf(Uint8Array.from(Buffer.from(v.hubStaticPublic, "hex")))).toBe(
            v.identity,
          );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
