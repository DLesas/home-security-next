/**
 * `bun run check:own <folder> [<folder>…]` (hub/README.md): the checks of `bun run check`,
 * failing only for the named folders, so five engineers can work in one checkout at once.
 *
 * - The type check runs on the whole project, as it must, and reports only errors inside the
 *   folders; the rest are counted as "not yours: N errors in <folders>".
 * - ESLint and Prettier run on the folders only.
 * - The tests run are those under the folders, and the lint probes, whose rules every owner
 *   relies on.
 *
 * It exits non-zero only when one of these fails for the owner's own folders.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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

/** Every `*.test.ts` under a folder, as a path from the repository's root. */
function testsUnder(folder: string): readonly string[] {
  return readdirSync(join(REPO, folder), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".test.ts") && !name.split("/").includes("node_modules"))
    .map((name) => relative(REPO, join(REPO, folder, name)));
}

function report(stage: string, ok: boolean, details = ""): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${stage}${details === "" ? "" : `\n${details.trimEnd()}`}`);
  return ok;
}

function main(args: readonly string[]): number {
  const folders = args.map(normalizeFolder);
  if (folders.length === 0) {
    console.log(
      "usage: bun run check:own <folder> [<folder>…]   (paths from the repository's root)",
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

  const tsc = run([join(BIN, "tsc"), "-p", "tsconfig.json", "--pretty", "false"]);
  const split = splitTypeErrors(parseTypeErrors(tsc.output), folders);
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

  const lint = run(["bun", "--bun", join(BIN, "eslint"), "--max-warnings", "0", ...folders]);
  results.push(report("lint", lint.ok, lint.ok ? "" : lint.output));

  const format = run([join(BIN, "prettier"), "--check", ...folders]);
  results.push(report("format", format.ok, format.ok ? "" : format.output));

  const tests = [...new Set([...folders.flatMap(testsUnder), LINT_PROBE_TEST])].map(
    (t) => `./${t}`,
  );
  const test = run([process.execPath, "test", ...tests]);
  const summary = test.output
    .split("\n")
    .filter((line) => /^\s*\d+ (pass|fail)$|\(fail\)/.test(line));
  results.push(
    report(`tests (${tests.length} files)`, test.ok, test.ok ? summary.join("\n") : test.output),
  );

  return results.every(Boolean) ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
