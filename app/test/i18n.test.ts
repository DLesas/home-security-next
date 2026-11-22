/**
 * Every text is a key, and every key has English text (m2-design.md section 10, "The app"): each
 * key the app's code names (`t("…")` and the screens' `titleKey`s) is in `locales/en/`, and the
 * lint rule `hsn/no-literal-text` keeps text out of the components.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const english = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "locales", "en", "common.json"), "utf8"),
) as Record<string, unknown>;

function has(path: string): boolean {
  let at: unknown = english;
  for (const part of path.split(".")) {
    if (typeof at !== "object" || at === null || !(part in at)) return false;
    at = (at as Record<string, unknown>)[part];
  }
  return typeof at === "string" && at !== "";
}

function keysUsed(): readonly string[] {
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.tsx?$/u.test(f),
  );
  return files.flatMap((file) => {
    const text = readFileSync(join(SRC, file), "utf8");
    return [...text.matchAll(/\bt\("([^"]+)"\)|titleKey="([^"]+)"/gu)].map(
      (m) => m[1] ?? m[2] ?? "",
    );
  });
}

describe("translation (HB27, D58)", () => {
  test("every key the code names has its English text", () => {
    const used = keysUsed();
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !has(key))).toEqual([]);
  });
});

/** Lists all leaf keys so every locale covers both the app and closed-app notifications. */
function leaves(node: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(node)
    .flatMap(([key, value]) => {
      const path = prefix + key;
      return typeof value === "object" && value !== null
        ? leaves(value as Record<string, unknown>, path + ".")
        : [path];
    })
    .sort();
}

test("each locale has all common and push keys and its push references resolve", () => {
  const root = join(import.meta.dir, "..", "locales");
  for (const file of ["common.json", "push.json"]) {
    const expected = leaves(JSON.parse(readFileSync(join(root, "en", file), "utf8")));
    for (const locale of readdirSync(root)) {
      const text = readFileSync(join(root, locale, file), "utf8");
      expect(leaves(JSON.parse(text))).toEqual(expected);
      if (file === "push.json") {
        const common = leaves(JSON.parse(readFileSync(join(root, locale, "common.json"), "utf8")));
        for (const [, key] of text.matchAll(/"\$t\(([^)]+)\)"/gu)) expect(common).toContain(key);
      }
    }
  }
});
