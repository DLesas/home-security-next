/**
 * The owners of M2's step 1 (docs/m2-design.md section 11, "Step 1: in parallel") and of the joint
 * work on M3, M4 and M5 (docs/m3-m4-plan.md, "Step 1"; m4-design.md section 12,
 * m3-updates-design.md section 10, m3-design.md section 10), their folders and their tests, so
 * `bun run check:own A3` checks A3's folders and runs A3's own tests. Each of M2's folders holds a
 * README naming its owner, what is frozen for them and what they may change. A folder named here
 * that holds files owned by someone else (A1's new files beside the frozen ones in
 * `packages/protocol/src/app/`, A11's `serial*.ts` and the new files its paths need in
 * `hub/src/shell/safe/`, the M2 modules where U8 and H1 add their parts) is checked whole: the
 * check is per folder.
 *
 * Where a design names single files rather than a folder (B1's `noise.ts`, P2's files in
 * `app/src/hub/`, U8's `KeyStore`), they are named as files; where it names files by a pattern
 * (`packages/protocol/vectors/relay-*.json`, `app/src/platform/*.native.ts`), the pattern's `*`
 * is in the last part of the path only.
 *
 * `tests` are where the owner's tests live, folders or single files: the project keeps most tests
 * under `hub/test/unit/<module>/` rather than beside the source, so an owner's source folders
 * alone would find almost none. Every `*.test.ts` under an owner's folders is run too (A1's and
 * A5's tests beside their source, A9's folders of tests). A path not written yet counts nothing
 * and is named in the output; so is a folder of an owner that is not created yet, which the new
 * work's owners have until they start: neither fails the check by being missing.
 *
 * `firmware` names an owner's paths under `firmware/`, as its design gives them: C++, which this
 * check does not read (`bun run check:firmware` does), named so the record is whole.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * The projects `bun run typecheck` checks, in the order listed in the root's `package.json`.
 */
export const TYPE_PROJECTS = [
  "tsconfig.json",
  "app/tsconfig.json",
  "app/test/tsconfig.json",
  "app/scripts/tsconfig.json",
  "app/e2e/tsconfig.json",
  "app/tsconfig.native.json",
  "tools/ble-bench/pages/tsconfig.json",
  "app/e2e-native/tsconfig.json",
] as const;

export interface Owner {
  readonly folders: readonly string[];
  readonly tests: readonly string[];
  /** Why `check:own` runs none of this owner's tests, when `tests` is empty. */
  readonly noTestsBecause?: string;
  /** The owner's paths under `firmware/`, which `bun run check:firmware` checks, not this. */
  readonly firmware?: readonly string[];
}

