/**
 * The `DeviceCipher` over the `KeyStore` during a key change after a restore (D141,
 * m3-updates-design section 7; hub-design.md section 3): two keys, the next tried first and named
 * (`keyUsed`), the current alone named by nothing as before M3; sealing under the key asked for; a
 * sealed Key change taken as the device's keys at once for opening, until the store catches up;
 * the store's rules for whole rows, pending keys, the switch and deletion; no key in an error.
 */
import { describe, expect, test } from "bun:test";
import {
  counterBinding,
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  NO_BINDING,
  openPacket,
  sealPacket,
  toHex,
} from "@hsn/protocol";
import { deviceId } from "../../../src/core/model/ids.ts";
import { Rekey } from "../../../src/core/model/rows.ts";
import { KeyStoreCipher } from "../../../src/shell/cipher/device-cipher.ts";
import { MemoryKeyStore } from "../../../src/shell/storage/keys.ts";
import { heartbeat } from "../../scenarios/sensors/bench.ts";

const DEVICE = deviceId(3);
const ADDRESS = 0x5e000001;
const K0 = new Uint8Array(16).fill(0x10);
const K1 = new Uint8Array(16).fill(0x11);
const K2 = new Uint8Array(16).fill(0x12);
const REQUEST = { binding: NO_BINDING, maxLength: MaxPacketLength.Radio } as const;

function fromDevice(key: Uint8Array, counter: number, message: Message = heartbeat()): Uint8Array {
  return sealPacket(message, {
    key,
    direction: Direction.ToHub,
    address: ADDRESS,
    counter,
    binding: NO_BINDING,
    maxLength: MaxPacketLength.Radio,
  });
}

function openedBy(key: Uint8Array, packet: Uint8Array): boolean {
  return openPacket(packet, {
    key,
    expectedDirection: Direction.FromHub,
    binding: counterBinding(7),
    maxLength: MaxPacketLength.Radio,
  }).ok;
}

function sealTo(cipher: KeyStoreCipher, message: Message, key?: "current" | "next") {
  return cipher.seal(DEVICE, message, {
    direction: Direction.FromHub,
    address: ADDRESS,
    counter: 99,
    binding: counterBinding(7),
    maxLength: MaxPacketLength.Radio,
    ...(key === undefined ? {} : { key }),
  });
}

const keyChange = (newKey: Uint8Array): Message => ({ type: MessageType.KeyChange, newKey });

describe("opening with two keys", () => {
  test("the next key first, named; the current, unnamed as before M3; a stranger's, badTag", () => {
    const cipher = new KeyStoreCipher(
      new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]])),
    );
    const underNext = cipher.open(DEVICE, fromDevice(K1, 64), REQUEST);
    expect(underNext.isOk() && underNext.value.keyUsed).toBe("next");
    const underCurrent = cipher.open(DEVICE, fromDevice(K0, 65), REQUEST);
    expect(underCurrent.isOk()).toBe(true);
    expect(underCurrent.isOk() && "keyUsed" in underCurrent.value).toBe(false);
    const stranger = cipher.open(DEVICE, fromDevice(K2, 66), REQUEST);
    expect(stranger.isErr() && stranger.error.error.code).toBe("badTag");
  });

  test("with no next key, only the current, unnamed; a device with no key, badTag", () => {
    const cipher = new KeyStoreCipher(new MemoryKeyStore(new Map([[DEVICE, K0]])));
    const opened = cipher.open(DEVICE, fromDevice(K0, 64), REQUEST);
    expect(opened.isOk() && opened.value.keyUsed).toBeUndefined();
    expect(cipher.open(DEVICE, fromDevice(K1, 64), REQUEST).isErr()).toBe(true);
    expect(cipher.open(deviceId(9), fromDevice(K0, 64), REQUEST).isErr()).toBe(true);
  });
});

describe("sealing", () => {
  test("under the current key unless the next is asked; no next key, an error naming no key", () => {
    const cipher = new KeyStoreCipher(
      new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]])),
    );
    const message: Message = { type: MessageType.DisarmedNotice };
    const current = sealTo(cipher, message)._unsafeUnwrap();
    expect(openedBy(K0, current)).toBe(true);
    const next = sealTo(cipher, message, "next")._unsafeUnwrap();
    expect(openedBy(K1, next)).toBe(true);
    expect(openedBy(K0, next)).toBe(false);
    const lone = new KeyStoreCipher(new MemoryKeyStore(new Map([[DEVICE, K0]])));
    const failed = sealTo(lone, message, "next");
    expect(failed.isErr()).toBe(true);
    if (failed.isErr()) {
      const said = JSON.stringify(failed.error);
      for (const k of [K0, K1]) expect(said.includes(toHex(k))).toBe(false);
    }
  });
});

