/**
 * `bun run check:own` (hub/README.md): it fails for errors inside the named folders and only
 * counts those outside. The real script runs twice on two scratch folders under hub/test/, one
 * named and one not, each with a deliberate type error in turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  foldersOf,
  lintPathsOf,
  noTestsBecause,
  OWNERS,
  testPathsOf,
  TYPE_PROJECTS,
} from "../src/owners.ts";
import { normalizeFolder, parseTypeErrors, splitTypeErrors } from "../src/type-errors.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
/** A type check, a lint, a format check and two test runs, twice. */
const RUN_TIMEOUT_MS = 180_000;

describe("splitting the type check's errors", () => {
  const output = [
    "hub/src/core/alarm/handle.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "hub/src/core/sirens/state.ts(1,1): error TS2304: Cannot find name 'x'.",
    "  A continuation line belongs to the error above.",
    "hub/src/core/sirens/handle.ts(9,2): error TS2554: Expected 1 arguments, but got 0.",
    "hub/src/core/alarmist/state.ts(1,1): error TS2304: Cannot find name 'y'.",
  ].join("\n");
  const errors = parseTypeErrors(output);

  test("reads one error per diagnostic, with its continuation lines", () => {
    expect(errors.map((e) => e.file)).toEqual([
      "hub/src/core/alarm/handle.ts",
      "hub/src/core/sirens/state.ts",
      "hub/src/core/sirens/handle.ts",
      "hub/src/core/alarmist/state.ts",
    ]);
    expect(errors[1]?.text).toContain("A continuation line");
  });

  test("keeps the owner's, and counts the rest by folder; a folder's prefix is not inside it", () => {
    const split = splitTypeErrors(errors, [normalizeFolder("./hub/src/core/alarm/")]);
    expect(split.own.map((e) => e.file)).toEqual(["hub/src/core/alarm/handle.ts"]);
    expect(split.others).toHaveLength(3);
    expect(split.otherFolders).toEqual(["hub/src/core/alarmist", "hub/src/core/sirens"]);
  });
});

