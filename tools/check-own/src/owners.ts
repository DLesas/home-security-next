/**
 * The owners of M2's step 1, their folders and their tests (docs/m2-design.md section 11, "Step
 * 1: in parallel"), in one place, so `bun run check:own A3` checks A3's folders and runs A3's own
 * tests. Each folder holds a README naming its owner, what is frozen for them and what they may
 * change. A folder named here that holds files owned by someone else (A1's new files beside the
 * frozen ones in `packages/protocol/src/app/`, A11's `serial*.ts` and the new files its paths need
 * in `hub/src/shell/safe/`) is checked whole: the check is per folder.
 *
 * `tests` are where the owner's tests live, folders or single files: the project keeps most tests
 * under `hub/test/unit/<module>/` rather than beside the source, so an owner's source folders
 * alone would find almost none. Every `*.test.ts` under an owner's folders is run too (A1's and
 * A5's tests beside their source, A9's folders of tests). A path not written yet counts nothing
 * and is named in the output.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * The projects `bun run typecheck` checks (the root's `package.json`), in its order: the root's,
 * and the app's sources, tests, build script and browser tests, each with a tsconfig of its own.
 */
export const TYPE_PROJECTS = [
  "tsconfig.json",
  "app/tsconfig.json",
  "app/test/tsconfig.json",
  "app/scripts/tsconfig.json",
  "app/e2e/tsconfig.json",
] as const;

export interface Owner {
  readonly folders: readonly string[];
  readonly tests: readonly string[];
  /** Why `check:own` runs none of this owner's tests, when `tests` is empty. */
  readonly noTestsBecause?: string;
}

export const OWNERS: Readonly<Record<string, Owner>> = {
  A1: {
    folders: ["packages/protocol/src/app", "packages/protocol/vectors"],
    tests: ["packages/protocol/test/app.test.ts", "packages/protocol/src/app"],
  },
  A2: {
    folders: ["hub/src/shell/app", "hub/cli"],
    tests: ["hub/test/unit/shell-app", "hub/test/unit/cli"],
  },
  A3: {
    folders: ["hub/src/core/people", "hub/src/core/app"],
    tests: ["hub/test/unit/people", "hub/test/unit/app"],
  },
  A4: {
    folders: ["hub/src/core/layout", "hub/src/core/alarm", "hub/src/core/control"],
    tests: [
      "hub/test/unit/layout",
      "hub/test/unit/alarm",
      "hub/test/unit/control",
      "hub/test/scenarios/alarm",
    ],
  },
  A5: {
    folders: ["hub/src/core/schedules", "hub/src/shell/calendar"],
    tests: ["hub/test/unit/schedules", "hub/test/unit/calendar", "hub/src/shell/calendar"],
  },
  A6: {
    folders: ["hub/src/core/health", "hub/src/core/notify"],
    tests: ["hub/test/unit/health", "hub/test/unit/notify"],
  },
  A7: {
    folders: ["app/src", "app/locales", "app/test", "app/scripts"],
    tests: ["app/test"],
  },
  A8: {
    folders: [
      "hub/packaging",
      "hub/launcher",
      "hub/src/core/upkeep",
      "hub/src/shell/backup",
      "hub/src/shell/update",
    ],
    tests: [
      "hub/test/unit/upkeep",
      "hub/test/unit/shell-backup",
      "hub/test/unit/shell-update",
      "hub/launcher",
    ],
  },
  // `app/e2e/` runs in Playwright (`bun run app:e2e`), not in `bun test`.
  A9: {
    folders: ["hub/test/budget", "hub/test/crash", "app/e2e", ".github/workflows"],
    tests: ["hub/test/budget", "hub/test/crash"],
  },
  A10: {
    folders: [],
    tests: [],
    noTestsBecause:
      "A10's folders are under firmware/, which has its own checks: bun run check:firmware",
  },
  A11: {
    folders: ["hub/src/shell/control", "hub/src/shell/safe"],
    tests: [
      "hub/test/unit/shell-control",
      "hub/test/unit/safe",
      "hub/test/unit/shell-links/serial.test.ts",
      "hub/test/unit/shell-links/serial-clean.test.ts",
    ],
  },
};

function ownerOf(argument: string): Owner | undefined {
  return OWNERS[argument.toUpperCase()];
}

/** The folders an argument names: an owner's (`A3`), or the folder itself. */
export function foldersOf(argument: string): readonly string[] {
  return ownerOf(argument)?.folders ?? [argument];
}

/** Where an argument's own tests are: an owner's `tests` and folders, or the folder itself. */
export function testPathsOf(argument: string): readonly string[] {
  const owner = ownerOf(argument);
  return owner === undefined ? [argument] : [...new Set([...owner.tests, ...owner.folders])];
}

/**
 * What the lint and format steps check for some arguments: every folder they name, and every test
 * path of theirs that exists, without repeats. A test path not written yet is skipped.
 */
export function lintPathsOf(args: readonly string[]): readonly string[] {
  const paths = [...args.flatMap(foldersOf), ...args.flatMap(testPathsOf)].map((p) =>
    p.replace(/^\.\//u, "").replace(/\/+$/u, ""),
  );
  return [...new Set(paths)].filter((p) => existsSync(join(REPO, p)));
}

/** Why an argument has no tests here, if its owner says so. */
export function noTestsBecause(argument: string): string | undefined {
  return ownerOf(argument)?.noTestsBecause;
}
