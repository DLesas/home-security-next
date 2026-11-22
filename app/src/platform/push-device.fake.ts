/** In-memory phone capabilities. No system registration, filesystem or network is involved. */
import { ok, err } from "neverthrow";
import type { DeviceToken, PushKeys, PushStorage, TokenResult, TokenSource } from "./push-types";

/** Lets a test replace the token and inspect the same per-hub fields the receiver would see. */
export function fakePush() {
  const keys = new Map<string, PushKeys>();
  const armed = new Map<string, boolean>();
  const callbacks = new Set<(token: DeviceToken) => void>();
  let token: TokenResult = err("notAvailable");
  let names: Readonly<Record<string, string>> = {};
  const storage: PushStorage = {
    keys: (hub) => Promise.resolve(ok(keys.get(hub) ?? { active: null, pending: null })),
    writeKeys: (hub, value) => {
      keys.set(hub, value);
      return Promise.resolve(ok(undefined));
    },
    arm: (hub, value) => {
      armed.set(hub, value);
      return Promise.resolve(ok(undefined));
    },
    homes: (value) => {
      names = value;
      return Promise.resolve(ok(undefined));
    },
    remove: (hub) => {
      keys.delete(hub);
      armed.delete(hub);
      return Promise.resolve(ok(undefined));
    },
  };
  const tokens: TokenSource = {
    read: () => Promise.resolve(token),
    listen: (receive) => {
      callbacks.add(receive);
      return () => {
        callbacks.delete(receive);
      };
    },
  };
  return {
    storage,
    tokens,
    keys,
    armed,
    names: () => names,
    /** Simulates the OS delivering a token change. */
    token(value: DeviceToken) {
      token = ok(value);
      for (const cb of callbacks) cb(value);
    },
  };
}
