/**
 * The app's Expo configuration (m3-design.md section 2; section 10, item 1): names and
 * identifiers from the one configuration point, the protocol's scheme, the system's questions in
 * the translation file's words, and cleartext for development builds only, refused three ways in
 * a release (here, the configuration's and the release check's).
 */
import { describe, expect, test } from "bun:test";
import { LINKING } from "@hsn/protocol/app";
import { PAIR_QR } from "@hsn/protocol/pairing";
import {
  DEPLOYMENT,
  DEPLOYMENT_FILE,
  type Deployment,
  type DeploymentFile,
  deploymentOf,
} from "../../packages/deployment/src/deployment.ts";
import { allowCleartext, appConfig, appIdentityOf, metroOnLoopback } from "../app.config.ts";
import english from "../locales/en/common.json" with { type: "json" };
import { ANDROID_MANIFEST, allowsCleartext, releaseProblems } from "../scripts/release-check.ts";

const schemeOf = (prefix: string) => prefix.slice(0, prefix.indexOf(":"));

/** What `deploymentOf` gives for the fields the app's configuration uses. */
function appPartOf(source: DeploymentFile) {
  const { productName, ios, android } = deploymentOf(source);
  return { productName, ios, android };
}

describe("app.config.ts", () => {
  test("reads deployment.json as the configuration point reads it", () => {
    expect(appIdentityOf(DEPLOYMENT_FILE)).toEqual(appPartOf(DEPLOYMENT_FILE));
    // Chosen values, every field different from the placeholders, and a team id set.
    const chosen: DeploymentFile = {
      productName: "Home Watch",
      domain: "example.org",
      hubsDomain: "hubs.example.org",
      iosBundleId: "org.example.watch",
      iosAppGroup: "group.org.example.watch",
      iosTeamId: "ABCDE12345",
      androidApplicationId: "org.example.watch.android",
      acmeDirectory: "https://acme.example.org/directory",
    };
    expect(appIdentityOf(chosen)).toEqual(appPartOf(chosen));
  });

  test("the names and identifiers are the configuration point's", () => {
    const config = appConfig(false);
    expect(config.name).toBe(DEPLOYMENT.productName);
    expect(config.ios?.bundleIdentifier).toBe(DEPLOYMENT.ios.bundleId);
    expect(config.ios?.entitlements).toEqual({
      "com.apple.security.application-groups": [DEPLOYMENT.ios.appGroup],
    });
    expect(config.android?.package).toBe(DEPLOYMENT.android.applicationId);
  });

  test("a team id is given to Apple only when there is one", () => {
    const none = appIdentityOf({ ...DEPLOYMENT_FILE, iosTeamId: null });
    expect(appConfig(false, none).ios).not.toHaveProperty("appleTeamId");
    const team = appIdentityOf({ ...DEPLOYMENT_FILE, iosTeamId: "ABCDE12345" });
    expect(appConfig(false, team).ios?.appleTeamId).toBe("ABCDE12345");
  });

  test("the native modules' plugins: no microphone, no Bluetooth in the background", () => {
    const plugins = appConfig(true).plugins ?? [];
    const options = (name: string): unknown =>
      plugins.find((p): p is [string, unknown] => Array.isArray(p) && p[0] === name)?.[1];
    expect(options("expo-secure-store")).toMatchObject({ configureAndroidBackup: false });
    expect(options("expo-camera")).toMatchObject({
      cameraPermission: english.permissions.camera,
      microphonePermission: false,
      recordAudioAndroid: false,
    });
    expect(options("react-native-ble-plx")).toMatchObject({
      isBackgroundEnabled: false,
      bluetoothAlwaysPermission: english.permissions.bluetooth,
    });
  });

  test("a development build reaches Metro on loopback, once, in debug only", () => {
    const main =
      "class MainApplication {\n  override fun onCreate() {\n    super.onCreate()\n    other()\n  }\n}\n";
    const changed = metroOnLoopback(main);
    expect(changed).toContain(
      "super.onCreate()\n    if (BuildConfig.DEBUG) android.preference.PreferenceManager",
    );
    expect(changed).toContain('putString("debug_http_host", "localhost:8081")');
    expect(metroOnLoopback(changed)).toBe(changed);
    expect(metroOnLoopback("no create here")).toBe("no create here");
  });

  test("phones only, in portrait", () => {
    const config = appConfig(false);
    expect(config.orientation).toBe("portrait");
    expect(config.ios?.supportsTablet).toBe(false);
  });

  test("the scheme is the protocol's, for links, restores and boards alike", () => {
    const scheme = appConfig(false).scheme;
    expect(scheme).toBe(schemeOf(LINKING.qrPrefix));
    expect(scheme).toBe(schemeOf(LINKING.restoreQrPrefix));
    expect(scheme).toBe(schemeOf(PAIR_QR.prefix));
  });

  test("the web build is configured as before", () => {
    const config = appConfig(false);
    expect(config.slug).toBe("hsn");
    expect(config.web).toEqual({ output: "single", bundler: "metro" });
    expect(config.plugins?.[0]).toBe("expo-router");
    expect(config.experiments).toEqual({ typedRoutes: false });
  });

  test("the system's questions are the translation file's sentences", () => {
    const plist = appConfig(false).ios?.infoPlist ?? {};
    expect(plist.NSCameraUsageDescription).toBe(english.permissions.camera);
    expect(plist.NSBluetoothAlwaysUsageDescription).toBe(english.permissions.bluetooth);
    expect(plist.NSLocalNetworkUsageDescription).toBe(english.permissions.localNetwork);
    expect(plist.NSBonjourServices).toEqual(["_hsn-hub._tcp"]);
    expect(plist.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
  });

  test("only a development build allows cleartext", () => {
    // A plugin's change waits in the configuration's mods until prebuild applies it.
    expect("mods" in appConfig(false)).toBe(true);
    expect("mods" in appConfig(true)).toBe(false);
    const manifest = allowCleartext({
      manifest: {
        $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
        queries: [],
        application: [{ $: { "android:name": ".MainApplication" } }],
      },
    });
    expect(manifest.manifest.application?.[0]?.$["android:usesCleartextTraffic"]).toBe("true");
  });
});

describe("the release check", () => {
  const chosen: Deployment = {
    ...DEPLOYMENT,
    ios: { bundleId: "org.example.home", appGroup: "group.org.example.home", teamId: "ABCDE12345" },
    android: { applicationId: "org.example.home" },
    relay: { url: "wss://relay.example.org" },
    push: { url: "wss://push.example.org" },
    names: {
      ...DEPLOYMENT.names,
      domain: "hubs.example.org",
      canary: "rebindtest.hubs.example.org",
      control: "control.hubs.example.org",
    },
  };
  const plain = '<manifest><application android:name=".MainApplication"/></manifest>';
  const cleartext =
    '<manifest><application android:name=".MainApplication" android:usesCleartextTraffic="true"/></manifest>';

  test("refuses the placeholders", () => {
    expect(releaseProblems(DEPLOYMENT, plain)).toContain("ios.bundleId: placeholder");
    expect(releaseProblems(DEPLOYMENT, plain)).toContain("ios.teamId: noTeam");
  });

  test("refuses a manifest that allows cleartext, or none", () => {
    expect(allowsCleartext(cleartext)).toBe(true);
    expect(releaseProblems(chosen, cleartext)).toEqual([
      `${ANDROID_MANIFEST}: allows cleartext traffic`,
    ]);
    expect(releaseProblems(chosen, undefined)).toHaveLength(1);
  });

  test("passes a chosen deployment and a manifest without cleartext", () => {
    expect(allowsCleartext(plain)).toBe(false);
    expect(releaseProblems(chosen, plain)).toEqual([]);
  });
});
