/** Device capabilities shared by registration and the closed-app notification service. */
import type { AppOpBodyV2 } from "@hsn/protocol/app";
import type { Result } from "neverthrow";

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
