/**
 * `bun run check:own` (hub/README.md): it fails for errors inside the named folders and only
 * counts those outside. The real script runs twice on two scratch folders under hub/test/, one
 * named and one not, each with a deliberate type error in turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  expandPath,
  firmwareOf,
  foldersOf,
  lintPathsOf,
  noTestsBecause,
  ownerPathsOf,
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

/** M2's owners, A1 to A11, whose folders all exist. */
const M2_OWNERS = Object.entries(OWNERS).filter(([owner]) => /^A\d+$/u.test(owner));

describe("M2's owners (m2-design.md section 11)", () => {
  test("every owner's folder exists, with a README naming the owner; an owner names its folders", () => {
    const repo = REPO;
    expect(M2_OWNERS.map(([owner]) => owner)).toEqual([
      "A1",
      "A2",
      "A3",
      "A4",
      "A5",
      "A6",
      "A7",
      "A8",
      "A9",
      "A10",
      "A11",
    ]);
    for (const [owner, { folders }] of M2_OWNERS) {
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

describe("the joint M3 and M4 work's owners (docs/m3-m4-plan.md, step 1)", () => {
  const NEW_OWNERS = [
    // m4-design.md section 12, B4 for the names work.
    "B1",
    "B2",
    "B3",
    "B5",
    "B6",
    "B7",
    "B4",
    // m3-updates-design.md section 10, K1 merged into U8.
    "U1",
    "U2",
    "U3",
    "U4",
    "U5",
    "U6",
    "U7",
    "U8",
    "U9",
    "U10",
    "K2",
    // m3-design.md section 10.
    "P1",
    "P2",
    "P3",
    "P4",
    "P5",
    "P6",
    "H1",
    "F1",
  ];

  test("are all here, after M2's, and K1 is not an owner of its own", () => {
    expect(Object.keys(OWNERS)).toEqual([...M2_OWNERS.map(([owner]) => owner), ...NEW_OWNERS]);
    expect(Object.hasOwn(OWNERS, "K1")).toBe(false);
  });

  test("each names its folders as its design does", () => {
    expect(foldersOf("B1")).toEqual([
      "packages/protocol/src/relay",
      "packages/protocol/src/app/noise.ts",
      "packages/protocol/vectors/relay-*.json",
    ]);
    expect(foldersOf("B2")).toEqual([
      "relay/src/core",
      "relay/src/shell",
      "relay/src/releases",
      "relay/test",
    ]);
    expect(foldersOf("B3")).toEqual(["relay/src/push", "tools/push-standins"]);
    // B3's tests are in B2's folder, under `relay/test/push`, and run as B3's.
    expect(testPathsOf("B3")).toEqual([
      "relay/src/push",
      "relay/test/push",
      "tools/push-standins/test",
      "tools/push-standins",
    ]);
    expect(foldersOf("B4")).toEqual([
      "relay/src/names",
      "hub/src/shell/names",
      "tools/dns-standin",
    ]);
    expect(foldersOf("B5")).toEqual(["hub/src/core/relay"]);
    expect(testPathsOf("B5")).toEqual(["hub/test/unit/relay-core", "hub/src/core/relay"]);
    expect(foldersOf("B6")).toEqual(["hub/src/shell/relay", "hub/src/shell/app"]);
    expect(foldersOf("B7")).toContain("hub/test/relay");
    expect(foldersOf("U7")).toEqual(["hub/src/core/firmware"]);
    // U8's update parts and K1's key change, together.
    expect(foldersOf("U8")).toEqual([
      "hub/src/core/sensors",
      "hub/src/core/sirens",
      "hub/src/core/gateways",
      "hub/src/core/intake",
      "hub/src/core/links",
      "hub/src/core/app",
      "hub/src/shell/cipher",
      "hub/src/shell/storage/keys.ts",
      "hub/src/shell/backup/restore.ts",
    ]);
    expect(foldersOf("U9")).toEqual(["hub/src/shell/firmware", "hub/cli"]);
    expect(foldersOf("U10")).toEqual(["hub/test/budget", "hub/test/crash"]);
    expect(foldersOf("P1")).toEqual(["app/modules/hub-net", "app/modules/push"]);
    expect(foldersOf("P2")).toContain("app/src/platform/*.native.ts");
    expect(foldersOf("P2")).toContain("app/plugins");
    expect(foldersOf("P3")).toEqual([
      "packages/protocol/src/pairing",
      "packages/protocol/vectors/pairing-*.json",
    ]);
    expect(foldersOf("P4")).toEqual(["app/src/pairing", "app/src/ble-update"]);
    expect(foldersOf("P5")).toEqual(["app/src/app", "app/src/ui", "app/locales/en"]);
    expect(foldersOf("P6")).toEqual(["tools/ble-bench", "app/e2e-native"]);
    expect(foldersOf("H1")).toEqual([
      "hub/src/core/setup",
      "hub/src/core/registry",
      "hub/src/core/app",
      "hub/src/shell/advertise",
    ]);
  });

  test("an owner's paths under firmware/ are named apart, for check:firmware", () => {
    for (const owner of ["U1", "U2", "U3", "U4", "U5", "U6", "K2", "F1"]) {
      expect([owner, foldersOf(owner)]).toEqual([owner, []]);
      expect([owner, noTestsBecause(owner)?.includes("check:firmware")]).toEqual([owner, true]);
    }
    expect(firmwareOf("U1")).toEqual([
      "firmware/core/src/device/update*",
      "firmware/core/include/hsn/device/services/update*",
      "firmware/tests/device/update*",
    ]);
    expect(firmwareOf("U4")).toEqual(["firmware/roles/sensor", "firmware/tests/roles/sensor"]);
    expect(firmwareOf("K2")).toContain("firmware/core/src/device/secure_channel*");
    expect(firmwareOf("F1")).toContain("firmware/platform/esp-idf/bluetooth");
    expect(firmwareOf("U10")).toContain("firmware/tests/system_roles/restore_rekey_test.cpp");
    expect(firmwareOf("A3")).toEqual([]);
    expect(firmwareOf("hub/src/core/alarm")).toEqual([]);
    for (const [owner, { folders, firmware = [] }] of Object.entries(OWNERS)) {
      for (const path of firmware)
        expect([owner, path.startsWith("firmware/")]).toEqual([owner, true]);
      for (const path of folders)
        expect([owner, path.startsWith("firmware/")]).toEqual([owner, false]);
    }
  });

  test("every path is from the repository's root, with a pattern's `*` in its last part only", () => {
    for (const [owner, { folders, tests, firmware = [] }] of Object.entries(OWNERS)) {
      for (const path of [...folders, ...tests, ...firmware]) {
        expect([owner, path, normalizeFolder(path) === path && !path.startsWith("/")]).toEqual([
          owner,
          path,
          true,
        ]);
        expect([owner, path, path.split("/").slice(0, -1).join("/").includes("*")]).toEqual([
          owner,
          path,
          false,
        ]);
      }
    }
  });
});

describe("folders not created yet, files and patterns", () => {
  test("a path is itself when it is there, a pattern each entry it matches, else nothing", () => {
    expect(expandPath("hub/src/core/alarm")).toEqual(["hub/src/core/alarm"]);
    expect(expandPath("hub/src/core/step.ts")).toEqual(["hub/src/core/step.ts"]);
    expect(expandPath("hub/src/core/nowhere")).toEqual([]);
    expect(expandPath("packages/protocol/vectors/app-noise*.json")).toEqual([
      "packages/protocol/vectors/app-noise-failures.json",
      "packages/protocol/vectors/app-noise.json",
    ]);
    // A `.` in a pattern is a dot, not any character.
    expect(expandPath("hub/src/core/step*ts")).toEqual(["hub/src/core/step.ts"]);
    expect(expandPath("hub/src/core/step*xts")).toEqual([]);
    expect(expandPath("packages/protocol/vectors/no-such-*.json")).toEqual([]);
    expect(expandPath("hub/src/nowhere/*.ts")).toEqual([]);
  });

  test("an owner's paths split into those there now and those not created yet", () => {
    const b2 = ownerPathsOf(["B2"]);
    for (const path of OWNERS.B2?.folders ?? []) {
      const there = existsSync(join(REPO, path));
      expect([path, b2.present.includes(path), b2.notYet.includes(path)]).toEqual([
        path,
        there,
        !there,
      ]);
    }
    // A pattern counts as there when it matches; its matches are what is checked.
    const p2 = ownerPathsOf(["P2"]);
    const native = expandPath("app/src/platform/*.native.ts");
    expect(native.length).toBeGreaterThan(0);
    for (const file of native) expect(p2.present).toContain(file);
    expect(p2.notYet).not.toContain("app/src/platform/*.native.ts");
    expect(lintPathsOf(["P2"])).toContain("app/src/platform/*.native.ts");
    // A folder named alone is the caller's to check, and owners are named in either case.
    expect(ownerPathsOf(["hub/src/core/nowhere"])).toEqual({ present: [], notYet: [] });
    expect(ownerPathsOf(["b5"]).present).toEqual(["hub/src/core/relay"]);
  });

  test(
    "an owner's folder not created yet is named and skipped, and never refused",
    () => {
      const { notYet } = ownerPathsOf(["B4"]);
      const result = Bun.spawnSync(["bun", "run", "check:own", "B4"], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain("not a folder");
      if (notYet.length > 0)
        expect(output).toContain(`not created yet, so not checked: ${notYet.join(", ")}`);
      // Nothing there means nothing to lint, not the whole repository.
      if (notYet.length === OWNERS.B4?.folders.length) {
        expect(output).toContain("ok   lint: nothing of yours there yet");
        expect(output).toContain("ok   format: nothing of yours there yet");
      }
      expect(output).toContain("ok   type check");
      expect(result.exitCode).not.toBe(2);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "an owner whose folders are all under firmware/ passes here, naming them for check:firmware",
    () => {
      const result = Bun.spawnSync(["bun", "run", "check:own", "U3"], {
        cwd: REPO,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).toContain(
        "under firmware/, checked by bun run check:firmware: firmware/platform/psa",
      );
      expect(output).toContain("ok   your tests: none here");
      expect(output).not.toContain("usage:");
      expect(result.exitCode).toBe(0);
    },
    RUN_TIMEOUT_MS,
  );

  test("with nothing named, it shows how it is used, naming the new owners too", () => {
    const result = Bun.spawnSync(["bun", "run", "check:own"], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain("usage: bun run check:own <folder | owner>");
    for (const range of ["A1…A11", "B1…B7", "U1…U10", "K2", "P1…P6", "H1", "F1"])
      expect(output).toContain(range);
    expect(result.exitCode).toBe(2);
  });
});
