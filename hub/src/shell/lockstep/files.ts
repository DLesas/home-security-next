/**
 * The lockstep hub's file work (hub-design.md section 11, "Lockstep"; docs/m3-updates-design.md
 * sections 4, 7 and 8): what `main.ts` gives the loop through the app side, given here without
 * one, so a controller can stage a firmware image, take a backup and restore it.
 *
 * - **Uploads.** `hsn firmware add` sends its file as `fileChunk` control lines on its
 *   connection (m2-design.md section 6); the lockstep hub's one control connection keeps them in
 *   an `UploadStore`, as the control socket does, for the `firmware.upload` that names its job.
 * - **File jobs.** Every `fileJob` the core asks for runs through `startJob` as on the running
 *   hub: staging and removing firmware, backups, exports; but each job the running hub gives a
 *   worker thread (D145) runs its same pieces on the hub's thread here, a piece a turn
 *   (`onThread`), so a run's every answer is the simulated clock's, never the machine's. A
 *   download's chunks (`backup.export`, `firmware.download`) have no line on the lockstep wire, so
 *   they fail; a switch (a hub update's, or a real `restore.start`'s) is not the lockstep hub's:
 *   the controller's restore is `benchRestore`, below.
 * - **The seeded keys a backup needs.** A real hub's backup key is made at its first start and
 *   reaches only a phone (m2-design.md section 9); a backup's header names the hub's app key. The
 *   lockstep hub has no phone and no app channel, so at its first start it makes both from the
 *   seed `start` gave, as it makes its signing key (`seededKey`): the controller holds the seed,
 *   so it holds the backup key, and nothing else ever does.
 * - **The run's figures** at a clean stop (`writeRunStats`): the writer's commits by reason and WAL
 *   frames, the longest turn and the longest transfer frame's answer, as JSON in
 *   `lockstep-stats.json` in the data folder, for a controller measuring the write budget
 *   (hub-design.md section 5) with devices only it has (the firmware's real roles). Nothing on the
 *   wire carries them, so the recorded sessions stay the machine's speed apart.
 * - **`benchRestore {file, key}`** (docs/m3-updates-design.md section 7, "How it is proven"):
 *   the file opened with the key and the restored database built beside `hub.db` exactly as a
 *   real restore's `applyRestore` builds it (`RestorePieces`), at once. It is put in place by the
 *   next start (`retryWaitingRestore`, as `main.ts` does), so the controller restarts the hub:
 *   `stop` or a kill, then `start`. Only the lockstep hub takes the command; the core refuses it
 *   on every other control socket.
 */
import type { Database } from "bun:sqlite";
import { BACKUP_FORMAT, x25519StaticKey } from "@hsn/protocol/app";
import { err, ok, type Result } from "neverthrow";
import { join } from "node:path";
import type { FileWork } from "../../core/model/effects.ts";
import type { HubError } from "../../core/model/errors.ts";
import type { FileOutcome } from "../../core/model/events.ts";
import type { JobId } from "../../core/model/ids.ts";
import type { BackupKeyRow } from "../../core/model/rows.ts";
import type { HubRules } from "../../core/model/rules.ts";
import type { HubState } from "../../core/model/state.ts";
import { stagingJob, switchBlockedBy } from "../../core/upkeep/view.ts";
import { readHubKeysRow } from "../app/app-keys.ts";
import type { UploadStore } from "../app/uploads.ts";
import { startJob } from "../backup/jobs.ts";
import { RestorePieces } from "../backup/restore.ts";
import type { JobStarted, LoopWriter } from "../loop.ts";
import { closeQuietly, openNew, removeQuietly, writeAll } from "../safe/firmware-io.ts";
import { PAGE_SIZE } from "../storage/settings.ts";
import { WAL_FRAME_HEADER_BYTES } from "../storage/wal.ts";
import type { WriterStats } from "../storage/writer.ts";
import { SeededRandom } from "./random.ts";

const ORIGIN = "shell/lockstep/files";

/** Pieces one `benchRestore` may take before it is refused: a file that never ends. */
const MAX_RESTORE_PIECES = 1_000_000;

/** The seed's own streams for the lockstep hub's made keys, by name ("keys" is the signing key). */
export type SeededKeyName = "keys" | "backup" | "app";

