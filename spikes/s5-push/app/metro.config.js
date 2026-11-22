// Spike S5: Metro resolves the repository's protocol package from its own folder (not a workspace).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const repo = path.resolve(__dirname, "..", "..", "..");
const protocol = path.join(repo, "packages", "protocol");
const config = getDefaultConfig(__dirname);
config.watchFolders = [protocol];
config.resolver.extraNodeModules = { "@hsn/protocol": protocol };
config.resolver.nodeModulesPaths = [
  path.join(__dirname, "node_modules"),
  path.join(protocol, "node_modules"),
];
module.exports = config;
