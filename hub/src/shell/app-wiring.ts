/**
 * The hub's M2 wiring (m2-design.md section 11, "Step 1, wave 2" and step 2): the app keys and the
 * certificate after the signing keys, the app channel and its two listeners, the uploads, the file
 * jobs and the healthy mark, as `main.ts` puts them together. Each piece is its owner's; this file
 * only joins them, in the order the design gives:
 *
 * 1. `ensureAppKeys` after `ensureHubKeys`, so the snapshot's `appKeys` names the static key the
 *    channel uses; the certificate names every address the computer has on the home network, its
 *    host name and `<host>.local` (section 5).
 * 2. The boot event, then `startupInputs` (the hub's facts and the time zone) before any listener
 *    opens, and again when an address changes, with the certificate renewed for the new names.
 * 3. The listeners, the channel given the loop's `enqueue` and a view of the core's state.
 * 4. The healthy mark (`healthy.json`) once a commit has held `update_healthy` and the listeners
 *    are open (section 9, step 4).
 */
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { type AppOpBody, LISTENER_PORTS, x25519StaticKey } from "@hsn/protocol/app";
import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "neverthrow";
import type { AuditRecord } from "../core/model/audit.ts";
import type { FileWork } from "../core/model/effects.ts";
import type { HubError } from "../core/model/errors.ts";
import type { FileOutcome, HubEvent } from "../core/model/events.ts";
import type { ConnId, JobId } from "../core/model/ids.ts";
import type { HubRules } from "../core/model/rules.ts";
import type { HubState } from "../core/model/state.ts";
import { stagingJob, switchBlockedBy } from "../core/upkeep/view.ts";
import type { Writer } from "../ports/writer.ts";
import { hostNames } from "./app/addresses.ts";
import { type AppKeyMaterial, ensureAppKeys, type RandomBytes } from "./app/app-keys.ts";
import type { CertificateNames } from "./app/certificate.ts";
import { AppChannel, ConnIds } from "./app/channel.ts";
import { MemoryClientKeys } from "./app/client-keys.ts";
import { coreView, startupInputs, systemTimeZone } from "./app/facts.ts";
import { MemoryLinkSecrets } from "./app/link-secrets.ts";
import { AppListeners } from "./app/listeners.ts";
import { loadPolicy } from "./app/policy.ts";
import { StaticFiles } from "./app/static-files.ts";
import { UploadStore } from "./app/uploads.ts";
import { startJob } from "./backup/jobs.ts";
import { exists } from "./backup/files.ts";
import { homeAddresses, HUB_VERSION } from "./hub-facts.ts";
import type { ChannelEffect, JobStarted } from "./loop.ts";
import { healthyIn, markHealthy, prefixFrom } from "./update/notes.ts";
import { type HistorySource, historyReply } from "./history-page.ts";

/** The control socket's side of a download (`UnixControlServer`'s `has` and `download`). */
export interface DownloadLines {
  has(conn: ConnId): boolean;
  download(
    conn: ConnId,
    line:
      | { readonly fileChunk: AppOpBody<"fileChunk"> }
      | { readonly fileFailed: { readonly job: number; readonly reason: "io" | "stopping" } },
  ): boolean;
}

/** Where the program's own files are: the migrations and the web build (section 9's layout). */
export interface ProgramPaths {
  readonly migrations: string;
  readonly web: string;
}

/**
 * The migrations and the web build beside a compiled program (`versions/<v>/bin/hsn-hub`, with
 * `../drizzle` and `../web`, `packaging/shared/build-program.ts`), else the source tree's
 * (`hub/drizzle`, `app/dist`).
 */
export function programPaths(execPath: string, sourceDir: string): ProgramPaths {
  const installed = join(dirname(execPath), "..");
  if (exists(join(installed, "drizzle", "meta", "_journal.json")))
    return { migrations: join(installed, "drizzle"), web: join(installed, "web") };
  const hub = join(sourceDir, "..", "..");
  return { migrations: join(hub, "drizzle"), web: join(hub, "..", "app", "dist") };
}

/** The certificate's names: the computer's addresses on the home network, its host names. */
export function certificateNames(addresses: readonly string[]): CertificateNames {
  return { dns: hostNames(hostname()), ips: addresses };
}

/** The ports of the two app listeners: 8444 and 8445 ‡ (section 5), 0 for any (tests). */
export interface AppPorts {
  readonly lan: number;
  readonly console: number;
}

