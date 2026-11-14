/**
 * The owners of M2's step 1 and their folders (docs/m2-design.md section 11, "Step 1: in
 * parallel"), so `bun run check:own A3` checks A3's folders. Each folder holds a README naming
 * its owner, what is frozen for them and what they may change. A folder named here that holds
 * files owned by someone else (A1's new files beside the frozen ones in
 * `packages/protocol/src/app/`, A11's `serial*.ts` and the new files its paths need in
 * `hub/src/shell/safe/`) is checked whole: the check is per folder.
 */
export const OWNERS: Readonly<Record<string, readonly string[]>> = {
  A1: ["packages/protocol/src/app", "packages/protocol/vectors"],
  A2: ["hub/src/shell/app", "hub/cli"],
  A3: ["hub/src/core/people", "hub/src/core/app"],
  A4: ["hub/src/core/layout", "hub/src/core/alarm", "hub/src/core/control"],
  A5: ["hub/src/core/schedules", "hub/src/shell/calendar"],
  A6: ["hub/src/core/health", "hub/src/core/notify"],
  A7: ["app/src", "app/locales", "app/test", "app/scripts"],
  A8: [
    "hub/packaging",
    "hub/launcher",
    "hub/src/core/upkeep",
    "hub/src/shell/backup",
    "hub/src/shell/update",
  ],
  A9: ["hub/test/budget", "hub/test/crash", "app/e2e", ".github/workflows"],
  // A10's folders are under firmware/, which `bun run check:own` does not check (the firmware
  // has its own checks: `bun run check:firmware`).
  A10: [],
  A11: ["hub/src/shell/control", "hub/src/shell/safe"],
};

/** The folders an argument names: an owner's (`A3`), or the folder itself. */
export function foldersOf(argument: string): readonly string[] {
  return OWNERS[argument.toUpperCase()] ?? [argument];
}
