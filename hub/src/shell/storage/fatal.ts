/**
 * The storage's part of the top-level handler (hub-design.md section 10, "The top-level
 * handler"), and how the next start tells the three ends of a run apart.
 *
 * An error nothing caught is written, synchronously, to `fatal.log` (appended and synced), to
 * standard error, and, if the database works, to `hub_events` in a commit of its own; then
 * `main.ts` exits with code 70 for the service manager to restart (HB20). A failed commit is
 * also written to `fatal.log` at once (section 5). At the next start the last run ended
 * `clean` if its boot row has the clean-stop mark, `crash` if `fatal.log`'s last uncaught error
 * names its boot, and `unknown` otherwise: a power cut or a kill.
 */
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { HubError } from "../../core/model/errors.ts";
import type { BootInfo } from "../../core/model/events.ts";
import { type BootId, bootId, type Seq } from "../../core/model/ids.ts";
import type { BootRow, HubEventRow } from "../../core/model/rows.ts";
import { DEFAULT_RULES } from "../../core/model/rules.ts";
import type { Now } from "../../core/model/time.ts";
import type { StorageError } from "../../ports/writer.ts";
import {
  appendDurably,
  fileSize,
  readTextIfExists,
  replaceDurably,
  writeStandardError,
} from "../safe/fs.ts";
import { parseJson } from "../safe/json.ts";
import { sqlite } from "../safe/sqlite.ts";
import { bindRow, type Statements } from "./statements.ts";

const ORIGIN = "shell/storage/fatal";
const CALLER = { kind: "storage", origin: ORIGIN } as const;

/** The file in the data folder that outlives a database that does not work (section 10). */
export const FATAL_LOG = "fatal.log";

/** The exit code after an uncaught error, for the service manager to restart the hub (HB20). */
export const FATAL_EXIT_CODE = 70;

/**
 * One line of `fatal.log`: an uncaught error (`uncaught`), a failed commit (`commitFailed`), or
 * a start refused (`refused`: a database newer than the code). Only `uncaught` makes a crash.
 */
export interface FatalEntry {
  readonly kind: "uncaught" | "commitFailed" | "refused";
  /** The run it happened in; null before a boot id was known. */
  readonly boot: number | null;
  readonly atMs: number;
  readonly mono: number;
  readonly origin: string;
  readonly message: string;
}

export function fatalLogPath(dataDir: string): string {
  return join(dataDir, FATAL_LOG);
}

/**
 * Appends one entry to `fatal.log` and syncs it. Past `maxBytes` (1 MB ‡, section 6's size guard)
 * the file is cut back to its newest half, from a line's start, replaced durably.
 */
export function appendFatal(
  dataDir: string,
  entry: FatalEntry,
  maxBytes: number = DEFAULT_RULES.persistence.sizeGuard.fatalLogMaxBytes,
): Result<void, StorageError> {
  const path = fatalLogPath(dataDir);
  const appended = appendDurably(CALLER, path, `${JSON.stringify(entry)}\n`);
  if (appended.isErr()) return appended;
  const size = fileSize(CALLER, path);
  if (size.isErr()) return err(size.error);
  if (size.value === undefined || size.value <= maxBytes) return ok(undefined);
  return readTextIfExists(CALLER, path).andThen((text) => {
    const all = text ?? "";
    const half = Buffer.from(all)
      .subarray(Buffer.byteLength(all) - Math.floor(maxBytes / 2))
      .toString();
    const from = half.indexOf("\n");
    return replaceDurably(CALLER, path, from < 0 ? "" : half.slice(from + 1));
  });
}

function isFatalEntry(value: unknown): value is FatalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Readonly<Record<string, unknown>>;
  return (
    (entry.kind === "uncaught" || entry.kind === "commitFailed" || entry.kind === "refused") &&
    (entry.boot === null || typeof entry.boot === "number") &&
    typeof entry.message === "string"
  );
}