export const DEFAULT_APP_PORTS: AppPorts = {
  lan: LISTENER_PORTS.lan,
  console: LISTENER_PORTS.console,
};

/** What the app wiring needs from `main.ts`. */
export interface AppWiringOptions {
  readonly dataDir: string;
  readonly db: Database;
  readonly writer: Pick<Writer, "stage" | "flush">;
  readonly random: RandomBytes;
  readonly nowMs: () => number;
  readonly rules: HubRules;
  readonly paths: ProgramPaths;
  readonly ports: AppPorts;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The writer's status, for `hub.status` (`hubStatusRead`). */
  readonly writerStatus: () => {
    readonly lastCommitMs: number | null;
    readonly stagedItems: number;
    readonly databaseBytes: number | null;
    readonly historyShortened: boolean;
  };
  readonly report: (error: HubError) => void;
  /** `history.query`'s pages: the committed rows and the writer's staged records (section 7). */
  readonly history: HistorySource;
  /**
   * The publisher keys a release must be signed by: `PUBLISHER_KEYS`, passed by `main.ts`'s own
   * entry; a test's entry passes `TEST_PUBLISHER_KEY` (section 9, "Hub updates").
   */
  readonly publisherKeys: readonly Uint8Array[];
}

/** The keys and the stores made before the boot event. */
export interface AppStart {
  readonly material: AppKeyMaterial;
  readonly names: CertificateNames;
  readonly addresses: readonly string[];
  readonly clientKeys: MemoryClientKeys;
  readonly linkSecrets: MemoryLinkSecrets;
  readonly uploads: UploadStore;
  readonly connIds: ConnIds;
}

/** Step 1: the app keys and the certificate, the client keys from the snapshot, the uploads emptied. */
export function startApp(
  options: AppWiringOptions,
  clients: ConstructorParameters<typeof MemoryClientKeys>[0],
): Result<AppStart, HubError> {
  const addresses = homeAddresses();
  const names = certificateNames(addresses);
  const material = ensureAppKeys(
    options.db,
    options.writer,
    names,
    options.nowMs(),
    options.random,
  );
  if (material.isErr()) return err(material.error);
  const uploads = new UploadStore(options.dataDir);
  const cleared = uploads.clearAll();
  if (cleared.isErr()) return err(cleared.error);
  return ok({
    material: material.value,
    names,
    addresses,
    clientKeys: new MemoryClientKeys(clients),
    linkSecrets: new MemoryLinkSecrets(),
    uploads,
    connIds: new ConnIds(),
  });
}

/**
 * The inputs after `boot` (step 2), from the material as it is and the ports the listeners really
 * opened, the system's choice included (`--app-ports 0,0`).
 */
export function inputsAfterBoot(
  start: { readonly addresses: readonly string[]; readonly material: AppKeyMaterial },
  ports: { readonly lan: number; readonly console: number },
): readonly HubEvent[] {
  return startupInputs(
    start.addresses,
    start.material.certificate.sha256,
    systemTimeZone(),
    ports.lan,
    ports.console,
  );
}

/** `fileFailed`'s line for a job. */
function failed(
  job: number,
  reason: "io" | "stopping",
): { readonly fileFailed: { readonly job: number; readonly reason: "io" | "stopping" } } {
  return { fileFailed: { job, reason } };
}

/** The running app side: the channel, the listeners, the file jobs and the healthy mark. */
export class AppSide {
  readonly channel: AppChannel;
  readonly #options: AppWiringOptions;
  readonly #start: AppStart;
  readonly #state: () => HubState;
  #listeners: AppListeners | undefined;
  #material: AppKeyMaterial;
  #names: CertificateNames;
  #addresses: readonly string[];
  #healthy: string | undefined;
  #marked = false;
  /** The control socket, for a download asked for on it (`hsn backup export`). */
  #control: DownloadLines | undefined;

  private constructor(
    options: AppWiringOptions,
    start: AppStart,
    state: () => HubState,
    channel: AppChannel,
  ) {
    this.#options = options;
    this.#start = start;
    this.#state = state;
    this.channel = channel;
    this.#material = start.material;
    this.#names = start.names;
    this.#addresses = start.addresses;
  }