const FIRMWARE_CHECK = "bun run check:firmware";

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
    folders: [
      "hub/test/budget",
      "hub/test/crash",
      "app/e2e",
      ".github/workflows",
      "packages/protocol/verify",
    ],
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

  // The relay and push (m4-design.md section 12, "Owners and their work, after step 0"). A6 and A8
  // keep M2's folders for their M4 parts.
  B1: {
    folders: [
      "packages/protocol/src/relay",
      "packages/protocol/src/app/noise.ts",
      "packages/protocol/vectors/relay-*.json",
    ],
    tests: [
      "packages/protocol/src/relay",
      "packages/protocol/src/app/noise.test.ts",
      "packages/protocol/src/app/noise-published.test.ts",
    ],
  },
  B2: {
    folders: ["relay/src/core", "relay/src/shell", "relay/src/releases", "relay/test"],
    tests: ["relay/test"],
  },
  // B3's tests live in B2's `relay/test/`, under `push/`.
  B3: {
    folders: ["relay/src/push", "tools/push-standins"],
    tests: ["relay/src/push", "relay/test/push", "tools/push-standins/test"],
  },
  // The relay module's tests are in `relay-core`, apart from the relay workspace's.
  B5: {
    folders: ["hub/src/core/relay"],
    tests: ["hub/test/unit/relay-core"],
  },
  B6: {
    folders: ["hub/src/shell/relay", "hub/src/shell/app"],
    tests: ["hub/test/unit/shell-relay", "hub/test/unit/shell-app"],
  },
  B7: {
    folders: ["hub/test/relay", "hub/test/budget", "hub/test/crash", ".github/workflows"],
    tests: ["hub/test/relay", "hub/test/budget", "hub/test/crash"],
  },
  // Per-hub names, last, once a domain exists (m4-design.md section 12, "Last").
  B4: {
    folders: ["relay/src/names", "hub/src/shell/names", "tools/dns-standin"],
    tests: ["relay/src/names", "hub/test/unit/shell-names", "tools/dns-standin/test"],
  },

  // Firmware updates and the key change after a restore (m3-updates-design.md section 10,
  // "Owners, step 1"). K1 is part of U8 (docs/m3-m4-plan.md, "Step 1").
  U1: {
    folders: [],
    tests: [],
    noTestsBecause: `U1's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: [
      "firmware/core/src/device/update*",
      "firmware/core/include/hsn/device/services/update*",
      "firmware/tests/device/update*",
    ],
  },
  U2: {
    folders: [],
    tests: [],
    noTestsBecause: `U2's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/platform/host", "firmware/tests/host/update*"],
  },
  U3: {
    folders: [],
    tests: [],
    noTestsBecause: `U3's folder is under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/platform/psa"],
  },
  U4: {
    folders: [],
    tests: [],
    noTestsBecause: `U4's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/roles/sensor", "firmware/tests/roles/sensor"],
  },
  U5: {
    folders: [],
    tests: [],
    noTestsBecause: `U5's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/roles/siren", "firmware/tests/roles/siren"],
  },
  U6: {
    folders: [],
    tests: [],
    noTestsBecause: `U6's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/roles/gateway", "firmware/tests/roles/gateway"],
  },
  U7: {
    folders: ["hub/src/core/firmware"],
    tests: ["hub/test/unit/firmware"],
  },
  // U8's update parts, and K1's key change: the four modules, the cipher, the `KeyStore` and
  // `applyRestore`'s transaction.
  U8: {
    folders: [
      "hub/src/core/sensors",
      "hub/src/core/sirens",
      "hub/src/core/gateways",
      "hub/src/core/intake",
      "hub/src/core/links",
      "hub/src/core/app",
      "hub/src/shell/cipher",
      "hub/src/shell/storage/keys.ts",
      "hub/src/shell/backup/restore.ts",
    ],
    tests: [
      "hub/test/unit/sensors",
      "hub/test/unit/sirens",
      "hub/test/unit/gateways",
      "hub/test/unit/intake",
      "hub/test/unit/links",
      "hub/test/unit/app",
      "hub/test/unit/shell-cipher",
      "hub/test/scenarios/sensors",
      "hub/test/scenarios/gateways",
    ],
  },
  U9: {
    folders: ["hub/src/shell/firmware", "hub/cli"],
    tests: ["hub/test/unit/shell-firmware", "hub/test/unit/cli"],
  },
  U10: {
    folders: ["hub/test/budget", "hub/test/crash"],
    tests: ["hub/test/budget", "hub/test/crash"],
    firmware: [
      "firmware/tests/system_roles/update_*",
      "firmware/tests/system_roles/restore_rekey_test.cpp",
      "firmware/platform/host/include/hsn/host/remote_hub.hpp",
      "firmware/platform/host/src/remote_hub.cpp",
    ],
  },
  K2: {
    folders: [],
    tests: [],
    noTestsBecause: `K2's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/core/src/device/secure_channel*", "firmware/tests/device/secure_channel*"],
  },

  // The phone app and Bluetooth pairing (m3-design.md section 10, "Owners"; with the relay
  // `Connect` and push registration P2's, the relay's screens P5's: docs/m3-m4-plan.md).
  P1: {
    folders: ["app/modules/hub-net", "app/modules/push"],
    tests: ["app/modules/hub-net", "app/modules/push"],
  },
  P2: {
    folders: [
      "app/src/platform/*.native.ts",
      "app/src/hub/start.native.ts",
      "app/src/hub/finder.ts",
      "app/src/hub/restore.ts",
      "app/src/hub/relay.ts",
      "app/src/hub/push.ts",
      "app/plugins",
    ],
    tests: ["app/test"],
  },
  P3: {
    folders: ["packages/protocol/src/pairing", "packages/protocol/vectors/pairing-*.json"],
    tests: ["packages/protocol/src/pairing", "packages/protocol/test/pairing-step0.test.ts"],
  },
  P4: {
    folders: ["app/src/pairing", "app/src/ble-update"],
    tests: ["app/test"],
  },
  P5: {
    folders: ["app/src/app", "app/src/ui", "app/locales/en"],
    tests: ["app/test"],
  },
  // `app/e2e-native/` runs on the simulators, not in `bun test`.
  P6: {
    folders: ["tools/ble-bench", "app/e2e-native"],
    tests: ["tools/ble-bench/test"],
  },
  H1: {
    folders: [
      "hub/src/core/setup",
      "hub/src/core/registry",
      "hub/src/core/app",
      "hub/src/shell/advertise",
    ],
    tests: [
      "hub/test/unit/setup",
      "hub/test/unit/registry",
      "hub/test/unit/app",
      "hub/test/unit/shell-advertise",
      "hub/test/scenarios/setup",
    ],
  },
  F1: {
    folders: [],
    tests: [],
    noTestsBecause: `F1's folders are under firmware/, which has its own checks: ${FIRMWARE_CHECK}`,
    firmware: ["firmware/platform/esp-idf/bluetooth", "firmware/core/src/device/setup*"],
  },
};

