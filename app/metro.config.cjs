// NativeWind v5's installation guide (metro.config.js), as .cjs: this package is "type": "module".
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativewind } = require("nativewind/metro");

/** @type {import('expo/metro-config').MetroConfig} */
// This folder, found from a file in it (the guide's `__dirname`, which the lint config does not know).
const config = getDefaultConfig(path.dirname(require.resolve("./app.json")));

module.exports = withNativewind(config);
