/**
 * The pre-migration copies in the data folder (HD 6, "Migrations"; m2-design.md section 9, step
 * 5), as the launcher sees them: only a copy under its final name, `hub.db.before-<n>`, is one. The
 * hub writes each copy as `hub.db.copying` first and renames it once it is whole and synced
 * (`shell/storage/migrations.ts`), so a leftover `hub.db.copying` from a start cut off while
 * copying, `hub.db.before-restore` (a restore's, `shell/backup/restore.ts`) or any other name is
 * never taken for a copy and never put back.
 */
import { join } from "node:path";
import { Result, type Result as R } from "neverthrow";
import { type IoError, names, stamp } from "./io.ts";
import type { CopySeen } from "./layout.ts";

/** A whole pre-migration copy's name. */
export const COPY_NAME = /^hub\.db\.before-[0-9]+$/u;

/** The whole pre-migration copies in `dataDir` now, with their times and sizes. */
export function copiesIn(dataDir: string): R<readonly CopySeen[], IoError> {
  return names(dataDir).andThen((found) =>
    Result.combine(
      found
        .filter((name) => COPY_NAME.test(name))
        .map((name) =>
          stamp(join(dataDir, name)).map((s) =>
            s === undefined ? undefined : { name, mtimeMs: s.mtimeMs, size: s.size },
          ),
        ),
    ).map((all) => all.filter((c): c is CopySeen => c !== undefined)),
  );
}
