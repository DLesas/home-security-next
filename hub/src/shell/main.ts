#!/usr/bin/env bun
/**
 * The hub's process (hub-design.md sections 4, 7 and 10): `bun hub/src/shell/main.ts [--data
 * <folder>] [--port <n>] [--serial <path>]… [--no-usb-watch]`, or with `--bench-lockstep
 * <socket>` the bench's lockstep mode (section 11, `lockstep/wire.ts`).
 *
 * At start, in order (section 7, "Hub restart"): the data folder and the storage (migrations,
 * section 5's settings, the snapshot, how the last run ended); the hub's signing keys, made and
 * committed at the first start, before the boot event reads them (section 9); the key store from
 * `device_keys`; the wall clock's trust floor from the last commit mark (section 5); the boot
 * event; then the links (serial ports, the `/device` WebSocket), the control socket and mDNS.
 *
 * The top-level handler (section 10): an uncaught exception or unhandled rejection is written to
 * `fatal.log`, standard error and, if the database works, `hub_events`, and the hub exits with
 * code 71 for the launcher or the service manager to restart it (HB20); 70 means only "restart
 * me", after a switch (m2-design.md section 9). SIGINT and SIGTERM stop it cleanly: the
 * last commit carries the clean-stop mark. This file and `shell/safe/` are where `try` and
 * `throw` may appear (section 10); this one needs neither.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { makeCalendar } from "./calendar/calendar.ts";
import { ADDRESS_CHECK_MS, homeAddresses, HUB_VERSION } from "./hub-facts.ts";
import { defaultRelayUrl, DEPLOYMENT } from "@hsn/deployment";
import { x25519StaticKey } from "@hsn/protocol/app";
import { REAL_TIMERS } from "./app/channel.ts";
import { RelayClient } from "./relay/client.ts";
import { MemoryPushKeys } from "./relay/push-keys.ts";
import { hubReleaseWanted, newestFirmware } from "./relay/releases.ts";
import { platformOf } from "./update/release.ts";
import { type AppPorts, AppSide, DEFAULT_APP_PORTS, programPaths, startApp } from "./app-wiring.ts";
import { LAUNCHER } from "./m2-values.ts";
import { okAsync } from "neverthrow";
import { dataFolder, socketPath } from "../../cli/paths.ts";
import { deviceByName } from "../core/registry/view.ts";
import { nextRecordSeq } from "../core/audit/view.ts";
import type { HubError } from "../core/model/errors.ts";
import { HUB_DEVICE } from "../core/model/ids.ts";
import { DEFAULT_RULES } from "../core/model/rules.ts";
import type { Mono } from "../core/model/time.ts";
import { MODULES, makeCore } from "../core/step.ts";
import { bonjourLibrary, MdnsAdvertiser } from "./advertise/mdns.ts";
import { ensureHubKeys } from "./advertise/hub-keys.ts";
import { KeyStoreCipher } from "./cipher/device-cipher.ts";
import { SystemClock } from "./clock/system-clock.ts";
import {
  HUB_BUILD_TIME_MS,
  probeFor,
  SystemTimeTrust,
  systemScheduler,
} from "./clock/time-trust.ts";
import { UnixControlServer } from "./control/server.ts";
import { HubLoop } from "./loop.ts";
import { runLockstep } from "./lockstep/wire.ts";
import { retryWaitingRestore } from "./backup/restore.ts";
import { createTopFolderIfMissing } from "./control/windows.ts";
import { WINDOWS_CALLS } from "./safe/control-socket-windows.ts";
import { switchAfterAnnouncing } from "./update/announce.ts";
import { prefixFrom } from "./update/notes.ts";
import { PUBLISHER_KEYS } from "./update/publisher-keys.ts";
import { checkStore, indexedImages } from "./firmware/store.ts";
import { TransferServer } from "./firmware/serve.ts";
import { sendSession } from "./firmware/session.ts";
import { LinkRegistry } from "./links/registry.ts";
import { SerialLinks } from "./links/serial.ts";
import { UsbWatch, type UsbWatchOptions } from "./links/usb-watch.ts";
import { WINDOWS_SERIAL } from "./safe/serial-windows.ts";
import { serveDevices } from "./links/websocket.ts";
import { randomBytes } from "./safe/crypto.ts";
import { tightenContents, writeStandardError } from "./safe/fs.ts";
import { closeDatabase, sqlite } from "./safe/sqlite.ts";
import { FATAL_EXIT_CODE, recordUncaught } from "./storage/fatal.ts";
import { MemoryKeyStore } from "./storage/keys.ts";
import { openStore, type OpenedStore } from "./storage/store.ts";

const ORIGIN = "shell/main";
/** The app port devices connect to (§10); 8443 ‡ until the apps' server settles it. */
export const DEFAULT_PORT = 8443;
/** Exit code of a clean stop. */
const EXIT_CLEAN = 0;
/** Exit code when the hub cannot start (a refused database, a folder it cannot use). */
const EXIT_CANNOT_START = 78;