/** The last uncaught error in `fatal.log`, if any; lines that do not parse are passed over. */
export function lastUncaught(dataDir: string): Result<FatalEntry | undefined, StorageError> {
  const text = readTextIfExists(CALLER, fatalLogPath(dataDir));
  if (text.isErr()) return err(text.error);
  const entries = (text.value ?? "")
    .split("\n")
    .map((line) => parseJson(line, "storage", ORIGIN).unwrapOr(undefined))
    .filter(isFatalEntry)
    .filter((entry) => entry.kind === "uncaught");
  return ok(entries.at(-1));
}

/** This run's `BootInfo`: the next boot id, and how the run before it ended (HB34). */
export function bootInfo(
  previousBoot: BootRow | undefined,
  last: FatalEntry | undefined,
): BootInfo {
  const id = bootId((previousBoot?.id ?? 0) + 1);
  // A first start has no run before it that could have lost anything.
  if (previousBoot === undefined) return { id, previousExit: "clean", cause: undefined };
  if (previousBoot.cleanStopMs !== null) return { id, previousExit: "clean", cause: undefined };
  if (last?.boot === previousBoot.id) return { id, previousExit: "crash", cause: last.message };
  return { id, previousExit: "unknown", cause: undefined };
}

/** Where the top-level handler writes, and what it needs to stamp the record. */
export interface FatalContext {
  readonly dataDir: string;
  readonly boot: BootId | undefined;
  readonly now: () => Now;
  /** The database, while it works; the handler's own commit goes here. */
  readonly db: Database | undefined;
  readonly statements: Statements | undefined;
  /** The next record sequence of this boot (the audit module's view), for the `hub_events` row. */
  readonly nextSeq: () => Seq | undefined;
}

function describeThrown(thrown: unknown): {
  readonly message: string;
  readonly detail: string | null;
} {
  if (thrown instanceof Error) return { message: thrown.message, detail: thrown.stack ?? null };
  return {
    message: typeof thrown === "string" ? thrown : "a non-error value was thrown",
    detail: null,
  };
}

/** The uncaught error as a `hub_events` row, committed on its own. */
function commitFatal(context: FatalContext, row: HubEventRow): Result<void, StorageError> {
  const { db, statements } = context;
  if (db === undefined || statements === undefined) {
    return err({ kind: "storage", origin: ORIGIN, message: "no database to record the error in" });
  }
  return sqlite(ORIGIN, "record the uncaught error", () => {
    db.transaction(() => {
      statements.audit.hub_events.run(bindRow(row));
    })();
  });
}

/**
 * Writes an uncaught error everywhere it can: `fatal.log` (always tried first, since it needs
 * only the file system), standard error, and the database. Returns what could not be written;
 * the caller exits with `FATAL_EXIT_CODE` whatever this returns.
 */
export function recordUncaught(
  context: FatalContext,
  origin: string,
  thrown: unknown,
): readonly HubError[] {
  const now = context.now();
  const { message, detail } = describeThrown(thrown);
  const failures: HubError[] = [];
  const logged = appendFatal(context.dataDir, {
    kind: "uncaught",
    boot: context.boot ?? null,
    atMs: now.wall,
    mono: now.mono,
    origin,
    message,
  });
  if (logged.isErr()) failures.push(logged.error);
  const printed = writeStandardError(
    CALLER,
    `hub: uncaught error in ${origin}: ${detail ?? message}\n`,
  );
  if (printed.isErr()) failures.push(printed.error);
  const seq = context.nextSeq();
  if (seq === undefined) {
    failures.push({ kind: "storage", origin: ORIGIN, message: "no record sequence for the error" });
    return failures;
  }
  const row: HubEventRow = {
    seq,
    atMs: now.wall,
    clockOk: now.wallTrusted,
    level: "critical",
    origin,
    code: "uncaught",
    message,
    detail,
  };
  const committed = commitFatal(context, row);
  if (committed.isErr()) failures.push(committed.error);
  return failures;
}
