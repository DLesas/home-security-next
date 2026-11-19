/**
 * What the phone loads from this package runs without Node: the phone's bundler (Metro) refuses
 * Node's built-in modules. From each entry point the app imports (`./pairing`, `./app`,
 * `./relay`), every file reached through a relative import must import no `node:` module and use
 * no `Buffer` or `process`, and the only packages are zod and noble's. `import type` and
 * `export type` lines are erased when bundling and are not followed (`app/linking.ts` takes the
 * `Sha256` type from `crypto/sha256.ts`, which is Node's, on purpose); every other import is,
 * including one that names only types inline. The package's `crypto/` and `usb/` files use Node's
 * crypto by design and are for the hub and the verifier, so pairing does not import them.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");
const STATEMENT = /^\s*(import|export)\s(type\s)?[^;]*?from\s+"([^"]+)"/gmsu;
const PACKAGES = /^(?:zod|@noble\/(?:hashes|ciphers|curves)\/[\w.-]+)$/u;

function reach(entry: string): { files: string[]; problems: string[] } {
  const seen = new Set<string>();
  const problems: string[] = [];
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
    const where = relative(SRC, file);
    if (/\bBuffer\b/u.test(code)) problems.push(`${where} uses Buffer`);
    if (/\bprocess\./u.test(code)) problems.push(`${where} uses process`);
    for (const m of text.matchAll(STATEMENT)) {
      const [, , typeOnly, specifier = ""] = m;
      if (typeOnly !== undefined) continue;
      if (specifier.startsWith(".")) walk(join(dirname(file), specifier));
      else if (!PACKAGES.test(specifier)) problems.push(`${where} imports ${specifier}`);
    }
  };
  walk(join(SRC, entry));
  return { files: [...seen].map((f) => relative(SRC, f)), problems };
}

for (const entry of ["pairing/index.ts", "app/index.ts", "relay/index.ts"])
  test(`${entry} reaches nothing the phone cannot load`, () => {
    const { files, problems } = reach(entry);
    expect(problems).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
  });

test("the walk follows what pairing uses, and would catch Node's crypto", () => {
  const { files } = reach("pairing/index.ts");
  for (const name of [
    "pairing/srp.ts",
    "pairing/security2.ts",
    "pairing/setup-session.ts",
    "bytes.ts",
  ])
    expect(files).toContain(name);
  expect(files.filter((n) => !n.startsWith("pairing/"))).toEqual(["bytes.ts"]);
  // The modules pairing must not import do reach node:crypto, so the check is not empty.
  expect(reach("crypto/ccm.ts").problems).toContain("crypto/blockCipher.ts imports node:crypto");
  expect(reach("usb/setup.ts").problems).toContain("crypto/sha256.ts imports node:crypto");
});