export interface MainOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly serial: readonly string[];
  readonly watchUsb: boolean;
  /** `--bench-lockstep <socket>`: the controller's socket (section 11); undefined otherwise. */
  readonly lockstep: string | undefined;
  /** `--app-ports <lan>,<console>`: the two app listeners (m2-design.md section 5), 0 for any. */
  readonly appPorts: AppPorts;
}

/** The command line, as `MainOptions`, or the problem with it. */
export function parseMainArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): MainOptions | string {
  let data: string | undefined;
  let port = DEFAULT_PORT;
  const serial: string[] = [];
  let watchUsb = true;
  let lockstep: string | undefined;
  let appPorts = DEFAULT_APP_PORTS;
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    const value = argv[i + 1];
    switch (word) {
      case "--data":
        if (value === undefined) return "--data needs a folder";
        data = value;
        i++;
        break;
      case "--port":
        if (value === undefined || !/^\d+$/u.test(value)) return "--port needs a number";
        port = Number(value);
        i++;
        break;
      case "--serial":
        if (value === undefined) return "--serial needs a path";
        serial.push(value);
        i++;
        break;
      case "--no-usb-watch":
        watchUsb = false;
        break;
      case "--app-ports": {
        const ports = /^(\d+),(\d+)$/u.exec(value ?? "");
        if (ports === null) return "--app-ports needs <lan>,<console>";
        appPorts = { lan: Number(ports[1]), console: Number(ports[2]) };
        i++;
        break;
      }
      case "--bench-lockstep":
        if (value === undefined) return "--bench-lockstep needs a socket path";
        lockstep = value;
        i++;
        break;
      default:
        return `unknown option ${word ?? ""}`;
    }
  }
  const dataDir = dataFolder(data, env);
  if (dataDir === undefined) return "no data folder: give --data or set HSN_DATA_DIR";
  return { dataDir, port, serial, watchUsb, lockstep, appPorts };
}

function say(message: string): void {
  writeStandardError({ kind: "internal", origin: ORIGIN }, `hub: ${message}\n`).match(
    () => undefined,
    () => undefined,
  );
}

/**
 * What the hub trusts, given by the program that starts it and by nothing it reads: no option,
 * environment variable or file. The product's entry below passes the compiled-in
 * `PUBLISHER_KEYS`; only a test's own entry file, in a test's folder, passes the tests' key
 * (section 9; `test/unit/shell-main/hub-with-test-key.ts`).
 */
export interface HubTrust {
  readonly publisherKeys: readonly Uint8Array[];
  /**
   * The wall clock taken as synchronised without asking the system (section 5's probe skipped),
   * as macOS and Windows always are. Only a test's own entry says it (`test/world/hub-entry.ts`):
   * a test machine's Linux need not run systemd-timesyncd, whose mark the probe looks for, and
   * an untrusted clock refuses exports, backups and schedules. The product's entries never do.
   */
  readonly clockSynchronised?: true;
}

