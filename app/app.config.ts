/**
 * The app's Expo configuration (m3-design.md section 2; section 10, item 1), in place of a fixed
 * `app.json`: the web build the hub serves, and the iOS and Android development builds made on
 * this Mac by `expo prebuild`, whose `ios/` and `android/` are generated and not committed.
 *
 * - The product's name and identifiers come from the one configuration point, `@hsn/deployment`
 *   (m4-design.md section 2); nothing in `app/` names them otherwise. Its placeholders build for
 *   the simulators; the release check (`scripts/release-check.ts`) refuses them.
 * - The URL scheme is the protocol's, `hsn`: it never follows the product's name, since boards in
 *   houses draw `hsn://pair/1` codes. `test/app-config.test.ts` checks it is `LINKING`'s.
 * - The system's own questions use the sentences the pages that ask first use (section 2, rule
 *   7), from the translation file.
 * - Cleartext `ws://`, for a relay run on this Mac, is a development build's only: Android's
 *   setting is applied only while `HSN_RELEASE` is unset, and the release check refuses a
 *   generated manifest that allows it. iOS's `NSAllowsLocalNetworking`, which the hub's own
 *   addresses need in every build, covers private addresses ‡.
 */
import type { ExpoConfig } from "expo/config";
import {
  type AndroidConfig,
  type ConfigPlugin,
  withAndroidManifest,
  withMainApplication,
} from "expo/config-plugins";
// The configuration point's values, as JSON: Expo reads this file with plain Node, which runs no
// TypeScript but this file's own, so nothing here imports TypeScript from `packages/`.
import file from "@hsn/deployment/deployment.json" with { type: "json" };
import english from "./locales/en/common.json" with { type: "json" };

/** What the app's configuration takes from `deployment.json`. */
export interface AppIdentity {
  readonly productName: string;
  readonly ios: {
    readonly bundleId: string;
    readonly appGroup: string;
    readonly teamId: string | null;
  };
  readonly android: { readonly applicationId: string };
}

/**
 * The app's names and identifiers from `deployment.json`, as `deploymentOf` in
 * `packages/deployment/src/deployment.ts` derives them (`test/app-config.test.ts` checks the two
 * agree on every field).
 */
export function appIdentityOf(source: {
  readonly productName: string;
  readonly iosBundleId: string;
  readonly iosAppGroup: string;
  readonly iosTeamId: string | null;
  readonly androidApplicationId: string;
}): AppIdentity {
  return {
    productName: source.productName,
    ios: { bundleId: source.iosBundleId, appGroup: source.iosAppGroup, teamId: source.iosTeamId },
    android: { applicationId: source.androidApplicationId },
  };
}

const deployment = appIdentityOf(file);

/**
 * `LINKING`'s scheme. Written here, not imported: the protocol package is TypeScript, which Node
 * does not run (`test/app-config.test.ts` checks it is the protocol's).
 */
const SCHEME = "hsn";

/** The service the phone browses for its hub (m3-design.md section 2, "Reaching the hub at home"). */
const HUB_SERVICE = "_hsn-hub._tcp";

/** Whether this is a release build, which never allows cleartext: `HSN_RELEASE` set by its build. */
function isRelease(): boolean {
  const env = (globalThis as { readonly process?: { readonly env: Record<string, unknown> } })
    .process?.env;
  return env?.HSN_RELEASE !== undefined;
}

/** Android's manifest allowing cleartext: a development build's, for `ws://` to a relay on this Mac. */
export function allowCleartext(
  manifest: AndroidConfig.Manifest.AndroidManifest,
): AndroidConfig.Manifest.AndroidManifest {
  for (const application of manifest.manifest.application ?? [])
    application.$["android:usesCleartextTraffic"] = "true";
  return manifest;
}

const withDevelopmentCleartext: ConfigPlugin = (config) =>
  withAndroidManifest(config, (manifest) => {
    manifest.modResults = allowCleartext(manifest.modResults);
    return manifest;
  });