/**
 * A key made from the seed's own stream, so it depends on nothing else the run drew: SHA-256 in
 * counter mode (`SeededRandom`) over the seed followed by the name's ASCII bytes.
 */
export function seededKey(
  seed: Uint8Array,
  name: SeededKeyName,
  bytes: number,
): Result<Uint8Array, HubError> {
  return new SeededRandom(new Uint8Array([...seed, ...new TextEncoder().encode(name)])).bytes(
    bytes,
  );
}

/**
 * The backup key and the app key at the lockstep hub's first start, made from the seed and
 * written now through the writer, before the boot reads them (the core makes a backup key only
 * when the snapshot has none). A hub that holds either keeps it: a restored database brings the
 * file's own. Returns the backup key the boot snapshot should hold.
 */
export function seedBackupKeys(
  db: Database,
  writer: Pick<LoopWriter, "stage" | "flush">,
  seed: Uint8Array,
  backupKey: BackupKeyRow | undefined,
): Result<{ readonly backupKey: BackupKeyRow; readonly appStaticPublic: Uint8Array }, HubError> {
  const row = readHubKeysRow(db);
  if (row.isErr()) return err(row.error);
  const keys = row.value;
  if (keys === undefined)
    return err({ kind: "config", origin: ORIGIN, message: "the hub's signing keys come first" });
  const backup =
    backupKey === undefined
      ? seededKey(seed, "backup", BACKUP_FORMAT.keyBytes).map((key) => ({ key, epoch: 1 }))
      : ok(backupKey);
  if (backup.isErr()) return err(backup.error);
  const kept = keys.appStaticPublic;
  const app =
    kept === null
      ? seededKey(seed, "app", 32).andThen((privateKey) => {
          const made = x25519StaticKey(privateKey);
          return made.ok
            ? ok({ privateKey, publicKey: made.value.publicKey })
            : err({ kind: "config" as const, origin: ORIGIN, message: "no app key from the seed" });
        })
      : ok(undefined);
  if (app.isErr()) return err(app.error);
  const staged = [
    ...(backupKey === undefined
      ? [
          {
            kind: "write" as const,
            durability: "now" as const,
            op: { table: "backup_key" as const, op: "upsert" as const, row: backup.value },
          },
        ]
      : []),
    ...(app.value === undefined
      ? []
      : [
          {
            kind: "write" as const,
            durability: "now" as const,
            op: {
              table: "hub_keys" as const,
              op: "upsert" as const,
              row: {
                ...keys,
                appStaticPrivate: app.value.privateKey,
                appStaticPublic: app.value.publicKey,
              },
            },
          },
        ]),
  ];
  if (staged.length > 0) {
    writer.stage(staged);
    const flushed = writer.flush("now");
    if (flushed.isErr()) return err(flushed.error);
  }
  const appStaticPublic = app.value?.publicKey ?? kept;
  if (appStaticPublic === null)
    return err({ kind: "config", origin: ORIGIN, message: "the hub has no app key" });
  return ok({ backupKey: backup.value, appStaticPublic });
}

/** What the lockstep hub's file jobs need. */
export interface LockstepFileDeps {
  readonly db: Database;
  readonly dataDir: string;
  readonly migrationsFolder: string;
  readonly rules: HubRules;
  readonly uploads: UploadStore;
  readonly writer: Pick<LoopWriter, "flush">;
  readonly state: () => HubState;
  /** The wall clock now, in milliseconds. */
  readonly nowMs: () => number;
  /** A backup's salt: seeded bytes, never the host's. */
  readonly random: (length: number) => Result<Uint8Array, HubError>;
}

