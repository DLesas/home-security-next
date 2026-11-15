/**
 * The launcher (m2-design.md section 9, "Starts at boot" and "Hub updates"; D54, HB20, HB23): the
 * small program the service manager starts, which starts the hub and turns a broken update into a
 * short outage instead of a dead hub.
 *
 * - It runs `<prefix>/versions/<current>/bin/hsn-hub --data <folder> …` and restarts it on any
 *   exit but 0, with the backoff of `backoff.ts`. It exits only for a clean stop (0): when the
 *   service manager stops it, or when the hub stopped cleanly by itself.
 * - **A switch.** The hub writes `switch.json` and exits 70 (`shell/update/`). The launcher puts the
 *   new version on trial: `current` is the new one, the pre-migration copies in the data folder are
 *   noted, and the new version is started.
 * - **Health.** The new version writes `healthy.json` once its `update_healthy` is committed. The
 *   trial ends: the old version is kept only for the next rollback, and any third is removed.
 * - **Rollback.** If the new version exits first, or 60 s ‡ pass, the launcher stops it, puts back
 *   the pre-migration copy (`hub.db.before-<n>`) when the new version made one, points `current`
 *   back and starts the old version, which finds the switch unfinished and records
 *   `update_rolled_back` (`core/upkeep/update.ts`).
 * - **A stop.** On SIGTERM or SIGINT it passes SIGTERM to the hub (macOS and Linux; on Windows the
 *   hub gets the service wrapper's console event itself), waits up to `stopGraceMs`, then kills
 *   it, and exits 0.
 */
import type { Subprocess } from "bun";
import { join } from "node:path";
import { err, ok, Result, type Result as R } from "neverthrow";
import { LAUNCHER, UPDATES } from "../../src/shell/m2-values.ts";
import { Backoff, type BackoffRules, type Next } from "./backoff.ts";
import {
  copyDurably,
  isFolder,
  type IoError,
  names,
  pointLink,
  readText,
  removePath,
  stamp,
  writeDurably,
} from "./io.ts";
import {
  type CopySeen,
  installPaths,
  type InstallPaths,
  isVersionName,
  type LauncherState,
  parseHealthyNote,
  parseLauncherState,
  parseSwitchNote,
  programOf,
  type Trial,
} from "./layout.ts";

/** The database's file and its companions (HD 6). */
const DATABASE = "hub.db";
const BEFORE_PREFIX = `${DATABASE}.before-`;

