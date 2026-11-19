/**
 * The phone's parts (`phone-parts.tsx`) from P2's phone client (`hub/start.native.ts`'s
 * `phoneClient`): linking through the hub client, whose reach the client keeps; restore's messages
 * (`restore`); the backup keys the vault holds; the vault's and the local network's state. The
 * camera is supplied by the native Expo adapter.
 */
import type { HubClient } from "../hub/client";
import { cameraScanner } from "../platform/scanner";
import { phoneClient } from "../hub/start.native";
import type { PhoneParts } from "./phone-parts";
import { reachFaultOf } from "./phone-words";
import { standInPhoneParts } from "./stand-ins";

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
  };
}
