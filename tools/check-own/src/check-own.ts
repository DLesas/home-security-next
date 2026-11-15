/**
 * `bun run check:own <folder | owner> […]` (hub/README.md): the checks of `bun run check`,
 * failing only for the named folders, so five engineers can work in one checkout at once.
 *
 * - The type check runs on the whole project, as it must, and reports only errors inside the
 *   folders; the rest are counted as "not yours: N errors in <folders>".
 * - ESLint and Prettier run on the folders and the owner's test paths that exist (`owners.ts`), so
 *   an error in an owner's tests fails here as it fails the whole lint.
 * - The owner's own tests run on their own and are counted as such: every `*.test.ts` under the
 *   owner's test paths and folders (`owners.ts`), or under a folder named. None found is a
 *   failure, "0 of yours", never a pass, unless the owner says why it has none here.
 * - The lint probes, whose rules every owner relies on, run apart and are counted apart.
 *
 * It exits non-zero only when one of these fails for the owner's own folders.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { foldersOf, lintPathsOf, noTestsBecause, testPathsOf, TYPE_PROJECTS } from "./owners.ts";
import { normalizeFolder, parseTypeErrors, splitTypeErrors } from "./type-errors.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const BIN = join(REPO, "node_modules", ".bin");
const LINT_PROBE_TEST = "hub/test/unit/lint-probes.test.ts";

interface Ran {
  readonly ok: boolean;
  readonly output: string;
}

function run(command: readonly string[]): Ran {
  const result = Bun.spawnSync([...command], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: result.stdout.toString() + result.stderr.toString() };
}

/** Every `*.test.ts` at a path (a folder, or one test file), as a path from the repository's root. */
function testsUnder(path: string): readonly string[] {
  const full = join(REPO, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory())
    return path.endsWith(".test.ts") ? [normalizeFolder(path)] : [];
  return readdirSync(full, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".test.ts") && !name.split("/").includes("node_modules"))
    .map((name) => relative(REPO, join(full, name)));
}

/** Bun's counts from a test run's output. */
function testCounts(output: string): { pass: number; fail: number; skip: number } {
  const count = (word: string) =>
    Number(new RegExp(`^\\s*(\\d+) ${word}$`, "mu").exec(output)?.[1] ?? 0);
  return { pass: count("pass"), fail: count("fail"), skip: count("skip") };
}

/** Runs some test files; what ran, plainly. */
function runTests(files: readonly string[]): {
  readonly ok: boolean;
  readonly line: string;
  readonly output: string;
} {
  const test = run([process.execPath, "test", ...files.map((t) => `./${t}`)]);
  const { pass, fail, skip } = testCounts(test.output);
  const ok = test.ok && fail === 0 && pass + skip > 0;
  return {
    ok,
    line: `${pass} pass, ${fail} fail${skip > 0 ? `, ${skip} skip` : ""}, in ${files.length} files`,
    output: test.output,
  };
}

function report(stage: string, ok: boolean, details = ""): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${stage}${details === "" ? "" : `\n${details.trimEnd()}`}`);
  return ok;
}

function main(args: readonly string[]): number {
  const folders = args.flatMap(foldersOf).map(normalizeFolder);
  if (folders.length === 0) {
    console.log(
      "usage: bun run check:own <folder | A1…A11> […]   (paths from the repository's root, or an M2 owner)",
    );
    return 2;
  }
  const missing = folders.filter(
    (f) => !existsSync(join(REPO, f)) || !statSync(join(REPO, f)).isDirectory(),
  );
  if (missing.length > 0) {
    console.log(`not a folder: ${missing.join(", ")}`);
    return 2;
  }

  const results: boolean[] = [];

  // Every project `bun run typecheck` checks, the app's own included (its sources, tests, build
  // script and browser tests each have a tsconfig of their own).
  const tsc = TYPE_PROJECTS.map((project) =>
    run([join(BIN, "tsc"), "-p", project, "--pretty", "false"]),
  );
  const split = splitTypeErrors(parseTypeErrors(tsc.map((r) => r.output).join("\n")), folders);
  const notYours =
    split.others.length === 0
      ? ""
      : `not yours: ${split.others.length} errors in ${split.otherFolders.join(", ")}`;
  results.push(
    report(
      "type check",
      split.own.length === 0,
      [...split.own.map((e) => e.text), notYours].join("\n"),
    ),
  );

  // The owner's source folders and its test paths that exist. A folder may hold nothing ESLint
  // lints (A1's `packages/protocol/vectors`, JSON only): every path exists, so a pattern that
  // matches no lintable file means only that, and the files that are lintable are linted as ever.
  const checked = lintPathsOf(args).map(normalizeFolder);
  const lint = run([
    "bun",
    "--bun",
    join(BIN, "eslint"),
    "--max-warnings",
    "0",
    "--no-error-on-unmatched-pattern",
    ...checked,
  ]);
  results.push(report("lint", lint.ok, lint.ok ? "" : lint.output));

  const format = run([join(BIN, "prettier"), "--check", ...checked]);
  results.push(report("format", format.ok, format.ok ? "" : format.output));

  const testPaths = [...new Set(args.flatMap(testPathsOf).map(normalizeFolder))];
  const unwritten = testPaths.filter((p) => !existsSync(join(REPO, p)));
  const reasons = args.flatMap((a) => noTestsBecause(a) ?? []);
  const own = [...new Set(testPaths.flatMap(testsUnder))].filter((t) => t !== LINT_PROBE_TEST);
  const notYet = unwritten.length === 0 ? "" : `not written yet: ${unwritten.join(", ")}`;
  if (own.length === 0) {
    const none = reasons.length > 0 && args.every((a) => noTestsBecause(a) !== undefined);
    results.push(
      report(
        none ? "your tests: none here" : "your tests: 0 of yours ran: no test file found",
        none,
        [none ? reasons.join("\n") : `looked in: ${testPaths.join(", ")}`, notYet].join("\n"),
      ),
    );
  } else {
    const mine = runTests(own);
    results.push(
      report(
        `your tests: ${mine.line}`,
        mine.ok,
        [
          mine.ok ? "" : mine.output,
          `from: ${testPaths.filter((p) => !unwritten.includes(p)).join(", ")}`,
          notYet,
        ]
          .filter((l) => l !== "")
          .join("\n"),
      ),
    );
  }

  const probes = runTests([LINT_PROBE_TEST]);
  results.push(
    report(
      `lint probes (not your tests): ${probes.line}`,
      probes.ok,
      probes.ok ? "" : probes.output,
    ),
  );

  return results.every(Boolean) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
