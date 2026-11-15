/**
 * `hsn-launcher --prefix <folder> --select <version>`: what an installer runs, as root or
 * Administrator, after it put a version in `versions/` (a fresh install, or the package's own
 * upgrade): that version becomes current, the one before it is kept as the previous, any third is
 * removed (at most two, section 9), and `current` points at it. It is not a trial: a package's
 * upgrade is the person's own act, and the hub's `update_healthy` belongs to an update it switched
 * to itself (`core/upkeep/update.ts`).
 */
import { join } from "node:path";
import { err, ok, Result, type Result as R } from "neverthrow";
import { isFolder, names, pointLink, readText, removePath, writeDurably } from "./io.ts";
import { installPaths, isVersionName, type LauncherState, parseLauncherState } from "./layout.ts";

export function selectVersion(prefix: string, version: string): R<LauncherState, string> {
  const paths = installPaths(prefix);
  if (!isVersionName(version)) return err(`not a version: ${version}`);
  if (!isFolder(join(paths.versions, version)).unwrapOr(false))
    return err(`${version} is not installed in ${paths.versions}`);
  const text = readText(paths.launcherFile);
  if (text.isErr()) return err(text.error.message);
  const before = text.value === undefined ? undefined : parseLauncherState(text.value);
  const previous =
    before === undefined || before.current === version
      ? (before?.previous ?? null)
      : before.current;
  const state: LauncherState = { current: version, previous, trial: null, rolledBack: null };
  const kept = new Set([version, previous]);
  return writeDurably(paths.launcherFile, `${JSON.stringify(state)}\n`)
    .andThen(() => pointLink(paths.current, join(paths.versions, version)))
    .andThen(() => names(paths.versions))
    .andThen((found) =>
      Result.combine(
        found
          .filter((name) => isVersionName(name) && !kept.has(name))
          .map((name) => removePath(join(paths.versions, name))),
      ),
    )
    .map(() => state)
    .mapErr((error) => error.message)
    .andThen((s) => ok(s));
}
