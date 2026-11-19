// The phone's storage stays on the phone (m3-design.md section 2, "Keys and storage on the phone";
// section 10, P2 step 4): nothing the app keeps travels in a phone backup or to a new phone.
//
// - Android: `allowBackup` false (set in app.config.ts) turns off cloud backup, but for an app
//   that targets Android 12 or later it does not turn off device-to-device transfer ‡. So the
//   application also names data extraction rules that exclude every domain, for cloud backup and
//   for device transfer, and `fullBackupContent` false for Android 11 and earlier. The keys are in
//   expo-secure-store, whose own rules this replaces (its plugin is given
//   `configureAndroidBackup: false`).
// - Android's permissions: Expo's template asks for external storage, which the app never uses
//   (an export goes to the share sheet from the app's cache); a release build also drops
//   `SYSTEM_ALERT_WINDOW`, which only a development build's error overlay uses.
// - iOS needs nothing here: the keychain items are "this device only" (vault-items.native.ts), so
//   a backup restored on another phone carries none, and the app keeps nothing else.
//
// CommonJS, since Expo reads plugins with plain Node. The pure parts are exported for the tests.
const fs = require("node:fs");
const path = require("node:path");
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

const RULES_NAME = "hsn_data_extraction_rules";
const RULES_PATH = `@xml/${RULES_NAME}`;

/** Every domain Android's data extraction rules name ‡. */
const DOMAINS = [
  "root",
  "file",
  "database",
  "sharedpref",
  "external",
  "device_root",
  "device_file",
  "device_database",
  "device_sharedpref",
];

/** Permissions the app never needs, in every build. */
const NEVER = [
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

/** Permissions only a development build needs. */
const DEVELOPMENT_ONLY = ["android.permission.SYSTEM_ALERT_WINDOW"];

/** The rules file: every domain excluded, from cloud backup and from device transfer. */
function dataExtractionRules() {
  const excludes = DOMAINS.map((d) => `    <exclude domain="${d}" path="." />`).join("\n");
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Written by plugins/phone-storage.cjs: nothing the app keeps leaves the phone. -->",
    "<data-extraction-rules>",
    "  <cloud-backup>",
    excludes,
    "  </cloud-backup>",
    "  <device-transfer>",
    excludes,
    "  </device-transfer>",
    "</data-extraction-rules>",
    "",
  ].join("\n");
}

/**
 * The manifest's application with backup off and the rules named; `release` also drops the
 * development-only permissions.
 * @param {import("expo/config-plugins").AndroidConfig.Manifest.AndroidManifest} manifest
 * @param {boolean} release
 */
function keepStorageOnPhone(manifest, release) {
  for (const application of manifest.manifest.application ?? []) {
    application.$["android:allowBackup"] = "false";
    application.$["android:fullBackupContent"] = "false";
    application.$["android:dataExtractionRules"] = RULES_PATH;
  }
  const blocked = release ? [...NEVER, ...DEVELOPMENT_ONLY] : NEVER;
  manifest.manifest.$ = {
    ...manifest.manifest.$,
    "xmlns:tools": "http://schemas.android.com/tools",
  };
  const kept = (manifest.manifest["uses-permission"] ?? []).filter(
    (p) => !blocked.includes(p.$["android:name"]),
  );
  manifest.manifest["uses-permission"] = [
    ...kept,
    ...blocked.map((name) => ({ $: { "android:name": name, "tools:node": "remove" } })),
  ];
  return manifest;
}

/** @type {import("expo/config-plugins").ConfigPlugin<{ release?: boolean } | undefined>} */
const withPhoneStorage = (config, props) => {
  const release = props?.release === true;
  const written = withDangerousMod(config, [
    "android",
    (mod) => {
      const folder = path.join(
        mod.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${RULES_NAME}.xml`), dataExtractionRules());
      return mod;
    },
  ]);
  return withAndroidManifest(written, (mod) => {
    mod.modResults = keepStorageOnPhone(mod.modResults, release);
    return mod;
  });
};

module.exports = withPhoneStorage;
module.exports.dataExtractionRules = dataExtractionRules;
module.exports.keepStorageOnPhone = keepStorageOnPhone;
module.exports.DOMAINS = DOMAINS;
module.exports.RULES_PATH = RULES_PATH;
/** The permissions a release build must not ask for. */
module.exports.BLOCKED_IN_RELEASE = [...NEVER, ...DEVELOPMENT_ONLY];
