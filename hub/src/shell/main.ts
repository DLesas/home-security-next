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
 * code 70 for the service manager to restart it (HB20). SIGINT and SIGTERM stop it cleanly: the
 * last commit carries the clean-stop mark. This file and `shell/safe/` are where `try` and
 * `throw` may appear (section 10); this one needs neither.
 */
import { join } from "node:path";
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
import { LinkRegistry } from "./links/registry.ts";
import { SerialLinks } from "./links/serial.ts";
import { UsbWatch } from "./links/usb-watch.ts";
import { serveDevices } from "./links/websocket.ts";
import { randomBytes } from "./safe/crypto.ts";
import { writeStandardError } from "./safe/fs.ts";
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
  return { dataDir, port, serial, watchUsb, lockstep };
}

function say(message: string): void {
  writeStandardError({ kind: "internal", origin: ORIGIN }, `hub: ${message}\n`).match(
    () => undefined,
    () => undefined,
  );
}

/** Runs the hub until it is stopped; resolves to the exit code. */
export async function runHub(options: MainOptions): Promise<number> {
  const rules = DEFAULT_RULES;
  const trust = new SystemTimeTrust({
    probe: probeFor(process.platform),
    scheduler: systemScheduler,
    wall: () => Date.now(),
    notBeforeMs: HUB_BUILD_TIME_MS,
    onProbeFailed: (error: HubError) => {
      say(error.message);
    },
  });
  const clock = new SystemClock(trust);
  const keysHolder: { keys: MemoryKeyStore | undefined } = { keys: undefined };
  const opened = openStore({
    dataDir: options.dataDir,
    migrationsFolder: join(import.meta.dir, "..", "..", "drizzle"),
    clock,
    rules,
    platform: process.platform,
    onCommitted: (ops) => keysHolder.keys?.applyCommitted(ops),
  });
  if (opened.isErr()) {
    say(`cannot start: ${opened.error.message}`);
    return EXIT_CANNOT_START;
  }
  const store: OpenedStore = opened.value;
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
  const snapshot = { ...store.snapshot, hubKeys: hubKeys.value };
  const keys = MemoryKeyStore.load(store.db);
  if (keys.isErr()) {
    say(`cannot read the device keys: ${keys.error.message}`);
    return EXIT_CANNOT_START;
  }
  keysHolder.keys = keys.value;

  // The wall clock is untrusted while it reads earlier than the last commit mark (section 5).
  const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
  if (mark !== undefined) trust.setFloor(mark.lastSeenMs);
  trust.start();

  // The `/device` WebSocket first, so the port mDNS advertises is the one it serves (§10).
  const registry = new LinkRegistry();
  const devices = serveDevices(registry, options.port);
  const servedPort = devices.port ?? options.port;
  const holder: { loop: HubLoop | undefined; control: UnixControlServer | undefined } = {
    loop: undefined,
    control: undefined,
  };
  const advertiser = new MdnsAdvertiser(servedPort, () =>
    bonjourLibrary((error) => {
      say(error.message);
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let soon = false;
  const runTurn = (): void => {
    soon = false;
    holder.loop?.turn();
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
    { cipher: new KeyStoreCipher(keys.value), rules },
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
        if (soon) return;
        soon = true;
        setImmediate(runTurn);
      },
      report,
      fatal: (error) => {
        recordUncaught(fatalContext(holder.loop), error.origin, new Error(error.message));
        finish(FATAL_EXIT_CODE);
      },
    },
  );
  holder.loop = loop;

  // The top-level handler (section 10).
  const uncaught = (thrown: unknown): void => {
    recordUncaught(fatalContext(holder.loop), ORIGIN, thrown);
    process.exit(FATAL_EXIT_CODE);
  };
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", uncaught);

  // A clean stop: everything staged and the clean-stop mark, in one commit. Listened for before
  // anything else starts, so a stop asked for during the start is clean too.
  const stop = (): void => {
    if (exitCode.code !== undefined) return;
    loop.turn();
    loop.stop();
    const stopped = store.writer.stop();
    if (stopped.isErr()) say(`the clean stop's commit failed: ${stopped.error.message}`);
    finish(EXIT_CLEAN);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The boot event: the first input of the run (section 7).
  loop.enqueue({ kind: "boot", snapshot, boot: store.boot });
  runTurn();

  // Links, the control socket, mDNS (section 7, step 3).
  registry.listen((event) => {
    loop.enqueue(event);
  });
  const serial = new SerialLinks(registry);
  const watch = new UsbWatch(serial, {
    extraPaths: options.serial,
    ...(options.watchUsb ? {} : { folders: [] }),
    failed: report,
  });
  for (const started of watch.start()) if (started.isErr()) report(started.error);
  const control = await UnixControlServer.open({
    socketPath: socketPath(options.dataDir),
    logQuery: (query) =>
      // `hsn log` flushes, then reads on the writer's connection (section 3).
      store.writer.flush("log").andThen(() => store.reader.query(query)),
    deviceIdOf: (name) => deviceByName(loop.state, name)?.id,
    writerStatus: () => ({
      lastCommitMs: store.writer.lastCommitMs ?? null,
      stagedItems: store.writer.staged,
      databaseBytes: store.writer.inUseBytes ?? null,
      historyShortened: store.writer.trimming,
    }),
  });
  if (control.isErr()) {
    say(`the control socket could not open: ${control.error.message}`);
  } else {
    holder.control = control.value;
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
  // In lockstep the controller is the clock, the links and the control socket (section 11).
  process.exit(
    options.lockstep === undefined
      ? await runHub(options)
      : await runLockstep({ socketPath: options.lockstep, dataDir: options.dataDir, say }),
  );
}
