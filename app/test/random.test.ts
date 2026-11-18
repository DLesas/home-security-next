/**
 * The random source (`src/platform/random*.ts`; m3-design.md section 2): a phone without the
 * engine's `crypto.getRandomValues` is given expo-crypto's, a browser's own is never replaced,
 * and the entry installs it before anything else loads.
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FillRandom,
  installRandomOn,
  type RandomScope,
  type RandomStart,
} from "../src/platform/random-types";
import * as web from "../src/platform/random.web";

/** A fill that records what it filled and fills with the platform's real bytes. */
function recordingFill() {
  const filled: unknown[] = [];
  const fill: FillRandom = (array) => {
    filled.push(array);
    return crypto.getRandomValues(array);
  };
  return { fill, filled };
}

/** The installed `getRandomValues` on `scope`, as a caller such as `@noble/hashes` reaches it. */
function installed(scope: RandomScope): FillRandom {
  const found = scope.crypto?.getRandomValues;
  if (typeof found !== "function") return () => expect.unreachable("no getRandomValues");
  return found as FillRandom;
}

describe("installing a random source", () => {
  test("no `crypto` at all (Hermes): a `crypto` with the platform's `getRandomValues`", () => {
    const scope: RandomScope = {};
    const { fill, filled } = recordingFill();
    expect(installRandomOn(scope, fill)).toBe("platform");
    const bytes = installed(scope)(new Uint8Array(32));
    expect(filled).toEqual([bytes]);
    expect(bytes.some((b) => b !== 0)).toBe(true);
  });

  test("a `crypto` without `getRandomValues`: added to it, its other members kept", () => {
    const other = () => "kept";
    const scope: RandomScope = { crypto: { getRandomValues: undefined } };
    Object.assign(scope.crypto ?? {}, { randomUUID: other });
    const { fill } = recordingFill();
    expect(installRandomOn(scope, fill)).toBe("platform");
    expect(installed(scope)).toBe(fill);
    expect((scope.crypto as { randomUUID?: unknown }).randomUUID).toBe(other);
  });

  test("a `getRandomValues` that is not a function is replaced", () => {
    const scope: RandomScope = { crypto: { getRandomValues: "not a function" } };
    const { fill } = recordingFill();
    expect(installRandomOn(scope, fill)).toBe("platform");
    expect(installed(scope)).toBe(fill);
  });

  test("the engine's own is never replaced", () => {
    const own: FillRandom = (array) => array;
    const scope: RandomScope = { crypto: { getRandomValues: own } };
    const { fill, filled } = recordingFill();
    expect(installRandomOn(scope, fill)).toBe("engine");
    expect(installed(scope)).toBe(own);
    expect(filled).toEqual([]);
  });
});

describe("each platform's source", () => {
  test("the web keeps the browser's, and says when a browser has none", () => {
    const own: FillRandom = (array) => array;
    const browser: RandomScope = { crypto: { getRandomValues: own } };
    expect(web.installRandom(browser)).toBe("engine");
    expect(installed(browser)).toBe(own);
    const bare: RandomScope = {};
    expect(web.installRandom(bare)).toBe("missing");
    expect(bare.crypto).toBeUndefined();
    // Bun, like a browser, has its own.
    expect(web.installRandom()).toBe("engine");
  });

  test("the phone puts expo-crypto's `getRandomValues` in place", async () => {
    const { fill, filled } = recordingFill();
    // expo-crypto's native module exists only in the app: its function is stood in for here.
    void mock.module("expo-crypto", () => ({ getRandomValues: fill }));
    // Loaded by a computed path, so this program does not take expo-crypto's types, which bring
    // Expo's widening of `process.env` (docs/spikes/P0-phone-build.md, "Found on the way").
    const path = ["..", "src", "platform", "random.native"].join("/");
    const phone = (await import(path)) as RandomStart;
    const hermes: RandomScope = {};
    expect(phone.installRandom(hermes)).toBe("platform");
    expect(installed(hermes)).toBe(fill);
    const bytes = installed(hermes)(new Uint32Array(4));
    expect(filled).toEqual([bytes]);
    // A later engine with its own keeps it.
    const own: FillRandom = (array) => array;
    expect(phone.installRandom({ crypto: { getRandomValues: own } })).toBe("engine");
  });

  test("the entry installs the source before the start file or the router loads", () => {
    const entry = readFileSync(join(import.meta.dir, "..", "src", "entry.ts"), "utf8");
    const imports = [...entry.matchAll(/^import "([^"]+)";$/gmu)].map((m) => m[1]);
    expect(imports).toEqual(["./platform/random-start", "./hub/start", "expo-router/entry"]);
    const start = readFileSync(
      join(import.meta.dir, "..", "src", "platform", "random-start.ts"),
      "utf8",
    );
    expect(start).toMatch(/^installRandom\(\);$/mu);
  });
});
