/**
 * The hub's side of the notes it leaves the launcher (m2-design.md section 9, "Hub updates"; the
 * contract is `hub/launcher/src/layout.ts`):
 *
 * - **The switch** (`switchUpdate`): `switch.json` naming the staged version, written durably;
 *   then the hub stops cleanly and exits 70, and the launcher puts the new version on trial. The
 *   shell asks the core's view first (`switchBlockedBy`): a countdown, an alarm, a site move, a
 *   provisioning or a restore that started in the same turn holds the switch back, and the job is
 *   answered `failed`, so upkeep waits again (`core/upkeep/update.ts`).
 * - **Health**: once a commit holds the `update_healthy` decision, `healthy.json` naming the
 *   version, which ends the launcher's trial.
 *
 * The hub's program tree (`staged/`, `state/`, section 9 "The privilege boundary") comes from the
 * launcher, in `HSN_PROGRAM`; a hub run by hand has none and cannot stage or switch.
 */
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import { installPaths, isVersionName } from "../../../launcher/src/layout.ts";
import { PACKAGE_TRIAL_VARIABLE, PROGRAM_VARIABLE } from "../../../launcher/src/launcher.ts";
import type { AuditRecord } from "../../core/model/audit.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import type { SwitchBlock } from "../../core/upkeep/view.ts";
import { exists, writeDurably } from "../backup/files.ts";

/** The hub's program tree, from the launcher; undefined when the hub was not started by one. */
export function prefixFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const prefix = env[PROGRAM_VARIABLE];
  return prefix === undefined || prefix === "" ? undefined : prefix;
}

/**
 * What a person is told holds an update's switch back, by the core's name for it
 * (`core/upkeep/update.ts`'s `SwitchBlock`, which `update.approve` answers as `after:<hold>`).
 */
export const SWITCH_HOLD_WORDS: Readonly<Record<SwitchBlock, string>> = {
  countdown: "a countdown is running",
  alarm: "the alarm is sounding",
  siteMove: "the site is moving to new radio settings",
  provisioning: "a board is being added",
  restore: "a restore is under way",
  firmwareInstall: "a device is installing new firmware or checking it on trial",
};

/** A hold's words, or its name for one without (none, while the type above lists them all). */
function holdWords(hold: string): string {
  const words: Readonly<Record<string, string>> = SWITCH_HOLD_WORDS;
  return words[hold] ?? hold;
}

/**
 * `switchUpdate`: the note for the launcher, unless something holds the switch back. On success
 * the caller stops the hub cleanly and exits 70; on a failure the job's outcome goes to the core.
 */
export function requestSwitch(
  prefix: string | undefined,
  version: string,
  blockedBy: string | undefined,
): Result<void, FileOutcome> {
  if (blockedBy !== undefined)
    return err({
      kind: "failed",
      reason: "io",
      message: `held back: ${holdWords(blockedBy)}`,
    });
  if (prefix === undefined)
    return err({
      kind: "failed",
      reason: "io",
      message: "not started by the launcher: no install to switch",
    });
  const paths = installPaths(prefix);
  if (!isVersionName(version) || !exists(join(paths.staged, version)))
    return err({ kind: "failed", reason: "io", message: `${version} is not installed` });
  const note = new TextEncoder().encode(`${JSON.stringify({ to: version })}\n`);
  const written = writeDurably(paths.switchFile, `${paths.switchFile}.new`, note);
  return written.isErr() ? err({ kind: "failed", ...written.error }) : ok(undefined);
}

/**
 * The version a commit makes healthy, if any: the one a committed `update_healthy` names (an
 * update's trial); or, on a package's trial (the launcher's `HSN_PACKAGE_TRIAL`, naming this
 * version), the first commit at all, since the core records no `update_healthy` for a switch it
 * did not make. The caller writes `healthy.json` once its listeners are open too
 * (`app-wiring.ts`), so both trials pass on one sign: migrated, booted, a commit made, listening.
 */
export function healthyIn(
  records: readonly AuditRecord[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const packageTrial = env[PACKAGE_TRIAL_VARIABLE];
  if (packageTrial !== undefined && isVersionName(packageTrial)) return packageTrial;
  for (const record of records) {
    if (
      record.kind === "decision" &&
      record.row.kind === "update_healthy" &&
      record.row.detail !== null
    )
      return new TextDecoder().decode(record.row.detail);
  }
  return undefined;
}

/** `healthy.json`, after the commit that holds `update_healthy` (section 9, step 4). */
export function markHealthy(prefix: string | undefined, version: string): Result<void, string> {
  if (prefix === undefined) return ok(undefined);
  const paths = installPaths(prefix);
  const note = new TextEncoder().encode(`${JSON.stringify({ version })}\n`);
  return writeDurably(paths.healthyFile, `${paths.healthyFile}.new`, note).mapErr((e) => e.message);
}