/**
 * A development build on Android reaches Metro on this Mac through `adb reverse`, on loopback:
 * Android 17 counts the emulator's `10.0.2.2` as the local network, which the app may not reach
 * until the person allows it (wave 0, docs/spikes/P0-phone-build.md). Debug builds only.
 */
export function metroOnLoopback(mainApplication: string): string {
  const call =
    '    if (BuildConfig.DEBUG) android.preference.PreferenceManager.getDefaultSharedPreferences(this).edit().putString("debug_http_host", "localhost:8081").apply()\n';
  if (mainApplication.includes("debug_http_host")) return mainApplication;
  return mainApplication.replace(/(super\.onCreate\(\)\n)/u, `$1${call}`);
}

const withDevelopmentMetroOnLoopback: ConfigPlugin = (config) =>
  withMainApplication(config, (mod) => {
    mod.modResults.contents = metroOnLoopback(mod.modResults.contents);
    return mod;
  });

const why = english.permissions;

/** The configuration, for a development build or a release one. */
export function appConfig(release: boolean, identity: AppIdentity = deployment): ExpoConfig {
  const config: ExpoConfig = {
    name: identity.productName,
    slug: "hsn",
    scheme: SCHEME,
    version: "0.1.0",
    platforms: ["ios", "android", "web"],
    // Phones only for now, in portrait: tablets are not in scope (the coordinator's ruling on
    // m3-design.md section 2, rule 10).
    orientation: "portrait",
    // One colour scheme, so the keyboard and the system's dialogs stay pale (section 2, rule 11).
    userInterfaceStyle: "light",
    web: { output: "single", bundler: "metro" },
    ios: {
      bundleIdentifier: identity.ios.bundleId,
      ...(identity.ios.teamId === null ? {} : { appleTeamId: identity.ios.teamId }),
      supportsTablet: false,
      // Shared with the notification extension (M5); a placeholder group builds for the simulator ‡.
      entitlements: { "com.apple.security.application-groups": [identity.ios.appGroup] },
      infoPlist: {
        NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        NSLocalNetworkUsageDescription: why.localNetwork,
        NSBonjourServices: [HUB_SERVICE],
        NSCameraUsageDescription: why.camera,
        NSBluetoothAlwaysUsageDescription: why.bluetooth,
        NSLocationWhenInUseUsageDescription: why.location,
        NSLocationAlwaysAndWhenInUseUsageDescription: why.location,
        NSFaceIDUsageDescription: why.faceId,
      },
    },
    android: {
      package: identity.android.applicationId,
      // The keys stay on this phone: Android's automatic backup carries none of the app's storage.
      allowBackup: false,
      permissions: [
        "android.permission.CAMERA",
        "android.permission.BLUETOOTH_SCAN",
        "android.permission.BLUETOOTH_CONNECT",
        // Android 17's, asked from the start in the Nearby devices group (section 2).
        "android.permission.ACCESS_LOCAL_NETWORK",
        "android.permission.POST_NOTIFICATIONS",
      ],
    },
    plugins: [
      "expo-router",
      // React Native's own WebSocket takes the hub's certificate at home only (D132; wave 0).
      "./plugins/hub-tls.cjs",
      // The keys' store. Android's automatic backup is off for the whole app (`allowBackup`), so
      // the plugin's backup rules are not needed.
      ["expo-secure-store", { faceIDPermission: why.faceId, configureAndroidBackup: false }],
      // Scanning codes: no microphone, no recording.
      [
        "expo-camera",
        {
          cameraPermission: why.camera,
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      // In front only: pairing and updates happen with the app open (m3-design.md section 5).
      [
        "react-native-ble-plx",
        {
          isBackgroundEnabled: false,
          neverForLocation: true,
          bluetoothAlwaysPermission: why.bluetooth,
        },
      ],
    ],
    experiments: { typedRoutes: false },
  };
  return release ? config : withDevelopmentMetroOnLoopback(withDevelopmentCleartext(config));
}

export default (): ExpoConfig => appConfig(isRelease());
