/** Device capabilities shared by registration and the closed-app notification service. */
import type { AppOpBodyV2 } from "@hsn/protocol/app";
import { ok, err, type Result } from "neverthrow";

export type Registration = AppOpBodyV2<"push.register">;
export type DeviceToken = Pick<Registration, "platform" | "environment" | "token">;
export type TokenResult = Result<DeviceToken, "notAvailable" | "failed">;
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
export type StoredPush<T> = Promise<Result<T, "storage">>;
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
  return result.isErr() || result.value.active !== null || result.value.pending !== null;
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
      ? ok({ platform: "fcm", environment: "production", token: value.data })
      : err("notAvailable");
  }
  return {
    read: () =>
      configured
        ? get().then(fromSystem, () => err("failed" as const))
        : Promise.resolve(err("notAvailable")),
    listen: (receive) => {
      if (!configured) return () => undefined;
      const sub = listen((value) => {
        const result = fromSystem(value);
        if (result.isOk()) receive(result.value);
      });
      return () => {
        sub.remove();
      };
    },
  };
}
