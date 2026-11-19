/**
 * The development-only pieces are absent from a release build (m3-design.md section 9, "the
 * release bundle holds no bridge"): the source rule (`release-guard.ts`) on every file under
 * `app/src` as it stands, the rule itself at its edges, the marker the bundle check looks for, and
 * that nothing a release build could reach imports the bench's development pieces.
 * `app/e2e-native/release-check.ts` makes the release bundles and searches them; the report gives
 * its run.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_WIRE } from "../src/bridge/wire.ts";
import { guardProblems } from "../src/release-guard.ts";

const REPO = join(import.meta.dir, "..", "..", "..");

function sources(folder: string): string[] {
  return readdirSync(join(REPO, folder), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(name) && !name.includes("node_modules"))
    .map((name) => join(folder, name));
}

describe("the release guard", () => {
  test("every file under app/src keeps it today", () => {
    const files = sources("app/src");
    expect(files.length).toBeGreaterThan(20);
    const broken = files.flatMap((file) =>
      guardProblems(readFileSync(join(REPO, file), "utf8")).map(
        (p) => `${file}:${String(p.line)} ${p.why}`,
      ),
    );
    expect(broken).toEqual([]);
  });

  test("the app's configuration and plugins name no bench either", () => {
    const files = [...sources("app/plugins"), "app/app.config.ts", "app/metro.config.cjs"];
    for (const file of files) {
      expect(readFileSync(join(REPO, file), "utf8")).not.toContain("ble-bench");
    }
  });

  const BRIDGE = "../../../tools/ble-bench/src/bridge/client.ts";

  test("a comment that names the bench is not a mention", () => {
    expect(
      guardProblems(
        `// tools/ble-bench serves the boards\n/* see tools/ble-bench */\nconst a = "//";`,
      ),
    ).toEqual([]);
  });

  test("a require inside if (__DEV__) is allowed, with the address check beside it", () => {
    expect(
      guardProblems(`
        let central = blePlx();
        if (__DEV__ && process.env.EXPO_PUBLIC_HSN_BLE_BENCH !== undefined) {
          const { bridgeBleCentral } = require("${BRIDGE}");
          central = bridgeBleCentral(process.env.EXPO_PUBLIC_HSN_BLE_BENCH);
        }`),
    ).toEqual([]);
  });

  for (const [name, text] of [
    ["a static import", `import { bridgeBleCentral } from "${BRIDGE}";`],
    ["a side-effect import", `import "${BRIDGE}";`],
    ["a re-export", `export { bridgeBleCentral } from "${BRIDGE}";`],
    ["a dynamic import", `if (__DEV__) { void import("${BRIDGE}"); }`],
    ["a require at the top", `const bench = require("${BRIDGE}");`],
    ["a require under another condition", `if (bench) { require("${BRIDGE}"); }`],
    ["a require under a negated flag", `if (!__DEV__) { require("${BRIDGE}"); }`],
    ["a require in an else of the flag", `if (__DEV__) { a(); } else { require("${BRIDGE}"); }`],
    [
      "a require one block deeper, in a function",
      `if (__DEV__) { const f = () => { require("${BRIDGE}"); }; }`,
    ],
    ["a path in a string elsewhere", `const where = "${BRIDGE}";`],
    [
      "a require after a comment that closes the block",
      `if (__DEV__) { /* } */ } require("${BRIDGE}");`,
    ],
  ] as const) {
    test(`${name} is refused`, () => {
      expect(guardProblems(text)).toHaveLength(1);
    });
  }
});

describe("the bundle half's marker", () => {
  test("the wire's version is a literal in the files a bundle of the client must hold", () => {
    expect(BRIDGE_WIRE).toBe("hsn-ble-bench/1");
    const wire = readFileSync(join(REPO, "tools/ble-bench/src/bridge/wire.ts"), "utf8");
    expect(wire).toContain(`"${BRIDGE_WIRE}"`);
    const client = readFileSync(join(REPO, "tools/ble-bench/src/bridge/client.ts"), "utf8");
    expect(client).toMatch(/import \{[^}]*\bBRIDGE_WIRE\b[^}]*\} from "\.\/wire\.ts"/u);
    expect(client).toContain("v: BRIDGE_WIRE");
  });

  test("the client uses no runtime API a phone lacks: no node:, no Bun", () => {
    for (const file of [
      "bridge/client.ts",
      "bridge/wire.ts",
      "safe/socket.ts",
      "safe/json.ts",
      "outcome.ts",
    ]) {
      const text = readFileSync(join(REPO, "tools/ble-bench/src", file), "utf8");
      expect(text).not.toMatch(/from "node:|\bBun\./u);
      // Type-only imports are erased before a bundler sees them.
      for (const match of text.matchAll(/^import (?!type )[^;]*?from "(\.[^"]+)"/gmu)) {
        expect(["./wire.ts", "../outcome.ts", "../safe/socket.ts", "../safe/json.ts"]).toContain(
          match[1] ?? "",
        );
      }
    }
  });
});