describe("the script", () => {
  const own = `hub/test/check-own-scratch-own-${process.pid}`;
  const other = `hub/test/check-own-scratch-other-${process.pid}`;
  /** A folder with nothing ESLint lints, as A1's `packages/protocol/vectors` is. */
  const data = `hub/test/check-own-scratch-data-${process.pid}`;
  const write = (folder: string, name: string, text: string) => {
    writeFileSync(join(REPO, folder, name), text);
  };
  const broken = 'export const wrong: number = "text";\n';

  beforeAll(() => {
    for (const folder of [own, other, data]) mkdirSync(join(REPO, folder), { recursive: true });
    write(data, "vectors.json", '{ "vectors": [] }\n');
    write(own, "clean.ts", "export const value = 1;\n");
    write(
      own,
      "clean.test.ts",
      'import { expect, test } from "bun:test";\nimport { value } from "./clean.ts";\n\n' +
        'test("passes", () => {\n  expect(value).toBe(1);\n});\n',
    );
    write(other, "broken.ts", broken);
  });

  afterAll(() => {
    for (const folder of [own, other, data])
      rmSync(join(REPO, folder), { recursive: true, force: true });
  });

  function checkOwn(...folders: string[]): { code: number; output: string } {
    const result = Bun.spawnSync(["bun", "run", "check:own", ...folders], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  }

  test(
    "passes when the only error is outside the named folder, and says whose it is",
    () => {
      const { code, output } = checkOwn(own);
      expect(output).toContain("ok   type check");
      // Errors elsewhere in the repository, if any, are counted with the scratch folder's.
      expect(output).toMatch(new RegExp(`not yours: \\d+ errors in [^\\n]*${other}`));
      expect(output).toContain("ok   your tests: 1 pass, 0 fail, in 1 files");
      expect(output).toMatch(/ok {3}lint probes \(not your tests\): \d+ pass, 0 fail, in 1 files/);
      expect(code).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "fails for an error inside the named folder, showing it",
    () => {
      write(own, "broken.ts", broken);
      const { code, output } = checkOwn(own);
      rmSync(join(REPO, own, "broken.ts"));
      expect(output).toContain("FAIL type check");
      expect(output).toContain(`${own}/broken.ts(1,14): error TS2322`);
      expect(output).toMatch(new RegExp(`not yours: \\d+ errors in [^\\n]*${other}`));
      expect(code).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "says 0 of yours, and fails, when no test of the named folder ran",
    () => {
      const { code, output } = checkOwn(other);
      expect(output).toContain("FAIL your tests: 0 of yours ran: no test file found");
      expect(output).toContain(`looked in: ${other}`);
      expect(code).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a folder with nothing to lint passes the lint step, and a lint error beside it still fails",
    () => {
      const clean = checkOwn(own, data);
      expect(clean.output).toContain("ok   lint");
      expect(clean.code).toBe(0);
      write(own, "unused.ts", "const unused = 1;\nexport {};\n");
      const dirty = checkOwn(own, data);
      rmSync(join(REPO, own, "unused.ts"));
      expect(dirty.output).toContain("FAIL lint");
      expect(dirty.output).toContain("no-unused-vars");
      expect(dirty.code).toBe(1);
    },
    2 * RUN_TIMEOUT_MS,
  );

  test("refuses a folder that does not exist", () => {
    const { code, output } = checkOwn("hub/src/core/nowhere");
    expect(output).toContain("not a folder: hub/src/core/nowhere");
    expect(code).toBe(2);
  });
});

describe("M2's owners (m2-design.md section 11)", () => {
  test("every owner's folder exists, with a README naming the owner; an owner names its folders", () => {
    const repo = REPO;
    for (const [owner, { folders }] of Object.entries(OWNERS)) {
      for (const folder of folders) {
        expect([folder, existsSync(join(repo, folder))]).toEqual([folder, true]);
        const readme = join(repo, folder, "README.md");
        const named =
          existsSync(readme) || existsSync(join(repo, folder.split("/")[0] ?? "", "README.md"));
        expect([folder, named]).toEqual([folder, true]);
        if (existsSync(readme)) expect(readFileSync(readme, "utf8")).toContain(owner);
      }
    }
    expect(foldersOf("a3")).toEqual(["hub/src/core/people", "hub/src/core/app"]);
    expect(foldersOf("hub/src/core/alarm")).toEqual(["hub/src/core/alarm"]);
  });

  test("every owner names at least one place for its tests, or says why it has none", () => {
    for (const [owner, { tests, noTestsBecause: why }] of Object.entries(OWNERS)) {
      expect([owner, tests.length > 0 || (why !== undefined && why !== "")]).toEqual([owner, true]);
      // A test path is a folder, or a test file.
      for (const path of tests) {
        const file = path.split("/").at(-1) ?? "";
        expect([path, !file.includes(".") || file.endsWith(".test.ts")]).toEqual([path, true]);
      }
    }
    expect(testPathsOf("A6")).toEqual([
      "hub/test/unit/health",
      "hub/test/unit/notify",
      "hub/src/core/health",
      "hub/src/core/notify",
    ]);
    expect(testPathsOf("hub/src/core/alarm")).toEqual(["hub/src/core/alarm"]);
    expect(noTestsBecause("A10")).toContain("check:firmware");
  });

  test("the type check covers every project `bun run typecheck` does, the app's included", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const projects = [...(pkg.scripts.typecheck ?? "").matchAll(/tsc -p (\S+)/gu)].map((m) => m[1]);
    expect(projects).toEqual([...TYPE_PROJECTS]);
  });

  test("an owner's lint and format steps take its test paths that exist, as well as its folders", () => {
    const paths = lintPathsOf(["A6"]);
    expect(paths).toEqual([
      "hub/src/core/health",
      "hub/src/core/notify",
      "hub/test/unit/health",
      "hub/test/unit/notify",
    ]);
    // A path not written yet is left out; a folder named alone is itself.
    const a5 = lintPathsOf(["A5"]);
    for (const path of OWNERS.A5?.tests ?? [])
      expect([path, a5.includes(path)]).toEqual([path, existsSync(join(REPO, path))]);
    expect(lintPathsOf(["hub/src/core/alarm"])).toEqual(["hub/src/core/alarm"]);
  });

  test(
    "a lint error in an owner's test folder fails its check",
    () => {
      const scratch = join(REPO, "hub/test/unit/notify", `check-own-scratch-${process.pid}.ts`);
      writeFileSync(scratch, "const unused = 1;\nexport {};\n");
      const result = Bun.spawnSync(["bun", "run", "check:own", "A6"], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      });
      rmSync(scratch, { force: true });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain("FAIL lint");
      expect(output).toContain(`check-own-scratch-${process.pid}.ts`);
      expect(result.exitCode).toBe(1);
    },
    RUN_TIMEOUT_MS,
  );
});
