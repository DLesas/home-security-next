// The hub's certificate on the home network (m3-design.md section 2, D132; wave 0's one-day
// check, docs/spikes/P0-phone-build.md): React Native's own WebSocket accepts the certificate a
// hub presents for a private, link-local or loopback address or a `.local` name, and keeps the
// system's checks for everything else. No native module: two files of native code, copied into
// the generated projects, through React Native's two global hooks:
//
// - iOS: `RCTSetCustomSRWebSocketProvider`, set as the app loads (`hub-tls/HSNHubTls.m`).
// - Android: `WebSocketModule.setCustomClientBuilder`, set in `MainApplication.onCreate`
//   (`hub-tls/HubTls.kt`).
//
// CommonJS, since Expo reads plugins with plain Node.
const fs = require("node:fs");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withMainApplication,
  withXcodeProject,
} = require("expo/config-plugins");

const IOS_FILE = "HSNHubTls.m";
const ANDROID_FILE = "HubTls.kt";
const ANDROID_PACKAGE = ["org", "hsn", "hubtls"];

/** @param {string} projectRoot */
const source = (projectRoot, file) => path.join(projectRoot, "plugins", "hub-tls", file);

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withIos = (config) => {
  const copied = withDangerousMod(config, [
    "ios",
    (mod) => {
      const name = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
      fs.copyFileSync(
        source(mod.modRequest.projectRoot, IOS_FILE),
        path.join(mod.modRequest.platformProjectRoot, name, IOS_FILE),
      );
      return mod;
    },
  ]);
  return withXcodeProject(copied, (mod) => {
    const name = IOSConfig.XcodeUtils.getProjectName(mod.modRequest.projectRoot);
    const filepath = `${name}/${IOS_FILE}`;
    if (!mod.modResults.hasFile(filepath))
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: name,
        project: mod.modResults,
      });
    return mod;
  });
};

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withAndroid = (config) => {
  const copied = withDangerousMod(config, [
    "android",
    (mod) => {
      const folder = path.join(
        mod.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "java",
        ...ANDROID_PACKAGE,
      );
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(
        source(mod.modRequest.projectRoot, ANDROID_FILE),
        path.join(folder, ANDROID_FILE),
      );
      return mod;
    },
  ]);
  return withMainApplication(copied, (mod) => {
    let contents = mod.modResults.contents;
    const importLine = `import ${ANDROID_PACKAGE.join(".")}.HubTls`;
    if (!contents.includes(importLine))
      contents = contents.replace(/^(package [^\n]+\n)/mu, `$1\n${importLine}\n`);
    if (!contents.includes("HubTls.install()"))
      contents = contents.replace(/(super\.onCreate\(\)\n)/u, `$1    HubTls.install()\n`);
    mod.modResults.contents = contents;
    return mod;
  });
};

/** @type {import("expo/config-plugins").ConfigPlugin} */
module.exports = (config) => withAndroid(withIos(config));
