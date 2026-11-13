/**
 * A `DeviceCipher` keyed from the protocol package's vector files (hub-design.md section 11):
 * every address that appears in a vector case becomes a device, with the case's key. It seals
 * and opens with the package's `sealPacket` and `openPacket`, through one AES block cipher per
 * key (the D94 seam), exactly as the shell's cipher will.
 */
import { err, Result } from "neverthrow";
import { type BlockCipher, nodeAes128, sealPacket } from "@hsn/protocol";
import type { HubError } from "../../src/core/model/errors.ts";
import type { DeviceCipher } from "../../src/core/model/cipher.ts";
import { openToHub } from "../../src/shell/cipher/device-cipher.ts";
import { type DeviceId, deviceId } from "../../src/core/model/ids.ts";
import { packetVectors } from "./vectors.ts";

/** A device of the vector files. */
export interface VectorDevice {
  readonly device: DeviceId;
  readonly address: number;
  readonly key: Uint8Array;
}

/** `sealPacket` throws `RangeError` on a programmer error; here that is a `HubError`. */
const safeSeal = Result.fromThrowable(sealPacket, (error): HubError => ({
  kind: "crypto",
  origin: "test/world/vector-cipher",
  message: error instanceof Error ? error.message : "seal failed",
}));

/** The first device id the vector devices get; 0 is the hub and 1 is left free. */
const FIRST_VECTOR_DEVICE = 2;

export class VectorCipher implements DeviceCipher {
  readonly devices: readonly VectorDevice[];
  readonly #byDevice: ReadonlyMap<
    DeviceId,
    { readonly key: Uint8Array; readonly aes: BlockCipher }
  >;

  constructor(devices: readonly VectorDevice[]) {
    this.devices = devices;
    this.#byDevice = new Map(
      devices.map((d) => [d.device, { key: d.key, aes: nodeAes128(d.key) }]),
    );
  }

  /** Every address of the vector files, numbered in order of first appearance. */
  static fromVectors(): VectorCipher {
    const keys = new Map<number, Uint8Array>();
    for (const vector of packetVectors()) {
      if (!keys.has(vector.address)) keys.set(vector.address, vector.key);
    }
    return new VectorCipher(
      [...keys].map(([address, key], index) => ({
        device: deviceId(FIRST_VECTOR_DEVICE + index),
        address,
        key,
      })),
    );
  }

  /** The device with this address. */
  deviceFor(address: number): VectorDevice | undefined {
    return this.devices.find((d) => d.address === address);
  }

  seal: DeviceCipher["seal"] = (device, message, request) => {
    const entry = this.#byDevice.get(device);
    if (entry === undefined) {
      return err({ kind: "crypto", origin: "test/world/vector-cipher", message: "no key" });
    }
    return safeSeal(message, { ...request, key: entry.key, cipher: entry.aes });
  };

  /** As the shell's cipher opens (shell/cipher/device-cipher.ts), with the vectors' keys. */
  open: DeviceCipher["open"] = (device, packet, request) => {
    const entry = this.#byDevice.get(device);
    if (entry === undefined) return err({ error: { code: "badTag" }, plaintext: undefined });
    return openToHub(packet, entry.key, entry.aes, request);
  };
}
