/**
 * The phone's storage stays on the phone (`plugins/phone-storage.cjs`; m3-design.md section 2):
 * Android's backup and device transfer carry nothing of the app's, and a build asks for no
 * permission it does not use. The plugin's pure parts, on a manifest as Expo's prebuild holds it.
 */
import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

interface Permission {
  readonly $: Readonly<Record<string, string>>;
}
interface Manifest {
  manifest: {
    $?: Record<string, string>;
    application?: { $: Record<string, string> }[];
    "uses-permission"?: Permission[];
  };
}
interface PhoneStorage {
  dataExtractionRules(): string;
  keepStorageOnPhone(manifest: Manifest, release: boolean): Manifest;
  readonly DOMAINS: readonly string[];
  readonly RULES_PATH: string;
  readonly BLOCKED_IN_RELEASE: readonly string[];
}

const plugin = createRequire(import.meta.url)("../plugins/phone-storage.cjs") as PhoneStorage;

/** A manifest as Expo's template makes one, with what it asks for by default. */
function templateManifest(): Manifest {
  return {
    manifest: {
      $: { "xmlns:android": "http://schemas.android.com/apk/res/android" },
      application: [{ $: { "android:name": ".MainApplication", "android:allowBackup": "true" } }],
      "uses-permission": [
        { $: { "android:name": "android.permission.INTERNET" } },
        { $: { "android:name": "android.permission.READ_EXTERNAL_STORAGE" } },
        { $: { "android:name": "android.permission.WRITE_EXTERNAL_STORAGE" } },
        { $: { "android:name": "android.permission.SYSTEM_ALERT_WINDOW" } },
        { $: { "android:name": "android.permission.VIBRATE" } },
        { $: { "android:name": "android.permission.ACCESS_LOCAL_NETWORK" } },
      ],
    },
  };
}

const names = (m: Manifest, removed: boolean) =>
  (m.manifest["uses-permission"] ?? [])
    .filter((p) => (p.$["tools:node"] === "remove") === removed)
    .map((p) => p.$["android:name"]);

describe("Android's backup and device transfer", () => {
  test("every domain excluded, from cloud backup and from device transfer", () => {
    const rules = plugin.dataExtractionRules();
    for (const section of ["cloud-backup", "device-transfer"]) {
      const body = new RegExp(`<${section}>([\\s\\S]*?)</${section}>`, "u").exec(rules)?.[1] ?? "";
      const excluded = [...body.matchAll(/<exclude domain="([a-z_]+)" path="\." \/>/gu)].map(
        (m) => m[1],
      );
      expect({ section, excluded }).toEqual({ section, excluded: [...plugin.DOMAINS] });
      expect(body).not.toContain("<include");
    }
    expect(plugin.DOMAINS).toEqual([
      "root",
      "file",
      "database",
      "sharedpref",
      "external",
      "device_root",
      "device_file",
      "device_database",
      "device_sharedpref",
    ]);
  });

  test("the application: no backup, none on Android 11 and earlier, and the rules for Android 12 and later", () => {
    const app = plugin.keepStorageOnPhone(templateManifest(), false).manifest.application?.[0];
    expect(app?.$).toEqual({
      "android:name": ".MainApplication",
      "android:allowBackup": "false",
      "android:fullBackupContent": "false",
      "android:dataExtractionRules": plugin.RULES_PATH,
    });
    expect(plugin.RULES_PATH).toBe("@xml/hsn_data_extraction_rules");
  });
});

describe("Android's permissions", () => {
  test("a development build: external storage removed, its error overlay's permission kept", () => {
    const m = plugin.keepStorageOnPhone(templateManifest(), false);
    expect(names(m, true)).toEqual([
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ]);
    expect(names(m, false)).toEqual([
      "android.permission.INTERNET",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.VIBRATE",
      "android.permission.ACCESS_LOCAL_NETWORK",
    ]);
    expect(m.manifest.$?.["xmlns:tools"]).toBe("http://schemas.android.com/tools");
  });

  test("a release build: the overlay's permission removed too; the local network kept", () => {
    const m = plugin.keepStorageOnPhone(templateManifest(), true);
    expect(names(m, true)).toEqual([...plugin.BLOCKED_IN_RELEASE]);
    expect(names(m, false)).toEqual([
      "android.permission.INTERNET",
      "android.permission.VIBRATE",
      "android.permission.ACCESS_LOCAL_NETWORK",
    ]);
  });

  test("run twice, as a prebuild may: each permission named once", () => {
    const twice = plugin.keepStorageOnPhone(
      plugin.keepStorageOnPhone(templateManifest(), true),
      true,
    );
    const all = (twice.manifest["uses-permission"] ?? []).map((p) => p.$["android:name"]);
    expect(new Set(all).size).toBe(all.length);
  });
});
