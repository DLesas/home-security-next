const { withDangerousMod } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

/** Bundles the app's translations and notification sentences for a service with no JS runtime. */
module.exports = (config) =>
  withDangerousMod(config, [
    "android",
    (mod) => {
      const { projectRoot, platformProjectRoot } = mod.modRequest;
      for (const locale of fs.readdirSync(path.join(projectRoot, "locales"))) {
        const dir = path.join(platformProjectRoot, "app/src/main/assets/push", locale);
        fs.mkdirSync(dir, { recursive: true });
        for (const name of ["common.json", "push.json"]) {
          fs.copyFileSync(path.join(projectRoot, "locales", locale, name), path.join(dir, name));
        }
      }
      return mod;
    },
  ]);