/** Starts the hub: its command, and its environment (the parent's with `HSN_PREFIX`). */
export type Spawn = (
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => Subprocess;

/** Tells the hub where it is installed, for its notes to the launcher (`layout.ts`). */
export const PREFIX_VARIABLE = "HSN_PREFIX";

export interface LauncherOptions {
  readonly prefix: string;
  readonly dataDir: string;
  /** More arguments for the hub, after `--data <folder>`. */
  readonly hubArgs?: readonly string[];
  readonly rules?: BackoffRules;
  /** 60 s ‡: the new version must say it is healthy within this. */
  readonly healthyWithinMs?: number;
  /** How long a stopped hub may take before it is killed. */
  readonly stopGraceMs?: number;
  /** How often a trial looks for `healthy.json`. */
  readonly pollMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly spawn?: Spawn;
  readonly log?: (line: string) => void;
  /** The system's log (the journal, the unified log, the Windows event log). */
  readonly systemLog?: (line: string) => void;
}

/** In the data folder, after the third failure in a row ‡ (section 9). */
export const STATUS_FILE = "launcher-status.json";
/** Failures in a row before `launcher-status.json` is written ‡. */
export const STATUS_AFTER_FAILURES = 3;
/** How much of `fatal.log`'s end the status carries. */
const FATAL_TAIL_LINES = 10;

export interface LauncherStatus {
  readonly failingSinceMs: number;
  readonly failures: number;
  readonly lastExitCode: number | null;
  readonly fatalLog: readonly string[];
}

/** The last lines of the hub's `fatal.log` (HD 10), or none. */
function fatalTail(dataDir: string): readonly string[] {
  const text = readText(join(dataDir, "fatal.log")).unwrapOr(undefined) ?? "";
  return text
    .split("\n")
    .filter((line) => line !== "")
    .slice(-FATAL_TAIL_LINES);
}

/**
 * Each system's log: on Linux the launcher's standard error is the journal's (systemd); on macOS
 * `logger` writes to the unified log; on Windows `eventcreate` to the Application log, under the
 * source "HSN Hub" the installer registered. A failure to log is not the launcher's to fix.
 */
export function systemLogFor(platform: NodeJS.Platform): (line: string) => void {
  const command = (line: string): readonly string[] | undefined => {
    if (platform === "darwin") return ["logger", "-t", "hsn-hub", line];
    if (platform === "win32")
      return [
        "eventcreate.exe",
        "/L",
        "APPLICATION",
        "/SO",
        "HSN Hub",
        "/T",
        "WARNING",
        "/ID",
        "100",
        "/D",
        line,
      ];
    return undefined;
  };
  return (line) => {
    const argv = command(line);
    if (argv === undefined) {
      process.stderr.write(`hsn-hub: ${line}\n`);
      return;
    }
    Result.fromThrowable(() =>
      Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" }),
    )().match(
      () => undefined,
      () => undefined,
    );
  };
}

const defaultSpawn: Spawn = (command, env) =>
  Bun.spawn([...command], { env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });

type Waited = "exited" | "healthy" | "timeout";

export class Launcher {
  readonly #paths: InstallPaths;
  readonly #options: LauncherOptions;
  readonly #backoff: Backoff;
  readonly #log: (line: string) => void;
  #stopping = false;
  #child: Subprocess | undefined;
  #wake: (() => void) | undefined;
  #starts = 0;
  #failingSinceMs: number | undefined;
  readonly #systemLog: (line: string) => void;

  constructor(options: LauncherOptions) {
    this.#options = options;
    this.#paths = installPaths(options.prefix);
    this.#backoff = new Backoff(options.rules ?? LAUNCHER);
    this.#log =
      options.log ??
      ((line) => {
        process.stderr.write(`launcher: ${line}\n`);
      });
    this.#systemLog = options.systemLog ?? systemLogFor(options.platform ?? process.platform);
  }

  /** Read through a call: a stop arrives while the loop awaits. */
  #isStopping(): boolean {
    return this.#stopping;
  }

  /** How many times the hub was started. */
  get starts(): number {
    return this.#starts;
  }

  /** A stop from the service manager: the hub stopped cleanly, then the launcher exits 0. */
  stop(): void {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#wake?.();
    const child = this.#child;
    if (child === undefined) return;
    // On Windows the service wrapper's console event reaches the hub itself (spike W3).
    if ((this.#options.platform ?? process.platform) !== "win32") child.kill("SIGTERM");
    const grace = setTimeout(() => {
      child.kill("SIGKILL");
    }, this.#options.stopGraceMs ?? 15_000);
    void child.exited.then(() => {
      clearTimeout(grace);
    });
  }

  /** Runs until a clean stop; resolves to the launcher's own exit code. */
  async run(): Promise<number> {
    for (;;) {
      if (this.#isStopping()) return 0;
      const loaded = this.#load();
      if (loaded.isErr()) {
        this.#log(`cannot start: ${loaded.error}`);
        return 1;
      }
      const state = loaded.value;
      const trial = state.trial;
      const started = performance.now();
      const child = this.#start(trial?.version ?? state.current);
      let waited: Waited = "exited";
      let code: number | null = null;
      if (child !== undefined) {
        waited = await this.#wait(child, trial, started);
        if (waited === "healthy") {
          const ended = this.#trialPassed(trial);
          if (ended.isErr()) this.#log(`the trial's end was not saved: ${ended.error.message}`);
          waited = "exited";
        } else if (waited === "timeout") {
          await this.#terminate(child);
        }
        code = await child.exited;
        this.#child = undefined;
      }
      const ranMs = performance.now() - started;
      if (this.#isStopping()) return 0;
      if (trial !== null && waited === "timeout") {
        this.#rollback(trial, "the new version did not record update_healthy in time");
      } else if (trial !== null && this.#onTrial()) {
        if (code === 0) return 0;
        this.#rollback(
          trial,
          child === undefined
            ? "the new version could not start"
            : `the new version exited with ${String(code)}`,
        );
      } else {
        if (code === 0) return 0;
        // A switch (70 after `switch.json`): the new version at once, on trial.
        if (this.#switch(state)) continue;
        const next = this.#backoff.after({ code, ranMs });
        if (next.kind === "stop") return 0;
        this.#afterExit(code, ranMs, next, child === undefined);
        await this.#sleep(next.afterMs);
        continue;
      }
      // A rollback: the old version at once, then under the normal restarts.
    }
  }

  /**
   * A failure is logged to the system's log; after the third in a row ‡, `launcher-status.json` in
   * the data folder says since when, how many, the last exit code and the end of `fatal.log`,
   * which `hsn status` shows when the hub does not answer. A run of a minute removes it.
   */
  #afterExit(
    code: number | null,
    ranMs: number,
    next: Extract<Next, { readonly kind: "restart" }>,
    couldNotStart: boolean,
  ): void {
    const rules = this.#options.rules ?? LAUNCHER;
    if (ranMs >= rules.failingWithinMs) {
      this.#failingSinceMs = undefined;
      const removed = removePath(join(this.#options.dataDir, STATUS_FILE));
      if (removed.isErr()) this.#log(`${STATUS_FILE} not removed: ${removed.error.message}`);
    }
    const what = couldNotStart ? "could not start" : `exited with ${String(code)}`;
    this.#log(`the hub ${what}; again in ${next.afterMs} ms`);
    if (!next.failure) return;
    this.#failingSinceMs ??= Date.now();
    this.#systemLog(`HSN Hub: the hub ${what} (failure ${next.failures} in a row)`);
    if (next.failures < STATUS_AFTER_FAILURES) return;
    const status: LauncherStatus = {
      failingSinceMs: this.#failingSinceMs,
      failures: next.failures,
      lastExitCode: code,
      fatalLog: fatalTail(this.#options.dataDir),
    };
    const written = writeDurably(
      join(this.#options.dataDir, STATUS_FILE),
      `${JSON.stringify(status)}\n`,
    );
    if (written.isErr()) this.#log(`${STATUS_FILE} not written: ${written.error.message}`);
  }

  /** Whether the state on disk still has a trial (a healthy one ended it). */
  #onTrial(): boolean {
    return this.#load()
      .map((state) => state.trial !== null)
      .unwrapOr(false);
  }

  #load(): R<LauncherState, string> {
    const text = readText(this.#paths.launcherFile);
    if (text.isErr()) return err(text.error.message);
    if (text.value !== undefined) {
      const state = parseLauncherState(text.value);
      return state === undefined ? err(`${this.#paths.launcherFile} is not valid`) : ok(state);
    }
    // No state yet (a fresh install): the one version installed.
    const versions = names(this.#paths.versions);
    if (versions.isErr()) return err(versions.error.message);
    const found = versions.value.filter(isVersionName);
    if (found.length !== 1) return err(`no launcher state, and ${found.length} versions installed`);
    const first: LauncherState = {
      current: found[0] ?? "",
      previous: null,
      trial: null,
      rolledBack: null,
    };
    const saved = this.#save(first);
    return saved.isErr() ? err(saved.error.message) : ok(first);
  }

  #save(state: LauncherState): R<void, IoError> {
    return writeDurably(this.#paths.launcherFile, `${JSON.stringify(state)}\n`).andThen(() =>
      // `current` follows the state, for `hsn` on PATH; the state is the truth.
      pointLink(this.#paths.current, join(this.#paths.versions, state.current)).orElse((error) => {
        this.#log(`current not pointed at ${state.current}: ${error.message}`);
        return ok(undefined);
      }),
    );
  }

  #start(version: string): Subprocess | undefined {
    const program = programOf(this.#paths, version, this.#options.platform);
    const command = [program, "--data", this.#options.dataDir, ...(this.#options.hubArgs ?? [])];
    const spawn = this.#options.spawn ?? defaultSpawn;
    const started = Result.fromThrowable(
      () => spawn(command, { ...process.env, [PREFIX_VARIABLE]: this.#paths.prefix }),
      (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
    )();
    if (started.isErr()) {
      this.#log(`cannot start ${program}: ${started.error}`);
      return undefined;
    }
    this.#starts += 1;
    this.#child = started.value;
    return started.value;
  }

  /** The hub's exit, or on a trial its health or the end of its 60 s. */
  async #wait(child: Subprocess, trial: Trial | null, started: number): Promise<Waited> {
    if (trial === null) {
      await child.exited;
      return "exited";
    }
    const within = this.#options.healthyWithinMs ?? UPDATES.healthyWithinMs;
    const poll = this.#options.pollMs ?? 250;
    const exited = { done: false };
    void child.exited.then(() => {
      exited.done = true;
    });
    for (;;) {
      if (this.#healthy(trial.version)) return "healthy";
      if (exited.done || this.#isStopping()) return "exited";
      if (performance.now() - started >= within) return "timeout";
      await Bun.sleep(poll);
    }
  }

  #healthy(version: string): boolean {
    const text = readText(this.#paths.healthyFile).unwrapOr(undefined);
    return text !== undefined && parseHealthyNote(text)?.version === version;
  }

  /** The new version is healthy: it stays, the old one is kept for the next rollback (section 9). */
  #trialPassed(trial: Trial | null): R<void, IoError> {
    if (trial === null) return ok(undefined);
    this.#log(`version ${trial.version} is healthy`);
    const next: LauncherState = {
      current: trial.version,
      previous: trial.from,
      trial: null,
      rolledBack: null,
    };
    return this.#save(next)
      .andThen(() => removePath(this.#paths.healthyFile))
      .andThen(() => this.#prune(next));
  }

  /** At most two versions: the current and the one before it (section 9). */
  #prune(state: LauncherState): R<void, IoError> {
    const kept = new Set([state.current, state.previous]);
    return names(this.#paths.versions).andThen((found) =>
      Result.combine(
        found
          .filter((name) => isVersionName(name) && !kept.has(name))
          .map((name) => removePath(join(this.#paths.versions, name))),
      ).map(() => undefined),
    );
  }

  /** The hub asked to switch (`switch.json`, then exit 70): the new version goes on trial. */
  #switch(state: LauncherState): boolean {
    const text = readText(this.#paths.switchFile).unwrapOr(undefined);
    if (text === undefined) return false;
    const note = parseSwitchNote(text);
    const removed = removePath(this.#paths.switchFile);
    if (removed.isErr()) this.#log(`switch.json not removed: ${removed.error.message}`);
    const to = note?.to;
    if (to === undefined || to === state.current) return false;
    if (!isFolder(join(this.#paths.versions, to)).unwrapOr(false)) {
      this.#log(`switch to ${to} refused: it is not installed`);
      return false;
    }
    const copies = this.#copies();
    if (copies.isErr()) {
      this.#log(`switch to ${to} refused: ${copies.error.message}`);
      return false;
    }
    const removedHealthy = removePath(this.#paths.healthyFile);
    if (removedHealthy.isErr())
      this.#log(`healthy.json not removed: ${removedHealthy.error.message}`);
    const trial: LauncherState = {
      current: to,
      previous: state.current,
      trial: { version: to, from: state.current, copiesBefore: copies.value },
      rolledBack: null,
    };
    const saved = this.#save(trial);
    if (saved.isErr()) {
      this.#log(`switch to ${to} refused: ${saved.error.message}`);
      return false;
    }
    this.#log(`switching from ${state.current} to ${to}`);
    return true;
  }

  /** The pre-migration copies in the data folder now (HD 6, "Migrations"). */
  #copies(): R<readonly CopySeen[], IoError> {
    return names(this.#options.dataDir).andThen((found) =>
      Result.combine(
        found
          .filter((name) => name.startsWith(BEFORE_PREFIX))
          .map((name) =>
            stamp(join(this.#options.dataDir, name)).map((s) =>
              s === undefined ? undefined : { name, mtimeMs: s.mtimeMs, size: s.size },
            ),
          ),
      ).map((all) => all.filter((c): c is CopySeen => c !== undefined)),
    );
  }

  /**
   * Back to the old version (section 9, step 5): the new version's pre-migration copy put back
   * when it made one, losing only what the failed start wrote, then `current` pointed back.
   */
  #rollback(trial: Trial, reason: string): void {
    this.#log(`rolling back from ${trial.version} to ${trial.from}: ${reason}`);
    const restored = this.#restoreCopy(trial.copiesBefore);
    if (restored.isErr())
      this.#log(`the database copy was not put back: ${restored.error.message}`);
    const back: LauncherState = {
      current: trial.from,
      previous: null,
      trial: null,
      rolledBack: { from: trial.version, reason },
    };
    const saved = this.#save(back);
    if (saved.isErr()) this.#log(`the rollback was not saved: ${saved.error.message}`);
  }

  #restoreCopy(before: readonly CopySeen[]): R<void, IoError> {
    return this.#copies().andThen((now) => {
      const fresh = now
        .filter(
          (c) =>
            !before.some((b) => b.name === c.name && b.mtimeMs === c.mtimeMs && b.size === c.size),
        )
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs)[0];
      if (fresh === undefined) return ok(undefined);
      const db = join(this.#options.dataDir, DATABASE);
      this.#log(`putting back ${fresh.name}`);
      // The write-ahead log and its index belong to the migrated database: never replayed onto the copy.
      return removePath(`${db}-wal`)
        .andThen(() => removePath(`${db}-shm`))
        .andThen(() => copyDurably(join(this.#options.dataDir, fresh.name), db));
    });
  }

  async #terminate(child: Subprocess): Promise<void> {
    child.kill("SIGTERM");
    const killed = setTimeout(() => {
      child.kill("SIGKILL");
    }, this.#options.stopGraceMs ?? 15_000);
    await child.exited;
    clearTimeout(killed);
  }

  /** Waits `ms`, or less when the launcher is stopped. */
  async #sleep(ms: number): Promise<void> {
    if (this.#stopping || ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = undefined;
        resolve();
      }, ms);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve();
      };
    });
  }
}