  /** Step 3: the channel, given the loop's `enqueue` and the core's state. */
  static make(
    options: AppWiringOptions,
    start: AppStart,
    state: () => HubState,
    enqueue: (event: HubEvent) => void,
  ): Result<AppSide, HubError> {
    const key = x25519StaticKey(start.material.staticPrivate);
    if (!key.ok)
      return err({ kind: "crypto", origin: ORIGIN, message: "the hub's app key is not a key" });
    const channel = new AppChannel({
      staticKey: key.value,
      identity: start.material.identity,
      hubVersion: HUB_VERSION,
      clientKeys: start.clientKeys,
      linkSecrets: start.linkSecrets,
      core: coreView(state),
      emit: enqueue,
      connIds: start.connIds,
      hubStatus: () => ({ ...options.writerStatus(), missingAfterRestartMs: null }),
      uploads: start.uploads,
      report: options.report,
      refused: enqueue,
      wasRemoved: (staticKey) => start.clientKeys.wasRemoved(staticKey),
      // An export has no file to free (it is sealed in memory): a session that closed part way
      // is told to standard error, its job ends at its next piece, whose send fails, and the
      // app, which never saw the end mark, saves nothing (section 6).
      downloadEnded: (conn, job) => {
        options.report({
          kind: "storage",
          origin: ORIGIN,
          message: `export job ${String(job)} ended part way: connection ${String(conn)} closed`,
        });
      },
    });
    return ok(new AppSide(options, start, state, channel));
  }

