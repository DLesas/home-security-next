/**
 * The phone's parts (`phone-parts.tsx`) from P2's phone client (`hub/start.native.ts`'s
 * `phoneClient`): linking through the hub client, whose reach the client keeps; restore's messages
 * (`restore`); the backup keys the vault holds; the vault's and the local network's state. The
 * camera is supplied by the native Expo adapter.
 *
 * M5: the homes (`homes.ts`) over the phone client's records and its switch.
 */
import { AppState } from "react-native";
import { personCheck } from "../platform/app-lock.native";
import { secureItems } from "../platform/vault-items.native";
import { appLock } from "./app-lock";
import type { HubClient } from "../hub/client";
import type { PhoneClient } from "../hub/phone-client";
import { realTimers } from "../hub/wire";
import { i18n } from "../i18n";
import { cameraScanner } from "../platform/scanner";
import { phoneClient } from "../hub/start.native";
import { followHomes, type Homes, phoneHomes, pushRegistrationOf } from "./homes";
import type { PhoneParts } from "./phone-parts";
import { reachFaultOf } from "./phone-words";
import { standInPhoneParts } from "./stand-ins";
import type { VersionTwoClient } from "./version-two";

/** Keeps the phone's screen lock alive across route changes. */
const lock = appLock({
  check: personCheck,
  setting: secureItems,
  foreground: {
    /** Connects the lock timer to native background and foreground changes. */
    listen: (changed) => {
      if (AppState.currentState === "background") changed("background");
      const subscription = AppState.addEventListener("change", changed);
      return () => {
        subscription.remove();
      };
    },
  },
  clock: { wall: () => Date.now(), steady: () => performance.now() },
});

let homesOf: { readonly phone: PhoneClient; readonly homes: Homes } | undefined;

/** The shared screens' version 2 channel, for the active phone client only. */
export function versionTwoFor(hub: HubClient): VersionTwoClient | undefined {
  const phone = phoneClient();
  return phone?.client === hub ? { forward: phone.forward, testAlert: true } : undefined;
}

/** The homes of the phone client, made once and kept as the client changes them. */
function homesFor(phone: PhoneClient): Homes {
  if (homesOf?.phone === phone) return homesOf.homes;
  const hub = phone.client;
  const homes = phoneHomes({
    records: phone.records,
    choose: (identity) => phone.choose(identity),
    live: hub.live,
    request: (op, body) => hub.request(op, body),
    unregister: () => phone.forward("push.unregister", {}),
    pushRegistered: pushRegistrationOf,
    timers: realTimers,
    defaultName: (n) => (n === 1 ? i18n.t("homes.first") : i18n.t("homes.numbered", { n })),
  });
  followHomes(homes, hub.live);
  homesOf = { phone, homes };
  return homes;
}

/** The phone client's parts, or undefined before it has started. */
export function livePhoneParts(hub: HubClient): PhoneParts | undefined {
  const phone = phoneClient();
  if (phone === undefined) return undefined;
  const { records } = phone;
  const stand = standInPhoneParts(hub);
  const identities = async (): Promise<readonly string[]> => {
    const listed = await records.list();
    return listed.ok ? listed.value : [];
  };
  return {
    ...stand,
    scanner: cameraScanner,
    linker: {
      link: (secret, from, request) => hub.link(secret, from, request),
      reachFault: () => reachFaultOf(phone.reach.getState()),
    },
    restorer: {
      run: async (code, offered) => {
        // The home's name on this phone, for "Restoring <home> from …", read before the run.
        const names = new Map<string, string>();
        for (const identity of await identities()) {
          const read = await records.hub(identity).read();
          const name = read.ok ? read.value?.reach?.homeName : undefined;
          if (name !== undefined) names.set(identity, name);
        }
        return phone.restore(code, (offer) => {
          offered({ offer, homeName: names.get(offer.identity) ?? null });
        });
      },
    },
    holdsBackupKey: async () => {
      for (const identity of await identities()) {
        const held = await records.backupKeys.held(identity);
        if (held.ok && held.value.length > 0) return true;
      }
      return false;
    },
    vault: phone.vault,
    reach: phone.reach,
    homes: homesFor(phone),
    lock,
  };
}
