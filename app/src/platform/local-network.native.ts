/**
 * The local network permission on a phone, the phone's side of `local-network.ts`
 * (`local-network-types.ts` says the rule): React Native's `PermissionsAndroid` for Android 17's
 * `ACCESS_LOCAL_NETWORK`, which `app.config.ts` declares.
 */
import { PermissionsAndroid, Platform } from "react-native";
import { phoneLocalNetwork } from "./local-network-types";

const LOCAL = PermissionsAndroid.PERMISSIONS.ACCESS_LOCAL_NETWORK;

export const { permission, ask } = phoneLocalNetwork({
  os: Platform.OS,
  version: Platform.Version,
  check: () => PermissionsAndroid.check(LOCAL),
  request: () => PermissionsAndroid.request(LOCAL),
});
