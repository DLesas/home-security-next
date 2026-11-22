/**
 * The committed app vectors (`vectors/app-*.json`) are exactly what `app-vectors.ts` writes, and
 * each file reads with the format `vector-formats.ts` freezes. The typed codes and the 128-bit
 * secrets are checked here against `linking.ts`; the handshakes in noise.test.ts, the backup
 * files in backup.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromHex, toHex } from "../../bytes.ts";
import { APP_VECTOR_DIRECTORY, appVectorFiles } from "./app-vectors.ts";
import { APP_EVENTS_V2 } from "../events-v2.ts";
import { rolloutDeviceObject } from "../objects-v2.ts";
import {
  appIdentityBytes,
  formatIdentity,
  formatLinkAddress,
  parseLinkFragment,
  parseLinkQr,
  parseTypedCode,
  secretLookup,
  secretPsk,
  typedLookup,
  typedPsk,
  typedSecretBytes,
} from "../linking.ts";
import {
  APP_VECTOR_FILES,
  linkSecretVector,
  noiseVector,
  typedCodeVector,
  vectorFile,
} from "../vector-formats.ts";

const generated = await appVectorFiles();
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(APP_VECTOR_DIRECTORY, name), "utf8"));

describe("committed app vectors", () => {
  test.each([...generated.keys()])(
    "%s matches the generator (run `bun packages/protocol/src/app/vectors/app-vectors.ts`)",
    (name) => {
      expect(readFileSync(join(APP_VECTOR_DIRECTORY, name), "utf8")).toBe(
        generated.get(name) ?? "",
      );
    },
  );

  test.each([...generated.keys()])("%s reads with its frozen format", (name) => {
    const schema = APP_VECTOR_FILES[name as keyof typeof APP_VECTOR_FILES];
    expect(vectorFile(schema).safeParse(read(name)).success).toBe(true);
  });
});

const typed = vectorFile(typedCodeVector).parse(read("app-typed-code.json"));
const secrets = vectorFile(linkSecretVector).parse(read("app-link-secrets.json"));
const noise = vectorFile(noiseVector).parse(read("app-noise.json"));
const rolloutForceFile = "app-rollout-force.json";
const rolloutForce = vectorFile(APP_VECTOR_FILES[rolloutForceFile]).parse(read(rolloutForceFile));

describe("app-rollout-force.json (version 2)", () => {
  for (const [name, key, schema] of [
    ["rollout.status line", "statusLine", rolloutDeviceObject],
    ["deviceUpdate body", "deviceUpdate", APP_EVENTS_V2.deviceUpdate],
  ] as const) {
    test.each(rolloutForce.vectors.map((v) => [v.name, v] as const))(
      `${name} validates forceAvailable: %s`,
      (_, vector) => {
        const parsed = schema.safeParse(vector[key]);
        expect(parsed.success).toBe(vector.valid);
        if (parsed.success) expect(vector[key]).toEqual(parsed.data);
      },
    );
  }
});

describe("app-typed-code.json (section 5)", () => {
  test.each(typed.vectors.map((v) => [v.code, v] as const))("%s", (_, v) => {
    expect(v.code).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z*~$=U]{4}$/u,
    );
    const parsed = parseTypedCode(v.code);
    if (parsed === undefined) throw new Error("refused");
    expect(parsed.tokenId).toBe(v.tokenId);
    expect(toHex(typedSecretBytes(parsed.secret))).toBe(v.secret);
    expect(fromHex(v.secret)[0] ?? 0xff).toBeLessThan(8); // the top 5 bits are zero
    expect(typedLookup(v.tokenId)).toBe(v.lookup);
    expect(v.code.slice(0, 4)).toBe(v.lookup);
    expect(toHex(typedPsk(sha256, parsed.secret))).toBe(v.psk);
    // The pre-shared key: SHA-256 of `hsn-link/1`, a zero byte and the 5 bytes.
    const input = new Uint8Array([
      ...new TextEncoder().encode("hsn-link/1"),
      0,
      ...fromHex(v.secret),
    ]);
    expect(toHex(sha256(input))).toBe(v.psk);
    for (const t of v.typed) {
      const back = parseTypedCode(t.text);
      expect(back === undefined ? "refused" : `${back.tokenId}/${back.secret}`).toBe(
        t.valid ? `${parsed.tokenId}/${parsed.secret}` : "refused",
      );
    }
  });

  test("one code's check character is one of Crockford's extra symbols", () => {
    expect(typed.vectors.some((v) => "*~$=U".includes(v.code.slice(-1)))).toBe(true);
  });
});

describe("app-link-secrets.json (section 5)", () => {
  test.each(secrets.vectors.map((v) => [v.secret, v] as const))("%s", (_, v) => {
    const secret = fromHex(v.secret);
    const label = (text: string) => [...new TextEncoder().encode(text), 0];
    expect(v.lookup).toBe(
      toHex(sha256(new Uint8Array([...label("hsn-find/1"), ...secret])).slice(0, 4)),
    );
    expect(secretLookup(sha256, secret)).toBe(v.lookup);
    expect(v.psk).toBe(toHex(sha256(new Uint8Array([...label("hsn-link/1"), ...secret]))));
    expect(toHex(secretPsk(sha256, secret))).toBe(v.psk);
    expect(formatIdentity(appIdentityBytes(sha256, fromHex(v.hubStaticPublic)))).toBe(v.identity);
    const purpose = v.qr.startsWith("hsn://restore/1") ? "restore" : "link";
    const qr = parseLinkQr(v.qr, purpose);
    expect(qr?.identity).toBe(v.identity);
    expect(toHex(qr?.secret ?? new Uint8Array())).toBe(v.secret);
    const fragment = parseLinkFragment(v.linkAddress.split("#")[1] ?? "");
    expect(fragment?.identity).toBe(v.identity);
    expect(toHex(fragment?.secret ?? new Uint8Array())).toBe(v.secret);
    expect(formatLinkAddress("192.168.1.20", 8444, v.identity, secret)).toBe(v.linkAddress);
  });

  test("every link and restore handshake uses one of these secrets or typed codes", () => {
    for (const v of noise.vectors.filter((x) => x.purpose !== "session")) {
      const hello = JSON.parse(new TextDecoder().decode(fromHex(v.messages[0]?.payload ?? ""))) as {
        find: string;
      };
      const source =
        v.carrier === "typedCode"
          ? typed.vectors.find((t) => t.lookup === hello.find)
          : secrets.vectors.find((s) => s.lookup === hello.find);
      expect(source?.psk).toBe(v.psk ?? "");
      if (v.carrier !== "typedCode") {
        const s = secrets.vectors.find((x) => x.lookup === hello.find);
        expect(s?.hubStaticPublic).toBe(v.responder.static.public);
        expect(s?.qr.startsWith(v.purpose === "restore" ? "hsn://restore/1" : "hsn://link/1")).toBe(
          true,
        );
      }
    }
  });
});
