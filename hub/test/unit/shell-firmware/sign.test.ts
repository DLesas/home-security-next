/**
 * The hub's image header (`shell/firmware/sign.ts`; docs/m3-updates-design.md section 3): made from
 * the hub's key as `hub_keys` holds it (PKCS #8, made through Web Crypto), signed
 * deterministically, it is byte for byte the protocol's vectors' header; and the key's scalar is
 * checked against its public half.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkImageHeader, decodeImageHeader, UpdateReason } from "@hsn/protocol/update";
import { Role } from "@hsn/protocol";
import { seededHubKeys } from "../../../src/shell/advertise/hub-keys.ts";
import { p256ScalarOf } from "../../../src/shell/safe/firmware-io.ts";
import {
  headerVersion,
  makeHeader,
  rolesMask,
  signerOf,
} from "../../../src/shell/firmware/sign.ts";
import { RFC6979_SCALAR, testHubKeys } from "./support.ts";

interface VectorCase {
  readonly name: string;
  readonly fields: {
    readonly flags: { readonly ownBuild: boolean };
    readonly roles: number;
    readonly target: number;
    readonly version: { readonly major: number; readonly minor: number; readonly patch: number };
    readonly imageBytes: number;
    readonly imageSha256: string;
    readonly hubIdentity: string;
  };
  readonly header: string;
}

const VECTORS = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../../packages/protocol/vectors/image-header.json"),
    "utf8",
  ),
) as {
  readonly signingPrivateKey: string;
  readonly signingKey: string;
  readonly hubIdentity: string;
  readonly valid: readonly VectorCase[];
};

const fromHex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "hex"));

describe("the header matches the protocol's vectors", () => {
  test("the vectors' key is the one the tests' hub holds", async () => {
    const keys = await testHubKeys();
    expect(Buffer.from(RFC6979_SCALAR).toString("hex")).toBe(VECTORS.signingPrivateKey);
    expect(Buffer.from(keys.publicKey).toString("hex")).toBe(VECTORS.signingKey);
    expect(Buffer.from(keys.identity).toString("hex")).toBe(VECTORS.hubIdentity);
    // Read back out of its PKCS #8 form, as the shell reads `hub_keys`.
    expect(p256ScalarOf(keys.pkcs8)._unsafeUnwrap()).toEqual(RFC6979_SCALAR);
  });

  for (const vector of VECTORS.valid) {
    test(vector.name, async () => {
      const { signer } = await testHubKeys();
      expect(vector.fields.hubIdentity).toBe(Buffer.from(signer.identity).toString("hex"));
      const header = makeHeader(
        {
          ownBuild: vector.fields.flags.ownBuild,
          roles: vector.fields.roles,
          version: vector.fields.version,
          imageBytes: vector.fields.imageBytes,
          imageSha256: fromHex(vector.fields.imageSha256),
        },
        signer,
      )._unsafeUnwrap();
      expect(Buffer.from(header).toString("hex")).toBe(vector.header);
      // Twice: deterministic.
      const again = makeHeader(
        {
          ownBuild: vector.fields.flags.ownBuild,
          roles: vector.fields.roles,
          version: vector.fields.version,
          imageBytes: vector.fields.imageBytes,
          imageSha256: fromHex(vector.fields.imageSha256),
        },
        signer,
      )._unsafeUnwrap();
      expect(again).toEqual(header);
    });
  }

  test("a device paired to this hub takes the header; one paired to another refuses it", async () => {
    const { signer } = await testHubKeys();
    const header = makeHeader(
      {
        ownBuild: true,
        roles: rolesMask("all"),
        version: { major: 1, minor: 4, patch: 0 },
        imageBytes: 4096,
        imageSha256: new Uint8Array(32).fill(1),
      },
      signer,
    )._unsafeUnwrap();
    const expect_ = {
      hubIdentity: signer.identity,
      signingKey: signer.publicKey,
      role: Role.Sensor,
      capacity: 3_670_016,
    };
    expect(checkImageHeader(header, expect_)).toBe(UpdateReason.None);
    const other = (await seededHubKeys(new Uint8Array(32).fill(3)))._unsafeUnwrap();
    expect(
      checkImageHeader(header, {
        ...expect_,
        hubIdentity: other.identity,
        signingKey: other.signingPublic,
      }),
    ).toBe(UpdateReason.WrongHub);
    expect(decodeImageHeader(header)).toMatchObject({
      ok: true,
      value: { flags: { ownBuild: true }, roles: 14, target: 1 },
    });
  });
});

describe("the hub's key and the header's fields", () => {
  test("a stored scalar that is not the stored public key's is refused", async () => {
    const keys = await testHubKeys();
    const other = (await seededHubKeys(new Uint8Array(32).fill(3)))._unsafeUnwrap();
    expect(signerOf(keys.pkcs8, other.signingPublic, other.identity)._unsafeUnwrapErr()).toBe(
      "the hub's stored signing key is not its public key's",
    );
    expect(signerOf(new Uint8Array(40), keys.publicKey, keys.identity).isErr()).toBe(true);
  });

  test("PKCS #8 that is not a P-256 key is refused", () => {
    expect(p256ScalarOf(new Uint8Array([1, 2, 3])).isErr()).toBe(true);
    // An Ed25519 key in PKCS #8.
    const ed = Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, 7),
    ]);
    expect(p256ScalarOf(new Uint8Array(ed))._unsafeUnwrapErr()).toBe(
      "the hub's signing key is not a P-256 key",
    );
  });

  test("a version fits a header with each part from 0 to 255, without leading zeros", () => {
    expect(headerVersion("0.0.0")).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(headerVersion("255.255.255")).toEqual({ major: 255, minor: 255, patch: 255 });
    for (const bad of ["256.0.0", "0.256.0", "0.0.256", "01.0.0", "1.0", "1.0.0.0", "a.b.c", ""])
      expect(headerVersion(bad)).toBeUndefined();
  });

  test("roles: a release's as bits 1 to 3, every role for an own build", () => {
    expect(rolesMask([1])).toBe(2);
    expect(rolesMask([2, 3])).toBe(12);
    expect(rolesMask([1, 2, 3])).toBe(14);
    expect(rolesMask("all")).toBe(14);
  });
});
