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
  MessageType,
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

/** One key with its block cipher, kept while the key stays the same. */
interface Keyed {
  readonly key: Uint8Array;
  readonly aes: BlockCipher;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** The keys a device's packets open under: its current key, and its next key during a change. */
interface Slots {
  readonly current: Uint8Array;
  readonly next: Uint8Array | undefined;
}

/**
 * The hub's cipher, with keys from the `KeyStore` (section 3). During a key change after a restore
 * (D141, m3-updates-design section 7) a device has two keys: `open` tries the next key first, then
 * the current one, and says which opened the packet (`keyUsed`, absent for the current key, as
 * before M3); `seal` uses the one `SealRequest.key` names.
 *
 * **A Key change sealed is a change of keys at once, for opening.** The core makes a device's new
 * key, writes it now and seals a Key change (0x84) carrying it in one step; the `KeyStore` learns
 * of the write only after its commit, at the end of the loop's turn. Until then the device's keys
 * for opening are those the Key change implies: the key it was sealed under as current, and the
 * key it carries as next. Without this, a packet still under a key the core has just dropped (the
 * other key of a row both of whose keys were held at the backup) would open in the same turn as
 * next, and be taken for the switch. The Key change cannot leave before the commit (the send gate,
 * hub-design.md section 4), so no packet under its new key can arrive before; and if the commit
 * never comes, the hub's restart forgets this as it forgets the core's state. It ends as soon as
 * the `KeyStore` holds those keys, or the device's switch to its new key, or the device's removal.
 *
 * No key ever leaves here but inside a sealed packet: errors name the device, never a key.
 */
export class KeyStoreCipher implements DeviceCipher {
  readonly #keys: KeyStore;
  readonly #ciphers = new Map<string, Keyed>();
  readonly #changed = new Map<
    DeviceId,
    { readonly current: Uint8Array; readonly next: Uint8Array }
  >();

  constructor(keys: KeyStore) {
    this.#keys = keys;
  }

  /** The device's keys for opening and sealing now, or undefined for a device with none. */
  #slots(device: DeviceId): Slots | undefined {
    const current = this.#keys.key(device);
    if (current === undefined) {
      this.#changed.delete(device);
      return undefined;
    }
    const next = this.#keys.nextKey?.(device);
    const changed = this.#changed.get(device);
    if (changed === undefined) return { current, next };
    const caughtUp =
      (sameBytes(current, changed.current) &&
        next !== undefined &&
        sameBytes(next, changed.next)) ||
      sameBytes(current, changed.next);
    if (caughtUp) {
      this.#changed.delete(device);
      return { current, next };
    }
    return changed;
  }

  /** One AES block cipher per key, made once (D94's seam). */
  #keyed(device: DeviceId, slot: "current" | "next", key: Uint8Array): Result<Keyed, HubError> {
    const name = `${device}:${slot}`;
    const cached = this.#ciphers.get(name);
    if (cached !== undefined && sameBytes(cached.key, key)) return ok(cached);
    return safeAes(key).map((aes) => {
      const keyed = { key, aes };
      this.#ciphers.set(name, keyed);
      return keyed;
    });
  }

  seal: DeviceCipher["seal"] = (device, message, request) => {
    const slots = this.#slots(device);
    if (slots === undefined) {
      this.#ciphers.delete(`${device}:current`);
      this.#ciphers.delete(`${device}:next`);
      return err({ kind: "crypto", origin: ORIGIN, message: `no key for device ${device}` });
    }
    const slot = request.key ?? "current";
    const key = slot === "next" ? slots.next : slots.current;
    if (key === undefined) {
      return err({ kind: "crypto", origin: ORIGIN, message: `no next key for device ${device}` });
    }
    return this.#keyed(device, slot, key)
      .andThen((keyed) => safeSeal(message, { ...request, key: keyed.key, cipher: keyed.aes }))
      .map((sealed) => {
        if (message.type === MessageType.KeyChange) {
          this.#changed.set(device, { current: key, next: message.newKey.slice() });
        }
        return sealed;
      });
  };

  open: DeviceCipher["open"] = (device, packet, request) => {
    const slots = this.#slots(device);
    if (slots === undefined) return err(BAD_TAG);
    if (slots.next !== undefined) {
      const next = this.#keyed(device, "next", slots.next);
      if (next.isOk()) {
        const opened = openToHub(packet, next.value.key, next.value.aes, request);
        if (opened.isOk()) return ok({ ...opened.value, keyUsed: "next" as const });
        // Authentic under the next key, though not a valid packet: that is its answer.
        if (opened.error.error.code !== "badTag") return opened;
      }
    }
    const current = this.#keyed(device, "current", slots.current);
    if (current.isErr()) return err(BAD_TAG);
    return openToHub(packet, current.value.key, current.value.aes, request);
  };
}
