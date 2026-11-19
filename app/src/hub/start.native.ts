/**
 * The hub client on a phone (m3-design.md section 2), the phone's side of `start.ts`: the
 * platform-neutral client of `phone-client.ts`, given the phone's own pieces:
 *
 * - the secure store (`platform/vault-items.native.ts`, expo-secure-store, after the first unlock,
 *   this device only) and the phone's key (`platform/keys.native.ts`);
 * - React Native's own WebSocket, which takes the hub's certificate for a home host only
 *   (`plugins/hub-tls`, D132), sending `Origin` itself;
 * - the browse: P1's `hub-net` (`modules/hub-net`), so a typed code needs no address;
 * - links opened in the app (expo-linking): `hsn://link/1`, `hsn://restore/1` and `hsn://pair/1`
 *   codes, held in memory until the root layout claims them; nothing else of a link is kept;
 * - the app coming to the front (`AppState`): a vault that could not be read (the phone restarted
 *   and not yet unlocked) or a hub not reached is tried again.
 *
 * The channel speaks version 2 only (`PHONE_PROTO`, m3-design.md section 3).
 */
import * as Linking from "expo-linking";
import { AppState } from "react-native";
import * as phoneKeys from "../platform/keys.native";
import { secureItems } from "../platform/vault-items.native";
import { hubNet } from "../../modules/hub-net";
import type { SocketLike } from "./finder";
import { arrivals, type PhoneClient, startPhoneClient } from "./phone-client";
import { PHONE_PROTO } from "./restore";
import type { ArrivedCode, StartedClient } from "./start-types";
import { APP_VERSION } from "./version";
import { realTimers } from "./wire";

/** React Native's WebSocket takes headers as its third argument ‡ (wave 0 sent `Origin` so). */
type NativeSocket = new (
  url: string,
  protocols: undefined,
  options: { readonly headers: Readonly<Record<string, string>> },
) => SocketLike;

const makeSocket = (url: string, origin: string): SocketLike =>
  new (WebSocket as unknown as NativeSocket)(url, undefined, { headers: { Origin: origin } });

const links = arrivals({
  initial: () => Linking.getInitialURL(),
  listen: (opened) => {
    const subscription = Linking.addEventListener("url", (event) => {
      opened(event.url);
    });
    return () => {
      subscription.remove();
    };
  },
});

let started: PhoneClient | undefined;

/** The phone's client once started, for the phone's own pages (homes, restore, the vault's state). */
export function phoneClient(): PhoneClient | undefined {
  return started;
}

export function claimArrivedCode(): ArrivedCode | undefined {
  return links.claim();
}

export function onArrivedCode(listener: (code: ArrivedCode) => void): () => void {
  return links.on(listener);
}

export function startClient(): StartedClient {
  const phone = startPhoneClient({
    items: secureItems,
    makeSocket,
    finder: hubNet().finder,
    timers: realTimers,
    app: APP_VERSION,
    proto: PHONE_PROTO,
    keys: phoneKeys,
  });
  started = phone;
  phone.client.start();
  AppState.addEventListener("change", (state) => {
    if (state === "active") phone.resume();
  });
  // Wave 0's checks, in a development build only: a release bundle folds `__DEV__` to false
  // before it collects modules, so `dev/wave0.ts` is not in it (docs/spikes/P0-phone-build.md).
  if (__DEV__)
    void import("../dev/wave0").then((wave0) => {
      wave0.startWave0(phone.client);
    });
  return { client: phone.client };
}
