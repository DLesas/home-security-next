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
        fs.copyFileSync(
          path.join(projectRoot, "locales", locale, "common.json"),
          path.join(dir, "common.json"),
        );
        const words = path.join(projectRoot, "modules/push/locales", locale, "push.json");
        if (fs.existsSync(words)) fs.copyFileSync(words, path.join(dir, "push.json"));
      }
      return mod;
    },
  ]);
