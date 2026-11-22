/** The Android bridge and Expo's native device token (never an Expo push-service token). */
import { ok, err } from "neverthrow";
import { requireOptionalNativeModule } from "expo";
import { getDevicePushTokenAsync } from "expo-notifications/build/getDevicePushTokenAsync";
import { addPushTokenListener } from "expo-notifications/build/TokenEmitter";
import { androidTokenSource, hasStoredTarget } from "./push-types";
import type { PushKeys, PushStorage, StoredPush } from "./push-types";

interface Bridge {
  configured: boolean;
  keys(hub: string): Promise<PushKeys>;
  writeKeys(hub: string, keys: PushKeys): Promise<void>;
  arm(hub: string, armed: boolean): Promise<void>;
  homes(names: Readonly<Record<string, string>>): Promise<void>;
  remove(hub: string): Promise<void>;
}
const bridge = requireOptionalNativeModule<Bridge>("HomePush");

/** Maps bridge failures to a storage result without exposing details about the stored item. */
function access<T>(fn: (native: Bridge) => Promise<T>): StoredPush<T> {
  if (!bridge) return Promise.resolve(err("storage" as const));
  return Promise.resolve(bridge)
    .then(fn)
    .then(
      (value) => ok(value),
      () => err("storage" as const),
    );
}
export const pushStorage: PushStorage = {
  keys: (hub) => access((b) => b.keys(hub)),
  writeKeys: (hub, keys) => access((b) => b.writeKeys(hub, keys)),
  arm: (hub, armed) => access((b) => b.arm(hub, armed)),
  homes: (names) => access((b) => b.homes(names)),
  remove: (hub) => access((b) => b.remove(hub)),
};

/** Includes pending keys because the hub may have accepted a request whose reply was lost. */
export async function hasPushRegistration(hub: string): Promise<boolean> {
  return bridge !== null && hasStoredTarget(pushStorage, hub);
}

export const pushTokens = androidTokenSource(
  bridge?.configured === true,
  getDevicePushTokenAsync,
  addPushTokenListener,
);
