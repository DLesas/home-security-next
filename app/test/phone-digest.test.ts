/**
 * The phone's derivations from a code (`src/hub/digest-over.ts`, which `digest.native.ts` gives
 * expo-crypto's SHA-256) are the protocol package's, byte for byte, against its own functions and
 * the vectors, as `digest.test.ts` checks the browser's. The SHA-256 here is `node:crypto`'s.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import type { Digests } from "../src/hub/digest-types";
import { digestsOver, moduleSha256 } from "../src/hub/digest-over";

const given: Uint8Array[] = [];

function phone(): Promise<Digests> {
  return Promise.resolve(
    digestsOver((data) => {
      given.push(data);
      return Promise.resolve(new Uint8Array(createHash("sha256").update(data).digest()));
    }),
  );
}

describe("the phone's derivations from a code", () => {
  test("match the protocol package's on random inputs, through the system's SHA-256", async () => {
    const d = await phone();
    for (let i = 0; i < 20; i++) {
      const secret = crypto.getRandomValues(new Uint8Array(16));
      expect(await d.pskOfSecret(secret)).toEqual(secretPsk(nodeSha256, secret));
      expect(await d.lookupOfSecret(secret)).toBe(secretLookup(nodeSha256, secret));
      const key = crypto.getRandomValues(new Uint8Array(32));
      expect(await d.identityOf(key)).toBe(formatIdentity(appIdentityBytes(nodeSha256, key)));
      const typed = BigInt(i) * 1_000_003n;
      expect(await d.pskOfTypedSecret(typed)).toEqual(typedPsk(nodeSha256, typed));
    }
    // Each input is a copy in a buffer of its own, as expo-crypto's `digest` takes a `BufferSource`.
    expect(
      given.every((data) => data.byteOffset === 0 && data.buffer.byteLength === data.length),
    ).toBe(true);
  });

  test("the phone's SHA-256 is expo-crypto's native module, as expo-crypto calls it, either way it offers", async () => {
    const data = new Uint8Array([1, 2, 3]);
    const want = createHash("sha256").update(data).digest().toString("hex");
    const asked: string[] = [];
    const viaAsync = moduleSha256({
      digestAsync: (algorithm, input) => {
        asked.push(algorithm);
        return Promise.resolve(createHash("sha256").update(input).digest().buffer);
      },
    });
    expect(Buffer.from(await viaAsync(data)).toString("hex")).toBe(want);
    const viaSync = moduleSha256({
      digest: (algorithm, output, input) => {
        asked.push(algorithm);
        output.set(createHash("sha256").update(input).digest());
      },
    });
    expect(Buffer.from(await viaSync(data)).toString("hex")).toBe(want);
    expect(asked).toEqual(["SHA-256", "SHA-256"]);
    expect(
      await moduleSha256(undefined)(data).then(
        () => "made",
        () => "refused",
      ),
    ).toBe("refused");
    const source = readFileSync(
      join(import.meta.dir, "..", "src", "hub", "digest.native.ts"),
      "utf8",
    );
    expect(source).not.toContain('from "expo-crypto"');
    expect(source.replace(/\s+/gu, "")).toContain("digestsOver(moduleSha256(expoCrypto))");
  });

  test("match the vectors' pre-shared keys, lookups and identities", async () => {
    const d = await phone();
    const file = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "..",
          "..",
          "packages",
          "protocol",
          "vectors",
          "app-link-secrets.json",
        ),
        "utf8",
      ),
    ) as { vectors: readonly Record<string, unknown>[] };
    let checked = 0;
    for (const v of file.vectors) {
      if (typeof v.secret === "string" && typeof v.psk === "string" && v.secret.length === 32) {
        const secret = Uint8Array.from(Buffer.from(v.secret, "hex"));
        expect(d.toHex(await d.pskOfSecret(secret))).toBe(v.psk);
        if (typeof v.lookup === "string") expect(await d.lookupOfSecret(secret)).toBe(v.lookup);
        if (typeof v.hubStaticPublic === "string" && typeof v.identity === "string")
          expect(await d.identityOf(Uint8Array.from(Buffer.from(v.hubStaticPublic, "hex")))).toBe(
            v.identity,
          );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