function ownerOf(argument: string): Owner | undefined {
  return OWNERS[argument.toUpperCase()];
}

/** Whether an argument names an owner (`A3`, `b5`) rather than a folder. */
export function isOwner(argument: string): boolean {
  return ownerOf(argument) !== undefined;
}

/** The folders an argument names: an owner's (`A3`), or the folder itself. */
export function foldersOf(argument: string): readonly string[] {
  return ownerOf(argument)?.folders ?? [argument];
}

/** An owner's paths under `firmware/`, which `bun run check:firmware` checks. */
export function firmwareOf(argument: string): readonly string[] {
  return ownerOf(argument)?.firmware ?? [];
}

/**
 * The paths a folder, a file or a pattern names that exist now, from the repository's root: the
 * path itself, or each entry its pattern matches (a `*` in the last part only), sorted.
 */
export function expandPath(path: string): readonly string[] {
  const name = path.split("/").at(-1) ?? "";
  if (!name.includes("*")) return existsSync(join(REPO, path)) ? [path] : [];
  const parent = dirname(path);
  const full = join(REPO, parent);
  if (!existsSync(full) || !statSync(full).isDirectory()) return [];
  const pattern = new RegExp(
    `^${name
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
      .join(".*")}$`,
    "u",
  );
  return readdirSync(full)
    .filter((entry) => pattern.test(entry))
    .sort()
    .map((entry) => `${parent}/${entry}`);
}

/**
 * For some arguments, the owners' folders, files and patterns that are there now, as concrete
 * paths (`present`), and those not created yet (`notYet`), each once. A folder named alone is
 * neither: whether it is there is the caller's to check.
 */
export function ownerPathsOf(args: readonly string[]): {
  readonly present: readonly string[];
  readonly notYet: readonly string[];
} {
  const named = [...new Set(args.filter(isOwner).flatMap(foldersOf))];
  return {
    present: [...new Set(named.flatMap(expandPath))],
    notYet: named.filter((path) => expandPath(path).length === 0),
  };
}

/** Where an argument's own tests are: an owner's `tests` and folders, or the folder itself. */
export function testPathsOf(argument: string): readonly string[] {
  const owner = ownerOf(argument);
  return owner === undefined ? [argument] : [...new Set([...owner.tests, ...owner.folders])];
}

/**
 * What the lint and format steps check for some arguments: every folder they name, and every test
 * path of theirs that exists, without repeats. A path not written yet is skipped; a pattern is
 * kept as it is, for ESLint and Prettier to match, when it matches something.
 */
export function lintPathsOf(args: readonly string[]): readonly string[] {
  const paths = [...args.flatMap(foldersOf), ...args.flatMap(testPathsOf)].map((p) =>
    p.replace(/^\.\//u, "").replace(/\/+$/u, ""),
  );
  return [...new Set(paths)].filter((p) => expandPath(p).length > 0);
}

/** Why an argument has no tests here, if its owner says so. */
export function noTestsBecause(argument: string): string | undefined {
  return ownerOf(argument)?.noTestsBecause;
}
