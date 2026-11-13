/**
 * The `DeviceCipher` (hub-design.md sections 2 and 3): a thin wrapper over `@hsn/protocol`'s
 * `sealPacket` and `openPacket` with keys from the `KeyStore`, one AES block cipher kept per key
 * (D94's seam, so a packet does not set one up). `sealPacket` throws `RangeError` on a programmer
 * error, which becomes a `HubError` of kind "crypto" here (section 10). An authentic packet whose
 * type or body does not decode is given back with its plaintext, so the core records it.
 */
import {
  type BlockCipher,
  CLEAR_HEADER_LENGTH,
  concatBytes,
  createAesCcm,
  Direction,
  nodeAes128,
  openPacket,
  type OpenedPacket,
  packetNonce,
  readPacketHeader,
  sealPacket,
  TAG_LENGTH,
} from "@hsn/protocol";
import { err, ok, Result } from "neverthrow";
import type { DeviceCipher, OpenFailure, OpenRequest } from "../../core/model/cipher.ts";
import type { HubError } from "../../core/model/errors.ts";
import type { DeviceId } from "../../core/model/ids.ts";
import type { KeyStore } from "../../ports/key-store.ts";
import { errorFrom } from "../safe/thrown.ts";

const ORIGIN = "shell/cipher";

const safeSeal = Result.fromThrowable(sealPacket, (thrown) =>
  errorFrom("crypto", ORIGIN, "seal a packet", thrown),
);
const safeOpen = Result.fromThrowable(openPacket, (thrown) =>
  errorFrom("crypto", ORIGIN, "open a packet", thrown),
);
const safeAes = Result.fromThrowable(nodeAes128, (thrown) =>
  errorFrom("crypto", ORIGIN, "key the AES block cipher", thrown),
);

const BAD_TAG: OpenFailure = { error: { code: "badTag" }, plaintext: undefined };

/**
 * The plaintext of a packet to the hub whose tag verifies under `aes`, or undefined: what an
 * authentic packet carried when `openPacket` could not decode it (section 8).
 */
function authenticPlaintext(
  packet: Uint8Array,
  key: Uint8Array,
  aes: BlockCipher,
  request: OpenRequest,
): Uint8Array | undefined {
  const header = readPacketHeader(packet, request.maxLength);
  if (!header.ok || header.value.direction !== Direction.ToHub) return undefined;
  const { address, counter, direction } = header.value;
  const ccm = Result.fromThrowable(() => createAesCcm(key, TAG_LENGTH, () => aes))();
  if (ccm.isErr()) return undefined;
  const opened = Result.fromThrowable(() =>
    ccm.value.open(
      packetNonce(address, direction, counter),
      concatBytes(packet.subarray(0, CLEAR_HEADER_LENGTH), request.binding),
      packet.subarray(CLEAR_HEADER_LENGTH),
    ),
  )();
  return opened.isOk() ? opened.value : undefined;
}

/**
 * Opens a packet to the hub under `key` with `aes`, the block cipher keyed with it: the packet,
 * or why not, with the plaintext when the tag verified (`DeviceCipher.open`).
 */
export function openToHub(
  packet: Uint8Array,
  key: Uint8Array,
  aes: BlockCipher,
  request: OpenRequest,
): Result<OpenedPacket, OpenFailure> {
  const opened = safeOpen(packet, {
    ...request,
    key,
    expectedDirection: Direction.ToHub,
    cipher: aes,
  });
  // A key or binding of the wrong length is the core's error; the packet does not open.
  if (opened.isErr()) return err(BAD_TAG);
  if (opened.value.ok) return ok(opened.value.value);
  const error = opened.value.error;
  if (error.code === "badTag") return err(BAD_TAG);
  return err({ error, plaintext: authenticPlaintext(packet, key, aes, request) });
}

/** One device's key with its block cipher, kept while the key stays the same. */
interface Keyed {
  readonly key: Uint8Array;
  readonly aes: BlockCipher;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The hub's cipher, with keys from the `KeyStore` (section 3). */
export class KeyStoreCipher implements DeviceCipher {
  readonly #keys: KeyStore;
  readonly #keyed = new Map<DeviceId, Keyed>();

  constructor(keys: KeyStore) {
    this.#keys = keys;
  }

  #keyedFor(device: DeviceId): Result<Keyed, HubError> {
    const key = this.#keys.key(device);
    if (key === undefined) {
      this.#keyed.delete(device);
      return err({ kind: "crypto", origin: ORIGIN, message: `no key for device ${device}` });
    }
    const cached = this.#keyed.get(device);
    if (cached !== undefined && sameBytes(cached.key, key)) return ok(cached);
    return safeAes(key).map((aes) => {
      const keyed = { key, aes };
      this.#keyed.set(device, keyed);
      return keyed;
    });
  }

  seal: DeviceCipher["seal"] = (device, message, request) =>
    this.#keyedFor(device).andThen((keyed) =>
      safeSeal(message, { ...request, key: keyed.key, cipher: keyed.aes }),
    );

  open: DeviceCipher["open"] = (device, packet, request) => {
    const keyed = this.#keyedFor(device);
    if (keyed.isErr()) return err(BAD_TAG);
    return openToHub(packet, keyed.value.key, keyed.value.aes, request);
  };
}
