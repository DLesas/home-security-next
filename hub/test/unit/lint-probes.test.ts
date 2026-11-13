/**
 * The layer rules hold (hub-design.md sections 1 and 10): ESLint, with the repository's own
 * configuration, runs over every file in hub/test/lint-probes/, which the ordinary lint ignores.
 * Each probe's second line says what it must give: `// Expect: <rule> "<message part>"`, and then
 * every problem in it is that rule with that message, and there is at least one; or
 * `// Expect: clean`, a file the rules must allow. The probes' folders mirror hub/'s, so each
 * one sits under the globs of the layer it tests.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ESLint } from "eslint";
import { z } from "zod";

const REPO = join(import.meta.dir, "..", "..", "..");
const PROBES = join(REPO, "hub", "test", "lint-probes");
/** Typed linting of about ninety files takes a few seconds. */
const LINT_TIMEOUT_MS = 120_000;

const expectation = z.union([
  z.object({ clean: z.literal(true) }),
  z.object({ rule: z.string(), message: z.string() }),
]);
type Expectation = z.infer<typeof expectation>;

function readExpectation(file: string): Expectation | undefined {
  const line = readFileSync(file, "utf8").split("\n")[1] ?? "";
  if (line === "// Expect: clean") return { clean: true };
  const match = /^\/\/ Expect: (\S+) (".*")$/.exec(line);
  if (match === null) return undefined;
  const message: unknown = JSON.parse(match[2] ?? '""');
  const parsed = expectation.safeParse({ rule: match[1], message });
  return parsed.success ? parsed.data : undefined;
}

const probeFiles = readdirSync(PROBES, { recursive: true, encoding: "utf8" })
  .filter((name) => name.endsWith(".ts"))
  .map((name) => join(PROBES, name))
  .sort();

describe("lint probes", () => {
  const results = new Map<string, ESLint.LintResult>();

  beforeAll(async () => {
    const eslint = new ESLint({ cwd: REPO, ignore: false });
    for (const result of await eslint.lintFiles(probeFiles)) results.set(result.filePath, result);
  }, LINT_TIMEOUT_MS);

  test("there is a probe for each restriction, and each says what it expects", () => {
    expect(probeFiles.length).toBeGreaterThan(80);
    const unreadable = probeFiles.filter((file) => readExpectation(file) === undefined);
    expect(unreadable.map((file) => relative(PROBES, file))).toEqual([]);
  });

  test.each(probeFiles.map((file) => [relative(PROBES, file), file] as const))("%s", (_, file) => {
    const expected = readExpectation(file);
    const problems = (results.get(file)?.messages ?? []).map((m) => ({
      rule: m.ruleId,
      message: m.message,
    }));
    expect(results.has(file)).toBe(true);
    if (expected === undefined || "clean" in expected) {
      expect(problems).toEqual([]);
      return;
    }
    expect(problems.length).toBeGreaterThan(0);
    for (const problem of problems) {
      expect(problem.rule).toBe(expected.rule);
      expect(problem.message).toContain(expected.message);
    }
  });
});
