/** Fixed keys, addresses and random values for the test vectors. Never used outside tests. */
import { fromHex } from "../../src/index.ts";

export interface Device {
  readonly key: Uint8Array;
  readonly address: number;
}

export const sensor: Device = {
  key: fromHex("000102030405060708090a0b0c0d0e0f"),
  address: 0x1a2b3c4d,
};

/** A second sensor, so cases can vary the device. */
export const sensor2: Device = {
  key: fromHex("303132333435363738393a3b3c3d3e3f"),
  address: 0x0badf00d,
};

export const siren: Device = {
  key: fromHex("101112131415161718191a1b1c1d1e1f"),
  address: 0x5e6f7081,
};

export const gateway: Device = {
  key: fromHex("202122232425262728292a2b2c2d2e2f"),
  address: 0x92a3b4c5,
};

export const gatewayRandom = fromHex("a0a1a2a3a4a5a6a7");
export const hubRandom = fromHex("b0b1b2b3b4b5b6b7");

/** Random values of two later gateway connections, for more hello and welcome cases. */
export const laterGatewayRandoms = [
  fromHex("c0c1c2c3c4c5c6c7"),
  fromHex("d0d1d2d3d4d5d6d7"),
] as const;
export const laterHubRandoms = [fromHex("e0e1e2e3e4e5e6e7"), fromHex("f0f1f2f3f4f5f6f7")] as const;

/** Deterministic filler bytes, so large cases need no randomness. */
export function patternBytes(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + 37 * i) & 0xff);
}
