/** The Android bridge and Expo's native device token (never an Expo push-service token). */
import { ok, err } from "neverthrow";
import { requireOptionalNativeModule } from "expo";
import { getDevicePushTokenAsync } from "expo-notifications/build/getDevicePushTokenAsync";
import { addPushTokenListener } from "expo-notifications/build/TokenEmitter";
import type { DeviceToken, PushKeys, PushStorage, StoredPush, TokenSource } from "./push-types";

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
  const r = await pushStorage.keys(hub);
  // A failed read on Android leaves a possible target: ask the hub to unregister it.
  return r.isOk() ? r.value.active !== null || r.value.pending !== null : bridge !== null;
}

/** FCM registrations always use the production environment in the hub protocol. */
function fcm(token: string): DeviceToken {
  return { platform: "fcm", environment: "production", token };
}
export const pushTokens: TokenSource = {
  read: async () => {
    if (!bridge?.configured) return err("notAvailable" as const);
    return getDevicePushTokenAsync().then(
      (t) => (t.type === "android" ? ok(fcm(t.data)) : err("notAvailable" as const)),
      () => err("failed" as const),
    );
  },
  listen: (receive) => {
    if (!bridge?.configured) return () => undefined;
    const listener = addPushTokenListener((t) => {
      if (t.type === "android") receive(fcm(t.data));
    });
    return () => listener.remove();
  },
};
