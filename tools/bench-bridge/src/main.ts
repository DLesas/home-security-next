#!/usr/bin/env bun
/**
 * `bun tools/bench-bridge/src/main.ts --manifest <bench-manifest.json> [--hub ws://127.0.0.1:8443/device]`
 *
 * Reads the bench's manifest (`hub/src/control-protocol/manifest.ts`) and bridges every network
 * link in it to the hub until SIGINT or SIGTERM (`bridge.ts`).
 */
import { readFileSync } from "node:fs";
import { benchManifest } from "@hsn/hub/src/control-protocol/manifest.ts";
import { BenchBridge, networkLinks } from "./bridge.ts";

const DEFAULT_HUB = "ws://127.0.0.1:8443/device";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const manifestPath = arg("--manifest");
if (manifestPath === undefined) {
  process.stderr.write("usage: bench-bridge --manifest <path> [--hub <ws url>]\n");
  process.exit(2);
}
const parsed = benchManifest.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
if (!parsed.success) {
  process.stderr.write(`bench-bridge: the manifest is not valid: ${parsed.error.message}\n`);
  process.exit(2);
}
const bridge = new BenchBridge(networkLinks(parsed.data), {
  hubUrl: arg("--hub") ?? DEFAULT_HUB,
  log: (line) => process.stderr.write(`bench-bridge: ${line}\n`),
});
bridge.start();
const stop = (): void => {
  void bridge.stop().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
