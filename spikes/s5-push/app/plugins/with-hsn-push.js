// Spike S5, step 5: how the `push` module's native pieces join Expo's prebuilt projects, with no
// library but Expo's own config plugins (the `xcode` package they carry). Throwaway.
//
// iOS: the notification service extension as a target of its own (`HsnPushExtension`, bundle id
// `<app>.push`), embedded in the app; its Swift, Info.plist and entitlements copied from
// `extension/`; the app's translation file (`app/locales/en/common.json`) copied into it; the App
// Group on both targets; the Time Sensitive entitlement on the app; the placeholder's `push.placeholder` in the app's Localizable.strings.
// Android: the words as assets of the app (the service runs with no JavaScript), and cleartext for
// the relay on this Mac in every build of the spike.
const fs = require("node:fs");
const path = require("node:path");
const {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withEntitlementsPlist,
  withXcodeProject,
  IOSConfig,
} = require("expo/config-plugins");

const EXT = "HsnPushExtension";
const GROUP = "group.invalid.hsn.app.s5spike";
const HERE = path.resolve(__dirname, "..");
const COMMON = path.resolve(HERE, "..", "..", "..", "app", "locales", "en", "common.json");
const PLACEHOLDER = JSON.parse(fs.readFileSync(path.join(HERE, "extension", "push-words.json"), "utf8")).placeholder;

const withFiles = (config) =>
  withDangerousMod(config, [
    "ios",
    (mod) => {
      const ios = mod.modRequest.platformProjectRoot;
      const dir = path.join(ios, EXT);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of ["NotificationService.swift", "Info.plist", "push-words.json"])
        fs.copyFileSync(path.join(HERE, "extension", f), path.join(dir, f));
      fs.copyFileSync(COMMON, path.join(dir, "common.json"));
      fs.writeFileSync(
        path.join(dir, `${EXT}.entitlements`),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.apple.security.application-groups</key><array><string>${GROUP}</string></array>
</dict></plist>
`,
      );
      const app = path.join(ios, mod.modRequest.projectName);
      fs.writeFileSync(
        path.join(app, "Localizable.strings"),
        `"push.placeholder" = ${JSON.stringify(PLACEHOLDER)};\n`,
      );
      return mod;
    },
  ]);

const withEntitlements = (config) =>
  withEntitlementsPlist(config, (mod) => {
    mod.modResults["com.apple.security.application-groups"] = [GROUP];
    mod.modResults["com.apple.developer.usernotifications.time-sensitive"] = true;
    return mod;
  });

const withExtensionTarget = (config) =>
  withXcodeProject(config, (mod) => {
    const project = mod.modResults;
    const appName = mod.modRequest.projectName;
    IOSConfig.XcodeUtils.addResourceFileToGroup({
      filepath: `${appName}/Localizable.strings`,
      groupName: appName,
      project,
      isBuildFile: true,
    });
    if (project.pbxTargetByName(EXT)) return mod;
    const objects = project.hash.project.objects;
    objects.PBXTargetDependency = objects.PBXTargetDependency || {};
    objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};
    const group = project.addPbxGroup(
      ["NotificationService.swift", "Info.plist", "common.json", "push-words.json", `${EXT}.entitlements`],
      EXT,
      EXT,
    );
    const main = project.getFirstProject().firstProject.mainGroup;
    project.getPBXGroupByKey(main).children.push({ value: group.uuid, comment: EXT });
    const bundleId = `${config.ios.bundleIdentifier}.push`;
    const target = project.addTarget(EXT, "app_extension", EXT, bundleId);
    project.addBuildPhase(["NotificationService.swift"], "PBXSourcesBuildPhase", "Sources", target.uuid);
    project.addBuildPhase(["common.json", "push-words.json"], "PBXResourcesBuildPhase", "Resources", target.uuid);
    project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings;
      if (settings === undefined || settings.PRODUCT_NAME !== `"${EXT}"`) continue;
      Object.assign(settings, {
        INFOPLIST_FILE: `${EXT}/Info.plist`,
        CODE_SIGN_ENTITLEMENTS: `${EXT}/${EXT}.entitlements`,
        CODE_SIGN_STYLE: "Automatic",
        PRODUCT_BUNDLE_IDENTIFIER: bundleId,
        SWIFT_VERSION: "5.0",
        IPHONEOS_DEPLOYMENT_TARGET: "16.4",
        TARGETED_DEVICE_FAMILY: '"1"',
        GENERATE_INFOPLIST_FILE: "NO",
        CURRENT_PROJECT_VERSION: "1",
        MARKETING_VERSION: "0.0.1",
      });
    }
    return mod;
  });

const withAndroidPieces = (config) =>
  withAndroidManifest(
    withDangerousMod(config, [
      "android",
      (mod) => {
        const assets = path.join(mod.modRequest.platformProjectRoot, "app", "src", "main", "assets");
        fs.mkdirSync(assets, { recursive: true });
        fs.copyFileSync(COMMON, path.join(assets, "common.json"));
        fs.copyFileSync(path.join(HERE, "extension", "push-words.json"), path.join(assets, "push-words.json"));
        return mod;
      },
    ]),
    (mod) => {
      for (const app of mod.modResults.manifest.application ?? []) {
        // A simulator-only, bundled-JS build. run-as streams fixture keys into private storage.
        app.$["android:usesCleartextTraffic"] = "true";
      }
      return mod;
    },
  );

module.exports = (config) =>
  withAppBuildGradle(withAndroidPieces(withExtensionTarget(withEntitlements(withFiles(config)))), (mod) => {
    // Allow adb run-as provisioning in the bundled-JS simulator build.
    mod.modResults.contents = mod.modResults.contents.replace(/(buildTypes\s*\{[\s\S]*?release\s*\{)(?!\s*debuggable true)/u, "$1\n            debuggable true");
    return mod;
  });
