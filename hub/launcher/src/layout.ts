/**
 * The two program trees and the notes the hub and the launcher leave each other (m2-design.md
 * section 9, "The privilege boundary" and "Hub updates"). One contract, read by the launcher and
 * written by the hub's shell (`hub/src/shell/update/`):
 *
 * ```
 * The package's tree, root's (Administrators' and SYSTEM's); the hub's account reads and runs it:
 *   <package>/packaged/<version>/bin/hsn-hub[.exe]   a packaged version: the package's and the one
 *                                                    before it (the package prunes to two)
 *   <package>/installed                              the package's marker of a done install
 * The hub's program tree, the hub's account's, beside its data folder:
 *   <program>/staged/<version>/bin/hsn-hub[.exe]     a version the hub staged itself (an update)
 *   <program>/state/launcher.json                    the launcher's own: the current and previous
 *                                                    versions, a trial, the failed, a rollback
 *   <program>/state/switch.json                      the hub's: switch to this version (then exit 70)
 *   <program>/state/healthy.json                     the hub's: this version recorded `update_healthy`
 * ```
 *
 * A version is found in the package's tree first, then the hub's (the packaged one on a tie).
 * Nothing in either tree is run by root or an administrator, and nothing elevated reads the hub's.
 */
import { join } from "node:path";
import { Result } from "neverthrow";

export interface InstallPaths {
  /** The package's tree, root's. */
  readonly packageRoot: string;
  readonly packaged: string;
  readonly installedMarker: string;
  /** The hub's program tree. */
  readonly programRoot: string;
  readonly staged: string;
  readonly state: string;
  readonly launcherFile: string;
  readonly switchFile: string;
  readonly healthyFile: string;
}

/**
 * The two trees' paths. A hub that knows only its own tree (the hub's shell, from
 * `HSN_PROGRAM`) passes no package root: then only `staged/` and `state/` are meaningful.
 */
export function installPaths(programRoot: string, packageRoot = ""): InstallPaths {
  const state = join(programRoot, "state");
  return {
    packageRoot,
    packaged: join(packageRoot, "packaged"),
    installedMarker: join(packageRoot, "installed"),
    programRoot,
    staged: join(programRoot, "staged"),
    state,
    launcherFile: join(state, "launcher.json"),
    switchFile: join(state, "switch.json"),
    healthyFile: join(state, "healthy.json"),
  };
}

/** Where a version lies: the package's tree or the hub's. */
export type Tree = "packaged" | "staged";

/** The folder of a version in a tree. */
export function versionFolder(paths: InstallPaths, tree: Tree, version: string): string {
  return join(tree === "packaged" ? paths.packaged : paths.staged, version);
}

/** The program of a version in a folder: one executable holding the hub (section 9). */
export function programIn(folder: string, platform: NodeJS.Platform = process.platform): string {
  return join(folder, "bin", platform === "win32" ? "hsn-hub.exe" : "hsn-hub");
}

const VERSION_NUMBERS = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;

/** Whether version `a` is above `b`, as numbers, major first (as `shell/update/release.ts`). */
export function isNewerVersion(a: string, b: string): boolean {
  const x = VERSION_NUMBERS.exec(a);
  const y = VERSION_NUMBERS.exec(b);
  if (x === null || y === null) return false;
  for (let i = 1; i <= 3; i++)
    if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

/** A version's name as a folder: letters, digits, dots, dashes and plus signs only. */
export function isVersionName(name: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u.test(name);
}

/** A copy the hub made before a migration (HD 6), as the launcher saw it. */
export interface CopySeen {
  readonly name: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/** A new version on trial: started, not yet healthy (section 9, steps 3 to 5). */
export interface Trial {
  readonly version: string;
  /** The version it replaced, which a rollback starts again. */
  readonly from: string;
  /** The pre-migration copies in the data folder before it started. */
  readonly copiesBefore: readonly CopySeen[];
  /**
   * Put on trial because the package brought a newer version, not by the hub's own switch. The
   * hub's core records no `update_healthy` for it; the launcher tells the hub it is on a package's
   * trial, and the hub writes `healthy.json` at the point an update's would be, so both trials
   * pass on the same sign (`launcher.ts`, `#start`).
   */
  readonly byPackage: boolean;
}

export interface LauncherState {
  readonly current: string;
  readonly previous: string | null;
  readonly trial: Trial | null;
  /** The last rollback, for the log and a person looking: from which version, and why. */
  readonly rolledBack: { readonly from: string; readonly reason: string } | null;
  /** Versions that failed their trial: never chosen again, whichever tree holds them. */
  readonly failed: readonly string[];
}

/** What the hub asks before it exits 70: switch to this version. */
export interface SwitchNote {
  readonly to: string;
}

/** What the hub says once `update_healthy` is committed. */
export interface HealthyNote {
  readonly version: string;
}

type Json = unknown;

function parse(text: string): Json {
  return Result.fromThrowable(
    (): unknown => JSON.parse(text),
    () => undefined,
  )().unwrapOr(undefined);
}

function record(value: Json): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function version(value: unknown): string | undefined {
  return typeof value === "string" && isVersionName(value) ? value : undefined;
}

function copies(value: unknown): readonly CopySeen[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: CopySeen[] = [];
  for (const item of value as unknown[]) {
    const r = record(item);
    if (typeof r?.name !== "string" || typeof r.mtimeMs !== "number" || typeof r.size !== "number")
      return undefined;
    out.push({ name: r.name, mtimeMs: r.mtimeMs, size: r.size });
  }
  return out;
}

export function parseLauncherState(text: string): LauncherState | undefined {
  const r = record(parse(text));
  const current = version(r?.current);
  if (r === undefined || current === undefined) return undefined;
  const previous = r.previous === null ? null : version(r.previous);
  if (previous === undefined) return undefined;
  let trial: Trial | null = null;
  if (r.trial !== null) {
    const t = record(r.trial);
    const tv = version(t?.version);
    const from = version(t?.from);
    const seen = copies(t?.copiesBefore);
    if (tv === undefined || from === undefined || seen === undefined) return undefined;
    trial = { version: tv, from, copiesBefore: seen, byPackage: t?.byPackage === true };
  }
  let rolledBack: LauncherState["rolledBack"] = null;
  if (r.rolledBack !== null && r.rolledBack !== undefined) {
    const b = record(r.rolledBack);
    const from = version(b?.from);
    const reason = b?.reason;
    if (from === undefined || typeof reason !== "string") return undefined;
    rolledBack = { from, reason };
  }
  const failed = Array.isArray(r.failed)
    ? (r.failed as unknown[]).flatMap((f) => {
        const v = version(f);
        return v === undefined ? [] : [v];
      })
    : [];
  return { current, previous, trial, rolledBack, failed };
}

export function parseSwitchNote(text: string): SwitchNote | undefined {
  const to = version(record(parse(text))?.to);
  return to === undefined ? undefined : { to };
}

export function parseHealthyNote(text: string): HealthyNote | undefined {
  const v = version(record(parse(text))?.version);
  return v === undefined ? undefined : { version: v };
}