/**
 * Every file the hub's process makes is its account's alone from the start (section 9, "The
 * privilege boundary"): SQLite's database, log and index included, so the start's tightening
 * finds nothing new. Set by each entry that runs the hub as a process (below, and
 * `hub/packaging/shared/program.ts`), never by `runHub`, which tests call in their own process.
 * macOS and Linux; Windows' folders inherit their lists (A11).
 */
export function hubUmask(): void {
  if (process.platform !== "win32") process.umask(0o077);
}

/** Runs the hub until it is stopped; resolves to the exit code. */
export async function runHub(
  options: MainOptions,
  trusted: HubTrust,
  /** Test entry points can supply their own USB byte stream and discovery fixtures. */
  serialFixture?: {
    readonly open: NonNullable<ConstructorParameters<typeof SerialLinks>[1]>;
    readonly watch: Pick<UsbWatchOptions, "folders" | "list">;
  },
): Promise<number> {
  const rules = DEFAULT_RULES;
  const trust = new SystemTimeTrust({
    probe: trusted.clockSynchronised === true ? undefined : probeFor(process.platform),
    scheduler: systemScheduler,
    wall: () => Date.now(),
    notBeforeMs: HUB_BUILD_TIME_MS,
    onProbeFailed: (error: HubError) => {
      say(error.message);
    },
  });
  const clock = new SystemClock(trust);
  const keysHolder: {
    keys: MemoryKeyStore | undefined;
    clients:
      { applyCommitted(ops: Parameters<MemoryKeyStore["applyCommitted"]>[0]): void } | undefined;
  } = { keys: undefined, clients: undefined };
  // Beside the compiled program, or the source tree's (section 9's layout).
  const paths = programPaths(process.execPath, import.meta.dir);
  // Windows, before anything makes the data folder: an administrator's run by hand creates a
  // missing one with its list from the first moment; as the service it makes nothing (A11,
  // section 9, "The top folders"). The storage would otherwise make it with an inherited list.
  if (process.platform === "win32") {
    const made = createTopFolderIfMissing(options.dataDir, WINDOWS_CALLS);
    if (made.isErr()) say(made.error.message);
  }
  // "A swap that did not happen" (section 9): a restored database still waiting is put in place
  // now, before the store opens the database and before any migration of the old one, so the
  // start goes on with the restored database (its restore mark makes `upkeep` record `restored`
  // once), or, refused again, on the old one, with `restore_waiting` raised once the core runs.
  const retried = retryWaitingRestore(options.dataDir);
  if (retried.kind === "refused")
    say(`a restore is waiting and could not be put in place: ${retried.reason}`);
  const opened = openStore({
    dataDir: options.dataDir,
    migrationsFolder: paths.migrations,
    clock,
    rules,
    platform: process.platform,
    onCommitted: (ops) => {
      keysHolder.keys?.applyCommitted(ops);
      keysHolder.clients?.applyCommitted(ops);
    },
  });
  if (opened.isErr()) {
    say(`cannot start: ${opened.error.message}`);
    return EXIT_CANNOT_START;
  }
  const store: OpenedStore = opened.value;
  // The hub tightens its own trees' contents at every start, as itself (section 9, "The privilege
  // boundary"): nothing inside the data folder or the program tree open to the group or others,
  // no link followed. The program tree is the one the launcher names (`HSN_PROGRAM`); run by hand
  // there is none, and nothing of it is checked or warned of.
  const programTree = prefixFrom(process.env);
  if (process.platform !== "win32") {
    for (const tree of [options.dataDir, ...(programTree === undefined ? [] : [programTree])]) {
      const tightened = tightenContents({ kind: "storage", origin: ORIGIN }, tree);
      if (tightened.isErr()) say(tightened.error.message);
      else if (tightened.value > 0) say(`tightened ${String(tightened.value)} entries in ${tree}`);
    }
  }
  const fatalContext = (loop: HubLoop | undefined) => ({
    dataDir: options.dataDir,
    boot: store.boot.id,
    now: () => clock.now(),
    db: store.db,
    statements: store.statements,
    nextSeq: () => (loop === undefined ? undefined : nextRecordSeq(loop.state)),
  });

  // The hub's keys before the boot event reads them (section 9).
  const hubKeys = await ensureHubKeys(store.snapshot.hubKeys, store.writer);
  if (hubKeys.isErr()) {
    say(`cannot make the hub's keys: ${hubKeys.error.message}`);
    return EXIT_CANNOT_START;
  }
  // The app keys and the certificate, after the signing keys whose row they share (m2-design.md
  // section 11, "Step 1, wave 2").
  const appOptions = {
    dataDir: options.dataDir,
    db: store.db,
    writer: store.writer,
    random: (length: number) => randomBytes(length, ORIGIN),
    nowMs: () => Date.now(),
    rules,
    paths,
    ports: options.appPorts,
    env: process.env,
    writerStatus: () => ({
      lastCommitMs: store.writer.lastCommitMs ?? null,
      stagedItems: store.writer.staged,
      databaseBytes: store.writer.inUseBytes ?? null,
      historyShortened: store.writer.trimming,
    }),
    report: (error: HubError) => {
      say(`${error.origin}: ${error.message}`);
    },
    publisherKeys: trusted.publisherKeys,
    history: {
      rows: (page: Parameters<typeof store.reader.historyRows>[0]) =>
        store.reader.historyRows(page),
      staged: () => store.writer.stagedRecords(),
    },
  };
  const app = startApp(appOptions, store.snapshot.m2.clients);
  if (app.isErr()) {
    say(`cannot make the hub's app keys: ${app.error.message}`);
    return EXIT_CANNOT_START;
  }
  keysHolder.clients = app.value.clientKeys;
  const snapshot = {
    ...store.snapshot,
    hubKeys: hubKeys.value,
    m2: { ...store.snapshot.m2, appKeys: { appStaticPublic: app.value.material.staticPublic } },
  };
  const keys = MemoryKeyStore.load(store.db);
  if (keys.isErr()) {
    say(`cannot read the device keys: ${keys.error.message}`);
    return EXIT_CANNOT_START;
  }
  keysHolder.keys = keys.value;
  // Calendar arithmetic over Bun's built-in Temporal (m2-design.md section 2).
  const calendar = makeCalendar();
  if (calendar.isErr()) {
    say(`cannot start the calendar: ${calendar.error.message}`);
    return EXIT_CANNOT_START;
  }

  // The wall clock is untrusted while it reads earlier than the last commit mark (section 5).
  const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
  if (mark !== undefined) trust.setFloor(mark.lastSeenMs);
  trust.start();

  // The firmware store's check (m3-updates-design section 4), before the hub listens: what no
  // live row names is deleted, and each indexed image whose file is missing or wrong is told to
  // the core after the boot event.
  const firmwareStore = indexedImages(store.db).andThen((rows) =>
    checkStore(options.dataDir, rows).mapErr((error) => error.message),
  );
  if (firmwareStore.isErr()) say(`the firmware store could not be checked: ${firmwareStore.error}`);

  // The `/device` WebSocket first, so the port mDNS advertises is the one it serves (§10).
  const registry = new LinkRegistry();
  // Firmware transfers on granted links are answered by the shell (m3-updates-design section 5).
  const transfers = new TransferServer({
    dataDir: options.dataDir,
    send: (link, bytes) => registry.sendTransfer(link, bytes),
    emit: (event) => {
      holder.loop?.enqueue(event);
    },
    // Each frame's answer holds the hub's one thread as a turn does (m2-design.md section 3).
    stopwatch: () => performance.now(),
  });
  registry.serveTransfers(transfers);
  const devices = serveDevices(registry, options.port);
  const servedPort = devices.port ?? options.port;
  const holder: {
    loop: HubLoop | undefined;
    control: UnixControlServer | undefined;
    app: AppSide | undefined;
    relay: RelayClient | undefined;
  } = {
    loop: undefined,
    control: undefined,
    app: undefined,
    relay: undefined,
  };
  // `app` and `aid` for apps (m3-design section 2), once the apps' listener is open.
  const advertiser = new MdnsAdvertiser(
    servedPort,
    () =>
      bonjourLibrary((error) => {
        say(error.message);
      }),
    () => {
      const port = holder.app?.lanPort;
      return port === undefined ? undefined : { port, identity: app.value.material.identity };
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon = false;
  const runTurn = (): void => {
    soon = false;
    holder.loop?.turn();
  };
  /** Another turn soon: inputs wait, or a job has work (a fetched release's piece, B6). */
  const askTurn = (): void => {
    if (soon) return;
    soon = true;
    setImmediate(runTurn);
  };
  // What the loop reports beyond the core's own records goes to standard error; a failed
  // commit is in `fatal.log` already (the writer's `onFailed`) and the core records it.
  const report = (error: HubError): void => {
    say(`${error.origin}: ${error.message}`);
  };
  const exitCode: { code: number | undefined; resolve: ((code: number) => void) | undefined } = {
    code: undefined,
    resolve: undefined,
  };
  const finish = (code: number): void => {
    if (exitCode.code !== undefined) return;
    exitCode.code = code;
    exitCode.resolve?.(code);
  };
  const loop = new HubLoop(
    makeCore(MODULES),
    { cipher: new KeyStoreCipher(keys.value), rules, calendar: calendar.value, sha256 },
    {
      clock,
      random: { bytes: (length) => randomBytes(length, ORIGIN) },
      links: registry,
      control: {
        respond: (request, reply) => holder.control?.respond(request, reply),
        publish: (record) => holder.control?.publish(record),
      },
      writer: store.writer,
      advertiser,
      wakeAt: (at: Mono | undefined) => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (at === undefined) return;
        const delayMs = Math.max(0, (at - clock.now().mono) / 1000);
        timer = setTimeout(() => {
          timer = undefined;
          holder.loop?.enqueue({ kind: "tick" });
        }, delayMs);
      },
      soon: () => {
        askTurn();
      },
      report,
      fatal: (error) => {
        recordUncaught(fatalContext(holder.loop), error.origin, new Error(error.message));
        finish(FATAL_EXIT_CODE);
      },
      channel: { perform: (effect) => holder.app?.perform(effect) },
      // The relay client's effects (m4-design section 4, B6).
      relay: { perform: (effect) => holder.relay?.perform(effect) },
      files: {
        perform: (job, work) =>
          // A release fetched over the relay link, then staged as an upload is (B6).
          (work.kind === "fetchRelease" ? holder.relay?.fetch(job, work) : undefined) ??
          holder.app?.job(job, work) ?? {
            kind: "ready",
            outcome: { kind: "failed", reason: "io", message: "the hub is starting" },
          },
        ended: (job, work, outcome) => holder.app?.ended(job, work, outcome),
      },
      // A switch (`switchUpdate`, `switchRestore`): announced to the relay (at most 2 s ‡,
      // m4-design section 4), then a clean stop, the file work that waits for the database to
      // close, and exit 70 for the launcher (section 9); unless a stop came meanwhile.
      restart: (afterStop, reason) => {
        void switchAfterAnnouncing(holder.relay, reason, REAL_TIMERS, () => {
          if (exitCode.code !== undefined) return;
          stopCleanly();
          const after = afterStop();
          if (after.isErr()) say(`the switch's last step failed: ${after.error}`);
          finish(LAUNCHER.restartMeExitCode);
        });
      },
      committed: (records) => holder.app?.committed(records),
      // The firmware module's effects (m3-updates-design sections 4 and 5).
      transfers,
      bluetoothSession: (effect) => {
        const sent = sendSession(effect, keys.value, {
          app: (conn, message) => holder.app?.perform({ kind: "appSend", conn, message }),
          control: (request, reply) => holder.control?.respond(request, reply),
        });
        if (sent.isErr()) say(`firmware.bluetooth: ${sent.error}`);
      },
      // Each turn's own time (section 3), on the process's monotonic clock.
      stopwatch: () => performance.now(),
    },
  );
  holder.loop = loop;
  const side = AppSide.make(
    appOptions,
    app.value,
    () => loop.state,
    (event) => {
      loop.enqueue(event);
    },
  );
  if (side.isErr()) {
    say(`cannot start the app channel: ${side.error.message}`);
    return EXIT_CANNOT_START;
  }
  holder.app = side.value;

  // The relay client (m4-design section 4, B6): the phones' push keys, the app channel for relayed
  // streams, the upload store for fetched releases, on a connection of its own.
  const pushKeys = MemoryPushKeys.load(store.db);
  const relayKey = x25519StaticKey(app.value.material.staticPrivate);
  if (pushKeys.isErr() || !relayKey.ok) {
    say(
      `cannot start the relay client: ${pushKeys.isErr() ? pushKeys.error.message : "no app key"}`,
    );
    return EXIT_CANNOT_START;
  }
  let stopping = false;
  holder.relay = new RelayClient({
    staticKey: relayKey.value,
    hubVersion: HUB_VERSION,
    channel: side.value.channel,
    pushKeys: pushKeys.value,
    emit: (event) => {
      loop.enqueue(event);
    },
    report,
    timers: REAL_TIMERS,
    now: () => performance.now(),
    random: (length) => randomBytes(length, ORIGIN),
    releases: {
      platform: platformOf(process.platform, process.arch),
      running: HUB_VERSION,
      firmware: () => newestFirmware(loop.state.firmware.images.values()),
      uploads: app.value.uploads,
      conn: app.value.connIds.next(),
      wanted: (job, release) =>
        !stopping && (release === "firmware" || hubReleaseWanted(loop.state, job)),
      stage: (job, work) =>
        holder.app?.job(job, work) ?? {
          kind: "ready",
          outcome: { kind: "failed", reason: "io", message: "the hub is stopping" },
        },
      wake: () => {
        askTurn();
      },
    },
  });

  // The top-level handler (section 10).
  const uncaught = (thrown: unknown): void => {
    recordUncaught(fatalContext(holder.loop), ORIGIN, thrown);
    process.exit(FATAL_EXIT_CODE);
  };
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", uncaught);

  // A clean stop: everything staged and the clean-stop mark, in one commit. Listened for before
  // anything else starts, so a stop asked for during the start is clean too.
  const stopCleanly = (): void => {
    stopping = true;
    loop.turn();
    loop.stop();
    holder.relay?.stop();
    holder.app?.stop();
    const stopped = store.writer.stop();
    if (stopped.isErr()) say(`the clean stop's commit failed: ${stopped.error.message}`);
    // The hub's clean stop closes `hub.db` (section 9), after a truncating checkpoint: every
    // committed page is in the file and the write-ahead log is empty (macOS's own SQLite keeps an
    // empty log file after the close; Linux's removes it), so a switch's `afterStop` (a restore's
    // swap) finds the database whole and no other connection open. A late `hsn log` is refused.
    const checkpointed = sqlite(ORIGIN, "checkpoint the log at the clean stop", () => {
      store.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    });
    if (checkpointed.isErr()) say(checkpointed.error.message);
    const closed = closeDatabase(store.db, ORIGIN);
    if (closed.isErr()) say(`hub.db did not close: ${closed.error.message}`);
  };
  const stop = (): void => {
    if (exitCode.code !== undefined) return;
    stopCleanly();
    finish(EXIT_CLEAN);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The boot event: the first input of the run (section 7); then the app listeners, and in the
  // same synchronous run the hub's facts with the ports they really hold and the time zone
  // (m2-design.md section 2), before the control socket opens, so no client of either is served
  // by a core without them; again whenever the addresses change. Without the listeners the hub
  // still runs, for its devices, and says why.
  // The deployment's default relay, which the core may not import (m4-design section 2).
  loop.enqueue({
    kind: "boot",
    snapshot,
    boot: { ...store.boot, defaultRelayUrl: defaultRelayUrl(DEPLOYMENT) },
  });
  if (firmwareStore.isOk())
    for (const { image, problem } of firmwareStore.value.damaged)
      loop.enqueue({ kind: "firmwareStoreDamaged", image, problem });
  if (retried.kind === "refused")
    loop.enqueue({
      kind: "shellWarning",
      code: "restore_waiting",
      message: "a restore is waiting and could not be put in place",
      detail: JSON.stringify({ reason: retried.reason }),
    });
  const listening = side.value.open((event) => {
    loop.enqueue(event);
  });
  if (listening.isErr()) say(`the app listeners could not open: ${listening.error.message}`);
  runTurn();
  let relayAddresses = homeAddresses().join(",");
  const addressCheck = setInterval(() => {
    holder.app?.addressesChanged((event) => {
      loop.enqueue(event);
    });
    // A change of the computer's addresses reconnects the relay link at once (m4-design section 4).
    const now = homeAddresses().join(",");
    if (now !== relayAddresses) holder.relay?.networkChanged();
    relayAddresses = now;
    runTurn();
  }, ADDRESS_CHECK_MS);
  addressCheck.unref();

  // Links, the control socket, mDNS (section 7, step 3).
  registry.listen((event) => {
    loop.enqueue(event);
  });
  const serial = new SerialLinks(registry, serialFixture?.open, report);
  const watch = new UsbWatch(serial, {
    extraPaths: options.serial,
    ...(options.watchUsb ? {} : { folders: [] }),
    ...serialFixture?.watch,
    failed: report,
    started: () => {
      say("watching Windows serial ports");
    },
  });
  for (const started of watch.start()) if (started.isErr()) report(started.error);
  const control = await UnixControlServer.open({
    // The program tree's top folder is checked as the data folder's is (A11, section 9).
    otherTopFolders: programTree === undefined ? [] : [programTree],
    socketPath: socketPath(options.dataDir),
    logQuery: (query) =>
      // `hsn log` flushes, then reads on the writer's connection (section 3).
      store.writer.flush("log").andThen(() => store.reader.query(query)),
    deviceIdOf: (name) => deviceByName(loop.state, name)?.id,
    writerStatus: appOptions.writerStatus,
    // A transfer frame's answer is a turn of the hub's one thread too (`hsn status`).
    longestTurnMs: () => Math.max(loop.takeLongestTurnMs(), transfers.takeLongestMs()),
    connIds: app.value.connIds,
    uploads: app.value.uploads,
    // A11's warnings are the core's to record (`shellWarning`, step 1, wave 2).
    onWarning: (warning) => {
      loop.enqueue({
        kind: "shellWarning",
        code: warning.code,
        message: warning.message,
        detail: JSON.stringify(warning.detail),
      });
    },
  });
  if (control.isErr()) {
    say(`the control socket could not open: ${control.error.message}`);
  } else {
    holder.control = control.value;
    side.value.useControl(control.value);
    control.value.listen((event) => {
      loop.enqueue(event);
    });
  }

  const code =
    exitCode.code ??
    (await new Promise<number>((resolve) => {
      exitCode.resolve = resolve;
    }));
  if (timer !== undefined) clearTimeout(timer);
  trust.stop();
  watch.stop();
  transfers.close();
  if (WINDOWS_SERIAL || serialFixture !== undefined)
    await Promise.all([watch.settled(), serial.closeAsyncPorts()]);
  void devices.stop(true);
  (await (holder.control?.close() ?? okAsync(undefined))).match(
    () => undefined,
    (error) => {
      say(`the control socket did not close: ${error.message}`);
    },
  );
  advertiser.stop().match(
    () => undefined,
    () => undefined,
  );
  return code;
}

if (import.meta.main) {
  const options = parseMainArgs(process.argv.slice(2), process.env);
  if (typeof options === "string") {
    say(options);
    process.exit(2);
  }
  hubUmask();
  // In lockstep the controller is the clock, the links and the control socket (section 11).
  process.exit(
    options.lockstep === undefined
      ? await runHub(options, { publisherKeys: PUBLISHER_KEYS })
      : await runLockstep({ socketPath: options.lockstep, dataDir: options.dataDir, say }),
  );
}
