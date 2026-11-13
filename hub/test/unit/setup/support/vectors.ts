/**
 * The setup vector files (packages/protocol/vectors/README.md, `setup-messages.json` and
 * `pairing-data.json`), read and checked with Zod.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromHex } from "@hsn/protocol";
import { z } from "zod";
import { VECTOR_DIRECTORY } from "../../../world/vectors.ts";

const hex = z.string().regex(/^(?:[0-9a-f]{2})*$/);

const pairingFields = z.object({
  address: z.int(),
  key: hex,
  hubIdentity: hex,
  firmwareSigningKey: hex,
  siteChannel: z.int(),
  allowedDataRateMask: z.int(),
  wifiName: hex,
  wifiPassword: hex,
});

const pairingFile = z.object({
  valid: z.array(
    z.object({ name: z.string(), canonical: z.boolean(), fields: pairingFields, bytes: hex }),
  ),
  invalid: z.array(z.object({ name: z.string(), bytes: hex, error: z.string() })),
});

const setupFile = z.object({
  valid: z.array(
    z.object({
      name: z.string(),
      canonical: z.boolean(),
      setupType: z.int(),
      fields: z.unknown(),
      bytes: hex,
    }),
  ),
  invalid: z.array(z.object({ name: z.string(), bytes: hex, error: z.string() })),
});

function read(file: string): unknown {
  return JSON.parse(readFileSync(join(VECTOR_DIRECTORY, file), "utf8"));
}

export interface PairingCase {
  readonly name: string;
  readonly canonical: boolean;
  readonly address: number;
  readonly key: Uint8Array;
  readonly hubIdentity: Uint8Array;
  readonly signingKey: Uint8Array;
  readonly siteChannel: number;
  readonly rateMask: number;
  readonly wifiName: Uint8Array;
  readonly wifiPassword: Uint8Array;
  readonly bytes: Uint8Array;
}

export function pairingCases(): readonly PairingCase[] {
  return pairingFile.parse(read("pairing-data.json")).valid.map((c) => ({
    name: c.name,
    canonical: c.canonical,
    address: c.fields.address,
    key: fromHex(c.fields.key),
    hubIdentity: fromHex(c.fields.hubIdentity),
    signingKey: fromHex(c.fields.firmwareSigningKey),
    siteChannel: c.fields.siteChannel,
    rateMask: c.fields.allowedDataRateMask,
    wifiName: fromHex(c.fields.wifiName),
    wifiPassword: fromHex(c.fields.wifiPassword),
    bytes: fromHex(c.bytes),
  }));
}

export function setupCases() {
  const file = setupFile.parse(read("setup-messages.json"));
  return {
    valid: file.valid.map((c) => ({ ...c, bytes: fromHex(c.bytes) })),
    invalid: file.invalid.map((c) => ({ ...c, bytes: fromHex(c.bytes) })),
  };
}

/** The bytes of the valid setup case with this name. */
export function setupBytesNamed(name: string): Uint8Array {
  return setupCases().valid.find((c) => c.name === name)?.bytes ?? new Uint8Array();
}