/** The loop's `files` port in lockstep: `startJob` as the running hub's, without downloads. */
export function lockstepFiles(deps: LockstepFileDeps): {
  perform(job: JobId, work: FileWork): JobStarted;
  ended(job: JobId, work: FileWork, outcome: FileOutcome | undefined): void;
} {
  return {
    perform: (job, work) => {
      const started = startJob(job, work, {
        db: deps.db,
        dataDir: deps.dataDir,
        migrationsFolder: deps.migrationsFolder,
        rules: deps.rules,
        uploads: { pathOf: (ref) => deps.uploads.finished(ref)?.path },
        // A download's chunks have no line on the lockstep wire (section 11).
        exports: { send: () => err("no downloads in lockstep: the wire has no line for them") },
        prefix: undefined,
        switchBlockedBy: () => switchBlockedBy(deps.state()),
        stagingWanted: (staging) => stagingJob(deps.state()) === staging,
        onThread: true,
        flush: () => deps.writer.flush("log").mapErr((e) => e.message),
        nowMs: deps.nowMs,
        salt: () => deps.random(8).mapErr((e) => e.message),
      });
      if (started.kind === "stopAndRestart")
        // A switch ends a real hub for its launcher; the lockstep hub has none (section 11).
        return {
          kind: "ready",
          outcome: {
            kind: "failed",
            reason: "io",
            message: "no switch in lockstep: a restore is benchRestore",
          },
        };
      if (started.kind !== "pieces") return started;
      const pieces = started.pieces;
      return {
        kind: "pieces",
        pieces: {
          next: () => {
            const outcome = pieces.next();
            return outcome === undefined ? { done: false } : { done: true, outcome };
          },
          abort: () => {
            pieces.abort("the hub is stopping");
          },
        },
      };
    },
    // An upload is freed once its job ends, however it ended (the app side's rule).
    ended: (_job, work) => {
      if (work.kind === "stageUpdate" || work.kind === "stageFirmware")
        deps.uploads.release(work.upload);
    },
  };
}

/**
 * `benchRestore`: the backup at `file` opened with `key` (32 bytes as base64url) and the restored
 * database built beside `hub.db`, all at once; the next start puts it in place.
 */
export function benchRestore(
  file: string,
  key: string,
  deps: Pick<LockstepFileDeps, "dataDir" | "migrationsFolder" | "rules">,
): Result<void, string> {
  const bytes = new Uint8Array(Buffer.from(key, "base64url"));
  if (bytes.length !== BACKUP_FORMAT.keyBytes) return err("the key is not 32 bytes");
  const pieces = new RestorePieces({
    dataDir: deps.dataDir,
    uploadPath: file,
    key: bytes,
    migrationsFolder: deps.migrationsFolder,
    rules: deps.rules,
  });
  for (let piece = 0; piece < MAX_RESTORE_PIECES; piece++) {
    const outcome = pieces.next();
    if (outcome === undefined) continue;
    return outcome.kind === "restoreReady" ? ok(undefined) : err(outcomeText(outcome));
  }
  pieces.abort("too many pieces");
  return err(`more than ${MAX_RESTORE_PIECES} pieces`);
}

function outcomeText(outcome: FileOutcome): string {
  return outcome.kind === "failed" ? `${outcome.reason}: ${outcome.message}` : outcome.kind;
}

/** The run's figures file, in the data folder. */
export const RUN_STATS_FILE = "lockstep-stats.json";

/**
 * The run's figures, written at a clean stop: what section 5's budget limits (commits, WAL bytes
 * as frames times a page and its 24-byte header) and section 3's loop limit (the longest turn,
 * the longest transfer frame's answer), in milliseconds of the machine running it. Best effort: a
 * file that cannot be written is left out, and the controller sees no figures.
 */
export function writeRunStats(
  dataDir: string,
  figures: {
    readonly writer: WriterStats;
    readonly longestTurnMs: number;
    readonly longestTransferMs: number;
  },
): void {
  const { writer } = figures;
  const text = JSON.stringify({
    commits: writer.commits,
    commitsByReason: writer.commitsByReason,
    walFrames: writer.walFrames,
    walBytes: writer.walFrames * (PAGE_SIZE + WAL_FRAME_HEADER_BYTES),
    checkpointedFrames: writer.checkpointedFrames,
    // Whole microseconds: the controller's JSON takes integers alone (section 11, "Values").
    longestTurnUs: Math.round(figures.longestTurnMs * 1000),
    longestTransferUs: Math.round(figures.longestTransferMs * 1000),
  });
  const path = join(dataDir, RUN_STATS_FILE);
  removeQuietly(path);
  openNew(path).match(
    (fd) => {
      writeAll(fd, new TextEncoder().encode(text), RUN_STATS_FILE).match(
        () => undefined,
        () => undefined,
      );
      closeQuietly(fd);
    },
    () => undefined,
  );
}
