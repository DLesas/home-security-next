/**
 * The web build's files (m2-design.md sections 5 and 8): exactly the regular files under the web
 * root, listed once by a walk that never leaves it nor follows a link. Every file the real build
 * produces is served, Expo's bracketed route chunk (`[id]-<hash>.js`) among them; and nothing else:
 * no `..`, no absolute path inside the path, no encoded separator, no NUL, no link out of the root,
 * no file added after the listing.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { decodedPath, StaticFiles } from "../../../src/shell/app/static-files.ts";
import { expectNoKeyLeaks } from "../setup/support/leak-guard.ts";
import { openHub, rawRequest, stopHubs } from "./support.ts";

const folders: string[] = [];
afterEach(() => {
  stopHubs();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
afterAll(() => {
  expectNoKeyLeaks();
});

/** A build with a bracketed chunk, a dotted folder, a link out and a link in. */
function build(): { readonly root: string; readonly outside: string } {
  const base = mkdtempSync(join(tmpdir(), "hsn-a2-files-"));
  folders.push(base);
  const root = join(base, "web");
  const js = join(root, "_expo", "static", "js", "web");
  mkdirSync(js, { recursive: true });
  mkdirSync(join(root, "assets", "_node_modules", ".bun"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<title>hsn</title>");
  writeFileSync(join(js, "[id]-7a85bcd7.js"), "device page");
  writeFileSync(join(js, "entry-1.js"), "entry");
  writeFileSync(join(root, "assets", "_node_modules", ".bun", "a@1+b.png"), "png");
  const outside = join(base, "secret.js");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(js, "out.js"));
  symlinkSync(join(base), join(root, "up"));
  symlinkSync(join(js, "entry-1.js"), join(js, "alias.js"));
  return { root, outside };
}

const get = (port: number, path: string) =>
  rawRequest(
    port,
    false,
    [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: close"],
    "127.0.0.1",
    true,
  );

describe("what is served", () => {
  test("the bracketed route chunk, plainly and percent-encoded, over a real listener", async () => {
    const { root } = build();
    const side = openHub({ webRoot: root });
    for (const path of [
      "/_expo/static/js/web/[id]-7a85bcd7.js",
      "/_expo/static/js/web/%5Bid%5D-7a85bcd7.js",
    ]) {
      const answer = await get(side.consolePort, path);
      expect(answer.status).toBe(200);
      expect(answer.text).toContain("device page");
    }
    expect((await get(side.consolePort, "/assets/_node_modules/.bun/a@1+b.png")).status).toBe(200);
  });

  test("only the regular files under the root: links in or out are not", () => {
    const { root } = build();
    const files = new StaticFiles(root);
    expect(files.count).toBe(4);
    expect(files.find("/_expo/static/js/web/out.js")).toBeUndefined();
    expect(files.find("/_expo/static/js/web/alias.js")).toBeUndefined();
    expect(files.find("/up/secret.js")).toBeUndefined();
  });

  test("the refusals: .., an absolute path, an encoded separator, a NUL, a malformed escape", () => {
    const { root } = build();
    const files = new StaticFiles(root);
    for (const path of [
      "/../secret.js",
      "/_expo/../../secret.js",
      "/_expo/static/js/web/%2e%2e/%2e%2e/%2e%2e/%2e%2e/secret.js",
      "//etc/passwd",
      "/_expo//static/js/web/entry-1.js",
      "/_expo%2Fstatic%2Fjs%2Fweb%2Fentry-1.js",
      "/_expo%5cstatic/js/web/entry-1.js",
      "/index.html%00.js",
      "/index.html\0.js",
      "/%zz.js",
      "/%ff.js",
      "relative.js",
    ]) {
      expect(files.find(path)).toBeUndefined();
    }
    expect(decodedPath("/%5Bid%5D")).toBe("/[id]");
    expect(files.find("/_expo/static/js/web/entry-1.js")?.type).toContain("javascript");
  });

  test("a file put in the folder after the listing is not served", () => {
    const { root } = build();
    const files = new StaticFiles(root);
    writeFileSync(join(root, "later.js"), "later");
    expect(files.find("/later.js")).toBeUndefined();
  });
});

const DIST = join(import.meta.dir, "..", "..", "..", "..", "app", "dist");

describe("the real web build", () => {
  test.skipIf(!existsSync(join(DIST, "index.html")))(
    "every file app/dist holds is served, byte for byte where small",
    async () => {
      const listed = readdirSync(DIST, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => `/${relative(DIST, join(d.parentPath, d.name)).split("\\").join("/")}`);
      expect(listed.length).toBeGreaterThan(5);
      expect(listed.some((p) => p.includes("["))).toBe(true);
      const side = openHub({ webRoot: DIST });
      const refused: string[] = [];
      for (const path of listed) {
        const answer = await rawRequest(side.consolePort, false, [
          `HEAD ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${side.consolePort}`,
          "Connection: close",
        ]);
        if (answer.status !== 200) refused.push(`${path}: ${answer.status}`);
      }
      expect(refused).toEqual([]);
    },
  );
});
