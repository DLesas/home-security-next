/** Device capabilities shared by registration and the closed-app notification service. */
import type { AppOpBodyV2 } from "@hsn/protocol/app";
import type { Outcome } from "./split";

export type Registration = AppOpBodyV2<"push.register">;
export type DeviceToken = Pick<Registration, "platform" | "environment" | "token">;
export type TokenResult = Outcome<DeviceToken, "notAvailable" | "failed">;
export interface TokenSource {
  read(): Promise<TokenResult>;
  /** Supplies the replacement token directly, without asking the provider again. */
  listen(received: (token: DeviceToken) => void): () => void;
}

/** One key generation; pending survives a lost hub reply and is usable on receipt of a push. */
export interface PushKeyRecord {
  readonly body: Registration;
  readonly client: number;
  readonly madeMs: number;
}
export interface PushKeys {
  readonly active: PushKeyRecord | null;
  readonly pending: PushKeyRecord | null;
}
export type StoredPush<T> = Promise<Outcome<T, "storage">>;
/** The service and JS write separate fields, so an armed update cannot overwrite key rotation. */
export interface PushStorage {
  keys(hub: string): StoredPush<PushKeys>;
  writeKeys(hub: string, keys: PushKeys): StoredPush<void>;
  arm(hub: string, armed: boolean): StoredPush<void>;
  homes(names: Readonly<Record<string, string>>): StoredPush<void>;
  remove(hub: string): StoredPush<void>;
}

/** A pending key may already have reached the hub; a failed read also warrants unregistering. */
export async function hasStoredTarget(store: PushStorage, hub: string): Promise<boolean> {
  const result = await store.keys(hub);
  return !result.ok || result.value.active !== null || result.value.pending !== null;
}

interface SystemToken {
  readonly type: string;
  readonly data: unknown;
}

/** Adapts Expo's OS-token APIs without even subscribing when the Android build has no FCM config. */
export function androidTokenSource(
  configured: boolean,
  get: () => Promise<SystemToken>,
  listen: (receive: (value: SystemToken) => void) => { remove(): void },
): TokenSource {
  /** Converts a platform token to the registration fields the hub expects. */
  function fromSystem(value: SystemToken): TokenResult {
    return value.type === "android" && typeof value.data === "string"
      ? { ok: true, value: { platform: "fcm", environment: "production", token: value.data } }
      : { ok: false, fault: "notAvailable" };
  }
  return {
    read: () =>
      configured
        ? get().then(fromSystem, () => ({ ok: false as const, fault: "failed" as const }))
        : Promise.resolve({ ok: false, fault: "notAvailable" }),
    listen: (receive) => {
      if (!configured) return () => undefined;
      const sub = listen((value) => {
        const result = fromSystem(value);
        if (result.ok) receive(result.value);
      });
      return () => {
        sub.remove();
      };
    },
  };
}
