/**
 * Wave 0's pure parts (`src/dev/wave0-parts.ts`; docs/spikes/P0-phone-build.md): the route list is
 * every route there is, the arithmetic timed for SRP is right, and the walk and socket settings
 * read as the spike report says.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { bigOfBits, modPow, ROUTES, routesToWalk, socketRequest } from "../src/dev/wave0-parts";

/** The routes `src/app/` defines, as paths: `index` is `/`, a `[param]` takes the value 1. */
function routesOnDisk(): readonly string[] {
  const app = join(import.meta.dir, "..", "src", "app");
  return readdirSync(app, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx") && !file.split("/").some((p) => p.startsWith("_")))
    .map(
      (file) =>
        `/${file
          .replace(/\.tsx$/u, "")
          .replace(/(^|\/)index$/u, "")
          .replace(/\[[^\]]+\]/gu, "1")}`,
    );
}

describe("wave 0's parts", () => {
  test("the walk names every route, once", () => {
    expect([...ROUTES].sort() as string[]).toEqual([...routesOnDisk()].sort());
    expect(new Set(ROUTES).size).toBe(ROUTES.length);
  });

  test("modPow is modular exponentiation, at its edges too", () => {
    const m = 1_000_003n;
    expect(modPow(3n, 200n, m)).toBe(3n ** 200n % m);
    expect(modPow(5n, 0n, m)).toBe(1n);
    expect(modPow(m + 2n, 1n, m)).toBe(2n);
    expect(modPow(0n, 7n, m)).toBe(0n);
    const big = (1n << 3071n) + 12_345n;
    expect(modPow(2n, 64n, big)).toBe(2n ** 64n);
  });

  test("bigOfBits takes exactly its bytes, and is odd", () => {
    let asked = 0;
    const value = bigOfBits(3072, (bytes) => {
      asked = bytes.length;
      bytes.fill(0xff);
    });
    expect(asked).toBe(384);
    expect(value).toBe((1n << 3072n) - 1n);
    expect(bigOfBits(16, (bytes) => bytes.fill(0))).toBe(1n);
  });

  test("the walk: none, all, or the routes listed", () => {
    expect(routesToWalk("open")).toEqual([]);
    expect(routesToWalk("all")).toEqual(ROUTES);
    expect(routesToWalk("/,/devices,settings,")).toEqual(["/", "/devices"]);
  });

  test("a socket check sends the hub's Origin, and its Host when told one", () => {
    expect(socketRequest("wss://192.168.1.20:8444/app/link")).toEqual({
      url: "wss://192.168.1.20:8444/app/link",
      headers: { Origin: "https://192.168.1.20:8444" },
    });
    expect(socketRequest("wss://127.0.0.1:8444/app/link@192.168.1.20:8444")).toEqual({
      url: "wss://127.0.0.1:8444/app/link",
      headers: { Origin: "https://192.168.1.20:8444", Host: "192.168.1.20:8444" },
    });
  });
});
