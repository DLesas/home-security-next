/**
 * Pairing's vector files: the three from our rules are exactly what `pairing-vectors.ts` writes;
 * the four from ESP-IDF read with their formats and name ESP-IDF v6.1.1 and its commit. Each file's
 * cases are run against the code in the tests beside the code (code, srp, security2, setup-session).
 * The independent check is `verify/verify-pairing-vectors.mjs`.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { espIdfVectors, ESP_IDF_VECTOR_FILES } from "./esp-idf-vectors.ts";
import {
  PAIRING_RULE_VECTOR_FILES,
  PAIRING_VECTOR_DIRECTORY,
  pairingRuleVectorFiles,
} from "./pairing-vectors.ts";

const IDF = "ESP-IDF v6.1.1 (commit 051e4c4eb20346e043cdd47bc388fde75ff8af63)";

describe("pairing's vector files", () => {
  test("the rule files are exactly what the generator writes", () => {
    for (const [name, text] of pairingRuleVectorFiles())
      expect({ name, text: readFileSync(join(PAIRING_VECTOR_DIRECTORY, name), "utf8") }).toEqual({
        name,
        text,
      });
  });

  test("every pairing-*.json is one of ours, or §9's pairing data", () => {
    const ours = new Set<string>([
      ...Object.values(PAIRING_RULE_VECTOR_FILES),
      ...Object.values(ESP_IDF_VECTOR_FILES),
      "pairing-data.json",
    ]);
    const present = readdirSync(PAIRING_VECTOR_DIRECTORY).filter(
      (n) => n.startsWith("pairing-") && n.endsWith(".json"),
    );
    expect(present.sort()).toEqual([...ours].sort());
  });

  test("the ESP-IDF files read with their formats and say where they came from", () => {
    const files = espIdfVectors();
    for (const file of [files.srp, files.security2, files.script, files.counter]) {
      expect(file.source).toContain(IDF);
      expect(file.source).toContain(
        "protobuf-c 1.4.1 (commit abc67a11c6db271bedbb9f58be85d6f4e2ea8389)",
      );
      expect(file.source).toContain(
        "TF-PSA-Crypto (commit ce3f3485a121c100f58f36d700cb35b060f6e866)",
      );
      expect(file.source).toContain("esp-idf/make-vectors.sh");
    }
    // Every case names an SRP case that is there.
    const names = new Set(files.srp.cases.map((c) => c.name));
    for (const c of [...files.security2.cases, ...files.script.cases])
      expect(names.has(c.srpCase)).toBe(true);
    expect(names.has(files.counter.srpCase)).toBe(true);
  });

  test("the board's scripts: one whole pairing, a wrong code, and each refusal", () => {
    const { script } = espIdfVectors();
    expect(
      script.cases.map((c) => [c.name, c.steps.map((s) => (s.answer === null ? "x" : "."))]),
    ).toEqual([
      ["a whole pairing: proto-ver, the handshake, Identify, Provision", [".", ".", ".", ".", "."]],
      [
        "a wrong code: command 1 is refused; command 0 again on the same connection starts over, and the right code opens the session",
        [".", "x", ".", ".", "."],
      ],
      ["A = 0 (384 zero bytes): refused, RFC 5054 2.5.4", ["x"]],
      ["A = N: refused, A mod N is 0", ["x"]],
      ["A of 383 bytes: refused, security 2 takes exactly 384", ["x"]],
      ["an empty user name: refused", ["x"]],
      ["security version 1 in SessionData: refused", ["x"]],
      ["command 1 before command 0: refused", ["x"]],
      ["a client proof of 63 bytes: refused", [".", "x"]],
      ["a setup message before the session is open: refused", ["x"]],
      [
        "a sealed request with one bit changed: refused, the counter does not move, and the request intact is then accepted",
        [".", ".", "x", "."],
      ],
      [
        "a sealed request sent again after its answer: refused, its counter is past",
        [".", ".", ".", "x"],
      ],
      [
        "two sealed requests sent in the wrong order: the later one is refused, then both are accepted in order",
        [".", ".", "x", ".", "."],
      ],
    ]);
    // A wrong code is the only refusal that raises credentialsMismatch.
    const mismatches = script.cases.flatMap((c) =>
      c.steps.filter((s) => s.event === "credentialsMismatch"),
    );
    expect(mismatches).toHaveLength(1);
  });
});
