/**
 * The install folder and the notes the hub and the launcher leave each other (m2-design.md
 * section 9, "The program" and "Hub updates"). One contract, read by the launcher and written by
 * the hub's shell (`hub/src/shell/update/`):
 *
 * ```
 * <prefix>/versions/<version>/bin/hsn-hub[.exe]   the program: the hub and `hsn` (section 9)
 * <prefix>/current                                a link to the running version, for `hsn` on PATH
 * <prefix>/state/launcher.json                    the launcher's own: the current and previous
 *                                                 versions, a trial of a new one, a rollback
 * <prefix>/state/switch.json                      the hub's: switch to this version (it then exits 70)
 * <prefix>/state/healthy.json                     the hub's: this version recorded `update_healthy`
 * ```
 *
 * The launcher's file is the truth; `current` follows it, and on Windows is a directory junction.
 * At most two versions are kept (`LAUNCHER.versionsKept`).
 */
import { join } from "node:path";
import { Result } from "neverthrow";

export interface InstallPaths {
  readonly prefix: string;
  readonly versions: string;
  readonly state: string;
  readonly launcherFile: string;
  readonly switchFile: string;
  readonly healthyFile: string;
  readonly current: string;
}

export function installPaths(prefix: string): InstallPaths {
  const state = join(prefix, "state");
  return {
    prefix,
    versions: join(prefix, "versions"),
    state,
    launcherFile: join(state, "launcher.json"),
    switchFile: join(state, "switch.json"),
    healthyFile: join(state, "healthy.json"),
    current: join(prefix, "current"),
  };
}

/** The program of a version: one executable holding the hub and `hsn` (section 9). */
export function programOf(
  paths: InstallPaths,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(paths.versions, version, "bin", platform === "win32" ? "hsn-hub.exe" : "hsn-hub");
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
}

export interface LauncherState {
  readonly current: string;
  readonly previous: string | null;
  readonly trial: Trial | null;
  /** The last rollback, for the log and a person looking: from which version, and why. */
  readonly rolledBack: { readonly from: string; readonly reason: string } | null;
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
    trial = { version: tv, from, copiesBefore: seen };
  }
  let rolledBack: LauncherState["rolledBack"] = null;
  if (r.rolledBack !== null && r.rolledBack !== undefined) {
    const b = record(r.rolledBack);
    const from = version(b?.from);
    const reason = b?.reason;
    if (from === undefined || typeof reason !== "string") return undefined;
    rolledBack = { from, reason };
  }
  return { current, previous, trial, rolledBack };
}

export function parseSwitchNote(text: string): SwitchNote | undefined {
  const to = version(record(parse(text))?.to);
  return to === undefined ? undefined : { to };
}

export function parseHealthyNote(text: string): HealthyNote | undefined {
  const v = version(record(parse(text))?.version);
  return v === undefined ? undefined : { version: v };
}
