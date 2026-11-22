// The engine has no crypto.getRandomValues (docs/spikes/P0-phone-build.md): expo-crypto's, as the
// app's `random.native.ts` installs it. Noise's ephemeral keys need it.
import { getRandomValues } from "expo-crypto";
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  globalThis.crypto = { ...(globalThis.crypto ?? {}), getRandomValues };
}