  /**
   * The listeners open, then, in the same synchronous run, the hub's facts and time zone with the
   * ports they really hold, then the healthy mark if one waits (section 2). Bun binds and listens
   * in one call, so a connection can arrive before the facts are queued; but nothing it does runs
   * until this run ends (one thread): it waits in the system's accept queue, and every input it
   * causes is queued after the facts, so no client is served by a core without them.
   */
  open(enqueue: (event: HubEvent) => void): Result<void, HubError> {
    const policy = loadPolicy(this.#options.paths.web);
    if (policy.isErr()) return err(policy.error);
    const listeners = AppListeners.open({
      channel: this.channel,
      files: new StaticFiles(this.#options.paths.web),
      policy: policy.value,
      lan: { port: this.#options.ports.lan, tls: this.#material.tls, names: this.#names },
      console: { port: this.#options.ports.console },
    });
    if (listeners.isErr()) {
      // No listener, so no client: the core still needs the time zone, and the facts with it.
      for (const input of inputsAfterBoot(
        { addresses: this.#addresses, material: this.#material },
        this.#options.ports,
      ))
        enqueue(input);
      return err(listeners.error);
    }
    this.#listeners = listeners.value;
    this.#sendFacts(this.#material, enqueue);
    this.#markIfHealthy();
    return ok(undefined);
  }

  /** The facts and the time zone, with the listeners' real ports; none before they are open. */
  #sendFacts(material: AppKeyMaterial, enqueue: (event: HubEvent) => void): void {
    const lan = this.#listeners?.lanPort;
    const console = this.#listeners?.consolePort;
    if (lan === undefined || console === undefined) return;
    for (const input of inputsAfterBoot({ addresses: this.#addresses, material }, { lan, console }))
      enqueue(input);
  }

  /** The control socket, once open: a download asked for on it goes back on it. */
  useControl(control: DownloadLines): void {
    this.#control = control;
  }

  get lanPort(): number | undefined {
    return this.#listeners?.lanPort;
  }

  get consolePort(): number | undefined {
    return this.#listeners?.consolePort;
  }

  /**
   * The computer's addresses, looked at every minute ‡: when they changed, the certificate is
   * renewed for the new names, the listener takes it, and the core is told the facts again.
   */
  addressesChanged(enqueue: (event: HubEvent) => void): void {
    const now = homeAddresses();
    if (now.join(",") === this.#addresses.join(",")) return;
    this.#addresses = now;
    this.#names = certificateNames(now);
    const material = ensureAppKeys(
      this.#options.db,
      this.#options.writer,
      this.#names,
      this.#options.nowMs(),
      this.#options.random,
    );
    if (material.isErr()) {
      this.#options.report(material.error);
      return;
    }
    this.#material = material.value;
    const taken = this.#listeners?.useCertificate(material.value.tls, this.#names);
    if (taken?.isErr() === true) this.#options.report(taken.error);
    this.#sendFacts(material.value, enqueue);
  }

  /** The loop's channel effects; a history page the shell reads and answers itself (section 7). */
  perform(effect: ChannelEffect): void {
    if (effect.kind !== "historyRead") {
      this.channel.perform(effect);
      return;
    }
    const reply = historyReply(this.#options.history, effect);
    this.channel.perform({ kind: "appSend", conn: effect.conn, message: reply.message });
    if (reply.error !== undefined) this.#options.report(reply.error);
  }

  /**
   * A turn's file job, after its commit and its answers (section 9): done at once, or in pieces
   * the loop continues between turns (section 3, "Jobs in pieces, the loop's contract"), staging
   * and an export being A8's pieces behind `startJob`.
   */
  job(job: JobId, work: FileWork): JobStarted {
    const state = this.#state;
    const uploads = this.#start.uploads;
    const started = startJob(job, work, {
      db: this.#options.db,
      dataDir: this.#options.dataDir,
      migrationsFolder: this.#options.paths.migrations,
      rules: this.#options.rules,
      uploads: { pathOf: (ref) => uploads.finished(ref)?.path },
      exports: {
        // After the reply `{job}` (the loop runs jobs after the turn's answers), on the connection
        // that asked: `fileChunk` lines on the control socket, `fileChunk` events on a session.
        send: (conn, chunk) => this.#download(conn, { fileChunk: chunk }),
      },
      prefix: prefixFrom(this.#options.env),
      switchBlockedBy: () => switchBlockedBy(state()),
      stagingWanted: (staging) => stagingJob(state()) === staging,
      publisherKeys: this.#options.publisherKeys,
      // A history export begins after what is staged is flushed, as `hsn log` does (section 7).
      flush: () => this.#options.writer.flush("log").mapErr((e) => e.message),
      nowMs: this.#options.nowMs,
      salt: () => this.#options.random(8).mapErr((e) => e.message),
    });
    if (started.kind !== "pieces") return started;
    const pieces = started.pieces;
    return {
      kind: "pieces",
      pieces: {
        next: () => {
          const outcome = pieces.next();
          return outcome === undefined ? { done: false } : { done: true, outcome };
        },
        // A stop: the job's temporary files go, and an export's connection is told (section 6).
        abort: () => {
          pieces.abort("the hub is stopping");
          if (work.kind === "export")
            this.#ignore(this.#download(work.conn, failed(job, "stopping")));
        },
      },
    };
  }

  /**
   * A job's end, however it ended (section 3): its upload freed, the restore's after it is applied
   * (its header read comes first, so only a read that failed frees it), the release once staged;
   * and an export that failed ends with `fileFailed` where its chunks were going (section 6).
   */
  ended(job: JobId, work: FileWork, outcome: FileOutcome | undefined): void {
    const uploads = this.#start.uploads;
    if (work.kind === "applyRestore" || work.kind === "stageUpdate") uploads.release(work.upload);
    if (work.kind === "readRestore" && outcome?.kind !== "restoreRead")
      uploads.release(work.upload);
    if (work.kind === "export" && outcome?.kind === "failed")
      this.#ignore(this.#download(work.conn, failed(job, "io")));
  }

  /** A download line to a connection that may be gone: nothing more to tell anyone. */
  #ignore(sent: Result<void, string>): void {
    sent.match(
      () => undefined,
      () => undefined,
    );
  }

  /** One line of a download on the connection that asked: the control socket's, or a session's. */
  #download(
    conn: ConnId,
    line:
      | { readonly fileChunk: AppOpBody<"fileChunk"> }
      | { readonly fileFailed: { readonly job: number; readonly reason: "io" | "stopping" } },
  ): Result<void, string> {
    if (this.#control?.has(conn) === true) {
      return this.#control.download(conn, line)
        ? ok(undefined)
        : err("the control connection is gone");
    }
    // A session's download leaves through the channel's one send queue, after the reply `{job}`.
    return this.channel.download(conn, line);
  }

  /** Each commit's records: an `update_healthy` waits for the listeners, then is marked once. */
  committed(records: readonly AuditRecord[]): void {
    const version = healthyIn(records);
    if (version === undefined) return;
    this.#healthy = version;
    this.#markIfHealthy();
  }

  #markIfHealthy(): void {
    if (this.#marked || this.#healthy === undefined || this.#listeners === undefined) return;
    this.#marked = true;
    const marked = markHealthy(prefixFrom(this.#options.env), this.#healthy);
    if (marked.isErr())
      this.#options.report({ kind: "storage", origin: ORIGIN, message: marked.error });
  }

  stop(): void {
    this.channel.stop();
    this.#listeners?.stop();
  }
}

const ORIGIN = "shell/app-wiring";
