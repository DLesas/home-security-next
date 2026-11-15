/**
 * `@hsn/protocol/messages` (m2-design.md section 7): the message decoders for a browser. Its
 * import graph, followed file by file from the entry, holds no `node:` module and no crypto, and
 * it decodes a packet body as the main entry does.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as full from "../src/index.ts";
import * as messages from "../src/messages-entry.ts";

const ENTRY = join(import.meta.dir, "..", "src", "messages-entry.ts");

/** Every module the entry reaches, by its imports' text, and every bare specifier among them. */
function graph(entry: string): {
  readonly files: readonly string[];
  readonly bare: readonly string[];
} {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gu)) {
      const spec = m[1] ?? "";
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec));
      else bare.add(spec);
    }
  };
  visit(entry);
  return { files: [...files], bare: [...bare] };
}

describe("@hsn/protocol/messages", () => {
  test("its import graph holds no node: module and no crypto", () => {
    const { files, bare } = graph(ENTRY);
    expect(files.length).toBeGreaterThan(5);
    expect(bare).toEqual([]);
    expect(files.filter((f) => f.includes("/crypto/"))).toEqual([]);
  });

  test("it decodes a body as the main entry does", () => {
    // The heartbeat vector's plaintext: type 1, door closed, 3.70 V, 21 °C.
    const body = messages.fromHex("0103007815000000");
    const decoded = messages.decodeMessage(body);
    expect(decoded.ok).toBe(true);
    expect(decoded).toEqual(full.decodeMessage(body));
    expect(messages.toHex(new Uint8Array([1, 255]))).toBe("01ff");
  });
});
