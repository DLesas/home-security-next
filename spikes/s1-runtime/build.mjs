// Bundles the Node entry to one file; native add-ons stay outside the bundle.
import { build } from "esbuild";
await build({
  entryPoints: ["src/node.ts"], outfile: "dist/node.mjs", bundle: true, platform: "node", format: "esm", target: "node22",
  external: ["better-sqlite3", "serialport", "onnxruntime-node", "webgpu"],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
console.log("built dist/node.mjs");
