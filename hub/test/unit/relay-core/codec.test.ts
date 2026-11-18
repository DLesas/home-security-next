/**
 * The content's size as the size rule measures it: its JSON in UTF-8 (docs/m4-design.md section
 * 5). The key id and key are read with the protocol's own `parsePushKeyId` and `parsePushKey`.
 */
import { describe, expect, test } from "bun:test";
import { jsonBytes } from "../../../src/core/relay/codec.ts";

describe("the content's size", () => {
  test("UTF-8 bytes of the JSON, not characters", () => {
    expect(jsonBytes({ a: "é" })).toBe(10);
    expect(jsonBytes({ a: "\u{1F6AA}" })).toBe(12);
  });
});