describe("a sealed Key change is the device's keys for opening at once", () => {
  test("under the current key: its key stays current, the new one is next, until the store has them", () => {
    const store = new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]]));
    const cipher = new KeyStoreCipher(store);
    sealTo(cipher, keyChange(K2))._unsafeUnwrap();
    // K1, the row's other key, is dropped at once: a packet under it is a stranger's.
    expect(cipher.open(DEVICE, fromDevice(K1, 64), REQUEST).isErr()).toBe(true);
    const k2 = cipher.open(DEVICE, fromDevice(K2, 64), REQUEST);
    expect(k2.isOk() && k2.value.keyUsed).toBe("next");
    // The commit lands: the store says the same; nothing changes.
    store.applyCommitted([
      {
        table: "device_keys",
        op: "pendingKey",
        key: { deviceId: DEVICE },
        nextKey: K2,
        rekey: Rekey.Required,
      },
    ]);
    expect(cipher.open(DEVICE, fromDevice(K1, 65), REQUEST).isErr()).toBe(true);
    expect(cipher.open(DEVICE, fromDevice(K0, 66), REQUEST).isOk()).toBe(true);
  });

  test("under the next key: that key becomes current, the new one next", () => {
    const store = new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]]));
    const cipher = new KeyStoreCipher(store);
    const sealed = sealTo(cipher, keyChange(K2), "next")._unsafeUnwrap();
    expect(openedBy(K1, sealed)).toBe(true);
    expect(cipher.open(DEVICE, fromDevice(K0, 64), REQUEST).isErr()).toBe(true);
    const underK1 = cipher.open(DEVICE, fromDevice(K1, 65), REQUEST);
    expect(underK1.isOk() && underK1.value.keyUsed).toBeUndefined();
    // Until the store holds it: then the store's own rows decide again.
    store.applyCommitted([
      {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: DEVICE, key: K1, nextKey: K2, rekey: Rekey.Required },
      },
    ]);
    const k2 = cipher.open(DEVICE, fromDevice(K2, 66), REQUEST);
    expect(k2.isOk() && k2.value.keyUsed).toBe("next");
  });

  test("an ordinary packet sealed changes nothing", () => {
    const store = new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]]));
    const cipher = new KeyStoreCipher(store);
    sealTo(cipher, { type: MessageType.DisarmedNotice })._unsafeUnwrap();
    const k1 = cipher.open(DEVICE, fromDevice(K1, 64), REQUEST);
    expect(k1.isOk() && k1.value.keyUsed).toBe("next");
  });
});

describe("the KeyStore's committed writes", () => {
  test("a switch keeps the new key as next for the run; a pairing's row ends it", () => {
    const store = new MemoryKeyStore(new Map([[DEVICE, K0]]), new Map([[DEVICE, K1]]));
    store.applyCommitted([
      {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: DEVICE, key: K1, nextKey: null, rekey: Rekey.None },
      },
    ]);
    expect(store.key(DEVICE)).toEqual(K1);
    expect(store.nextKey(DEVICE)).toEqual(K1);
    const cipher = new KeyStoreCipher(store);
    const opened = cipher.open(DEVICE, fromDevice(K1, 64), REQUEST);
    expect(opened.isOk() && opened.value.keyUsed).toBe("next");
    expect(cipher.open(DEVICE, fromDevice(K0, 65), REQUEST).isErr()).toBe(true);
    // A new pairing's key (another key, no next): no next key any more.
    store.applyCommitted([
      {
        table: "device_keys",
        op: "upsert",
        row: { deviceId: DEVICE, key: K2, nextKey: null, rekey: Rekey.None },
      },
    ]);
    expect(store.nextKey(DEVICE)).toBeUndefined();
  });

  test("a pending key for a device with no row is nothing; a delete takes both keys", () => {
    const store = new MemoryKeyStore(new Map([[DEVICE, K0]]));
    store.applyCommitted([
      {
        table: "device_keys",
        op: "pendingKey",
        key: { deviceId: deviceId(9) },
        nextKey: K1,
        rekey: Rekey.Required,
      },
    ]);
    expect(store.key(deviceId(9))).toBeUndefined();
    expect(store.nextKey(deviceId(9))).toBeUndefined();
    store.applyCommitted([
      {
        table: "device_keys",
        op: "pendingKey",
        key: { deviceId: DEVICE },
        nextKey: K1,
        rekey: Rekey.Required,
      },
    ]);
    expect(store.nextKey(DEVICE)).toEqual(K1);
    store.applyCommitted([{ table: "device_keys", op: "delete", key: { deviceId: DEVICE } }]);
    expect(store.key(DEVICE)).toBeUndefined();
    expect(store.nextKey(DEVICE)).toBeUndefined();
  });

  test("a next key with no current key is not held", () => {
    const store = new MemoryKeyStore(new Map(), new Map([[DEVICE, K1]]));
    expect(store.nextKey(DEVICE)).toBeUndefined();
  });
});
