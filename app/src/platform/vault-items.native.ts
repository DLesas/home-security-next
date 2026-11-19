/**
 * The phone's secure store as the vault's `SecureItems` (`vault.ts`): expo-secure-store, every item
 * readable after the first unlock and on this device only (m3-design.md section 2):
 *
 * - iOS: the keychain with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so a lock-screen Disarm can read
 *   the key while the phone is locked (D51), and no phone backup or new phone carries it.
 * - Android: expo-secure-store encrypts each item with a key held in the Android Keystore ‡; the
 *   app's storage is kept out of Android's backup and device transfer (`plugins/phone-storage.cjs`).
 *
 * The store's errors become a `VaultFault` (`vaultFaultOf`); their messages, which name the item,
 * go no further.
 */
import {
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  deleteItemAsync,
  getItemAsync,
  type SecureStoreOptions,
  setItemAsync,
} from "expo-secure-store";
import type { Outcome } from "./split";
import { type SecureItems, type VaultFault, vaultFaultOf } from "./vault";

/** Every item's options: after the first unlock, this device only, no authentication asked. */
export const ITEM_OPTIONS: SecureStoreOptions = {
  keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

function settled<T>(pending: Promise<T>): Promise<Outcome<T, VaultFault>> {
  return pending.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, fault: vaultFaultOf(error) }),
  );
}

export const secureItems: SecureItems = {
  get: (name) => settled(getItemAsync(name, ITEM_OPTIONS)),
  set: (name, value) => settled(setItemAsync(name, value, ITEM_OPTIONS).then(() => undefined)),
  delete: (name) => settled(deleteItemAsync(name, ITEM_OPTIONS).then(() => undefined)),
};
