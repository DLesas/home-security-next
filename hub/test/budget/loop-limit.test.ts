/**
 * The loop's time while the hub listens (m2-design.md section 3; section 10, "The loop's limit"),
 * on a real hub process (`test/world/hub-entry.ts`, the hub's entry): each whole-file job is started as production
 * starts it, over the control socket as `hsn` does, while a scripted gateway on the `/device`
 * WebSocket forwards a door report from a paired sensor every 100 ms. The hub must take the reports
 * between the job's pieces, never behind the whole job.
 *
 * The rate is the gateway's: one reply takes its one radio about 72 ms (a 32-byte reply at SF7),
 * and a request that finds the radio's places taken is answered "radio busy" (protocol.md §6), so
 * one sensor reporting faster than about every 82 ms (72 ms and the gateway's 20 ms "too late")
 * cannot have every report answered, whatever the hub does. Every 100 ms, each one is.
 *
 * What a home can do (m2-design.md section 3, "The one piece that is not bounded"): a backup and a
 * configuration export begin with one read of the whole configuration, kept by decision, so the
 * configuration here is of a home's size with headroom (`PEOPLE` below), and what is large is the
 * history, which grows in a real home and whose export's pieces must stay bounded.
 *
 * - **Always:** every door report sent is recorded and answered, each with a reply in `tx_event`
 *   whose outcome is Sent, none "radio busy" or "too late" (the primary guard: a job that holds the
 *   loop leaves the reports to be answered in a burst, and the gateway's one radio answers some
 *   "radio busy"; an event reply goes too late only past about 1.5 s, so a loaded machine does
 *   not fail it). And the hub's own longest turn during each job (`longestTurnMs` in `hsn status`,
 *   reset when read) is under `LONGEST_TURN_BOUND_MS`, a bound for a loaded machine that a job
 *   done in one piece passes many times over.
 * - **Printed, not asserted:** the longest turn at the start (the hub opening its database, before
 *   it listens: exempt by section 3), the core count, the jobs' windows, any reply not sent.
 * - **Opt-in (`HSN_TIMING=1`, run alone):** section 3's 20 ms ‡ for each job's longest turn, and a
 *   report taken within about 50 ms of leaving the gateway, by the hub's own record of taking it
 *   (`rx_event.at_ms`) against the time it was sent.
 *
 * Not here: staging (the hub carries no publisher key in M2's builds, so a real hub refuses every
 * release before its pieces: `PUBLISHER_KEYS` is empty, and no option admits the test key), and
 * restore's read and rebuild (it waits for a phone's key over Noise on the apps' listener).
 */
import { shortTempFolder } from "../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { basename, join } from "node:path";
import {
  Direction,
  type Message,
  MaxPacketLength,
  MessageType,
  NO_BINDING,
  readPacketHeader,
  ResumeStep,
  sealPacket,
} from "@hsn/protocol";
import { Session } from "../../cli/client.ts";
import { bootId, deviceId, recordSeq } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { DeviceState, TxOutcome } from "../../src/core/model/rows.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import { SystemClock } from "../../src/shell/clock/system-clock.ts";
import { DEVICE_PATH } from "../../src/shell/links/websocket.ts";
import { openStore } from "../../src/shell/storage/store.ts";
import { sensorRow, siteRowAt } from "../scenarios/sensors/bench.ts";
import { SeededBytes } from "../world/entropy.ts";
import {
  endProcesses,
  spawnTestHub,
  stopTestHub,
  spawnTracked,
  testCli,
} from "../world/processes.ts";
import { ScriptedGateway } from "../world/scripted-gateway.ts";
import { writeOlderRows } from "./run.ts";

/** The hub's own entry with the clock taken as synchronised (a Linux runner may not say it is). */
const MAIN = join(import.meta.dir, "..", "world", "hub-entry.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
const TIMING = process.env.HSN_TIMING === "1";
/** A report behind a piece and a commit is taken within about 50 ms (section 3), asserted opt-in. */
const TAKEN_WITHIN_MS = 50;
const GATEWAY = deviceId(1);
const SENSOR = deviceId(2);
const GATEWAY_ADDRESS = 0x6a000001;
const SENSOR_ADDRESS = 0x5e000001;
const GATEWAY_KEY = new Uint8Array(16).map((_, i) => 0x40 + i);
const SENSOR_KEY = new Uint8Array(16).map((_, i) => 0x90 + i);
/** One report every 100 ms: the gateway's radio answers every one (see above). */
const REPORT_EVERY_MS = 100;
/**
 * People in the configuration: 4,000 with a 400-character name each, about 2 MB of configuration,
 * some ten times a real home's 150 to 200 KB (section 3): headroom, and the single read of the
 * whole configuration that starts a backup and a configuration export stays within a home's reach.
 */
const PEOPLE = 4_000;
/**
 * The history of an earlier boot: 300,000 routine records (small) and 4,000 hub events with 4 KB
 * of detail each (large lines), so the export with history runs for many report intervals in
 * pieces of about 256 KB of lines.
 */
const HISTORY_ROUTINE = 300_000;
const HISTORY_LARGE = 4_000;
const LARGE_DETAIL_BYTES = 4096;
/**
 * The hub's longest turn during a job, always asserted: 250 ms, the bound A8's piece tests use for
 * a loaded machine. A piece of 256 KB takes a few milliseconds here and some tens on a hosted
 * machine of four cores; a whole job in one turn takes from hundreds of milliseconds to seconds.
 */
const LONGEST_TURN_BOUND_MS = 250;
/** Section 3's limit a turn ‡, asserted only with `HSN_TIMING=1`. */
const TURN_LIMIT_MS = 20;
/** How often the bench lets the gateway deliver its due transmit results. */
const PUMP_MS = 5;
const START_TIMEOUT_MS = 20_000;
const POLL_MS = 10;

const folders: string[] = [];
afterAll(async () => {
  await endProcesses();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

const store = (dataDir: string) =>
  openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();

/**
 * The data folder: a gateway and a door sensor paired; 200,000 people (so a backup, built from the
 * configuration, is about 110 MB: some 440 pieces of 256 KB); 200,000 routine records of an
 * earlier boot (so an export with history runs for hundreds of pages).
 */
function seed(dataDir: string, backups: string): void {
  const s = store(dataDir);
  const device = (id: typeof GATEWAY, address: number, role: number, name: string): StoreOp => ({
    table: "devices",
    op: "upsert",
    row: {
      id,
      address,
      role,
      name,
      chipId: new Uint8Array([role, 0, 0, 0, 0, id]),
      firmware: 0x010000,
      development: false,
      state: DeviceState.Contacted,
      addedMs: Date.now() - 86_400_000,
      removedMs: null,
    },
  });
  const ops: StoreOp[] = [
    { table: "site", op: "upsert", row: siteRowAt(5) },
    device(GATEWAY, GATEWAY_ADDRESS, 3, "gateway-1"),
    device(SENSOR, SENSOR_ADDRESS, 1, "door-1"),
    { table: "device_keys", op: "upsert", row: { deviceId: GATEWAY, key: GATEWAY_KEY } },
    { table: "device_keys", op: "upsert", row: { deviceId: SENSOR, key: SENSOR_KEY } },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: GATEWAY, resumePoint: ResumeStep.SirenOrGateway },
    },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: SENSOR, resumePoint: ResumeStep.Hub },
    },
    { table: "sensor_config", op: "upsert", row: sensorRow(SENSOR, 5) },
    {
      table: "gateway_config",
      op: "upsert",
      row: {
        deviceId: GATEWAY,
        version: 1,
        statusIntervalS: 30,
        interferenceDb: 10,
        interferenceS: 30,
        defaultPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
  ];
  s.writer.stage(ops.map((op) => ({ kind: "write", durability: "now", op })));
  s.writer.flush("now")._unsafeUnwrap();
  s.db.transaction(() => {
    const filler = "x".repeat(400);
    for (let i = 1; i <= PEOPLE; i++)
      s.db.run(`INSERT INTO people VALUES (?, ?, 0, NULL, 0)`, [i, `person ${i} ${filler}`]);
  })();
  // The folder chosen already, with nothing due: the only backup is the one the test asks for.
  s.db.run(`UPDATE backup_state SET folder = ?`, [backups]);
  const earlier = bootId(s.boot.id - 1);
  writeOlderRows(s, { routinePerDay: HISTORY_ROUTINE, eventPerDay: 0 }, earlier);
  s.db.transaction(() => {
    const detail = JSON.stringify({ note: "y".repeat(LARGE_DETAIL_BYTES) });
    for (let k = 0; k < HISTORY_LARGE; k++)
      s.db.run(`INSERT INTO hub_events VALUES (?, ?, 1, 'info', 'test', 'large', ?, ?)`, [
        recordSeq(earlier, HISTORY_ROUTINE + k) ?? 0,
        Date.now() - 86_400_000 + k,
        `a large record ${k}`,
        detail,
      ]);
  })();
  s.writer.stop()._unsafeUnwrap();
  // Closed for certain before the hub opens it: `close()` alone may defer it, and the hub then
  // finds the database locked (as on a Linux runner).
  s.db.close(true);
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(POLL_MS);
  return condition();
}

/** The hub's answers to the reports, as the test saw them arrive. */
interface Seen {
  readonly kind: "answer";
  readonly at: number;
}

/** The running hub with its gateway connected, and a door that opens and closes on demand. */
class Bench {
  readonly seen: Seen[] = [];
  sent = 0;
  /** When each report left, by its packet counter (wall ms, the hub's clock's source too). */
  readonly sentAt = new Map<number, number>();
  #counter = 1;
  #open = false;
  #socket: WebSocket | undefined;
  #pump: ReturnType<typeof setInterval> | undefined;
  #hub: ReturnType<typeof spawnTracked> | undefined;
  readonly #gateway: ScriptedGateway;
  readonly #started = performance.now();

  private constructor(gateway: ScriptedGateway) {
    this.#gateway = gateway;
  }

  static async start(port: number, dataDir: string): Promise<Bench | string> {
    const hub = spawnTestHub(
      [MAIN, "--data", dataDir, "--port", String(port), "--no-usb-watch", "--app-ports", "0,0"],
      "pipe",
    );
    const random = new SeededBytes(5);
    const bench = new Bench(
      new ScriptedGateway({
        key: GATEWAY_KEY,
        address: GATEWAY_ADDRESS,
        nextRandom: () => random.bytes(8),
      }),
    );
    let welcomed = false;
    const opened = await until(() => {
      if (bench.#socket === undefined || bench.#socket.readyState === WebSocket.CLOSED) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${DEVICE_PATH}`);
        socket.binaryType = "arraybuffer";
        socket.onmessage = (event) => {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          const before = bench.#gateway.transmissions.length;
          for (const answer of bench.#gateway.receive(bytes, bench.#now())) socket.send(answer);
          // A transmit request for the sensor: the hub's answer to a report.
          for (const t of bench.#gateway.transmissions.slice(before)) {
            const header = readPacketHeader(t.packet, MaxPacketLength.Radio);
            if (header.ok && header.value.address === SENSOR_ADDRESS)
              bench.seen.push({ kind: "answer", at: performance.now() });
          }
          if (bench.#gateway.session !== undefined) welcomed = true;
        };
        socket.onopen = () => {
          const hello = bench.#gateway.hello();
          if (hello !== undefined) socket.send(hello);
        };
        bench.#socket = socket;
      }
      return welcomed;
    }, START_TIMEOUT_MS);
    bench.#hub = hub;
    // The gateway's transmit results, each when its airtime ends, as a real gateway sends them.
    bench.#pump = setInterval(() => {
      bench.#deliver();
    }, PUMP_MS);
    if (!opened) {
      hub.kill(9);
      await hub.exited;
      return `the hub never welcomed the gateway: ${await new Response(hub.stderr).text()}`;
    }
    return bench;
  }

  #deliver(): void {
    const due = this.#gateway.nextWake();
    if (due === undefined || due > this.#now()) return;
    for (const frame of this.#gateway.wake(this.#now())) this.#socket?.send(frame);
  }

  /** Whether every transmit result has gone to the hub. */
  get settled(): boolean {
    return this.#gateway.nextWake() === undefined;
  }

  #now() {
    return mono(Math.round((performance.now() - this.#started) * 1000));
  }

  /** One door report (the door changes each time), forwarded by the gateway as heard now. */
  report(): void {
    this.#open = !this.#open;
    const message: Message = {
      type: MessageType.DoorChanged,
      settingsVersion: 0,
      flags: {
        doorOpen: this.#open,
        coverOpen: false,
        usbPower: false,
        charging: false,
        replyWanted: true,
        localAlarmSounded: false,
        buzzing: false,
        listeningAtSendRate: true,
      },
      batteryCode: 200,
      temperatureCelsius: 20,
      doorChangeCount: this.#counter % 256,
      eventAgeSeconds: 0,
    };
    const packet = sealPacket(message, {
      key: SENSOR_KEY,
      direction: Direction.ToHub,
      address: SENSOR_ADDRESS,
      counter: this.#counter++,
      binding: NO_BINDING,
      maxLength: MaxPacketLength.Radio,
    });
    const frame = this.#gateway.forward(packet, {
      endedAt: this.#now(),
      rssiDbm: -92,
      snrQuarterDb: 24,
      dataRate: 5,
      siteChannel: 1,
    });
    if (frame === undefined) return;
    this.#socket?.send(frame);
    this.sentAt.set(this.#counter - 1, Date.now());
    this.sent++;
  }

  /** The hub stopped cleanly, as a service stop does (its writer commits what is staged). */
  async stop(): Promise<void> {
    clearInterval(this.#pump);
    this.#socket?.close();
    if (this.#hub !== undefined) stopTestHub(this.#hub);
    await this.#hub?.exited;
  }
}

/** Door reports every 100 ms while `work` runs; then the reports' records and the job's. */
async function during(bench: Bench, work: () => Promise<void>): Promise<void> {
  const state = { running: true };
  const reporting = (async () => {
    while (state.running) {
      bench.report();
      await Bun.sleep(REPORT_EVERY_MS);
    }
  })();
  await work();
  state.running = false;
  await reporting;
}

describe("door reports while the hub writes whole files (section 3, the loop's time)", () => {
  test("a backup and two exports run in pieces: the reports are taken between them, every one recorded", async () => {
    const dataDir = shortTempFolder("hsn-ll-");
    folders.push(dataDir);
    const backups = join(dataDir, "..", `${basename(dataDir)}-backups`);
    mkdirSync(backups);
    folders.push(backups);
    seed(dataDir, backups);
    const port = await freePort();
    const bench = await Bench.start(port, dataDir);
    expect(typeof bench === "string" ? bench : "started").toBe("started");
    if (typeof bench === "string") return;
    // A connection a request, as `hsn` makes them (the socket closes idle connections).
    const sessions: Session[] = [];
    const op = async (
      name: string,
      body: unknown,
      download?: Parameters<Session["request"]>[3],
    ) => {
      const session = (await Session.open(join(dataDir, "control.sock")))._unsafeUnwrap();
      sessions.push(session);
      const reply = (
        await session.request("test", { kind: "op", op: name, body }, 120_000, download)
      )._unsafeUnwrap();
      expect(reply.reply.ok ? "ok" : JSON.stringify(reply.reply)).toBe("ok");
    };
    /**
     * The hub's own longest turn since the last read (`longestTurnMs` in `hsn status`'s reply,
     * reset when read), in milliseconds: measured, printed, not yet asserted (a measuring run).
     */
    const longestTurn = async (): Promise<number> => {
      const session = (await Session.open(join(dataDir, "control.sock")))._unsafeUnwrap();
      sessions.push(session);
      const line = (await session.request("test", { kind: "status" }, 30_000))._unsafeUnwrap();
      const result: unknown = line.reply.ok ? line.reply.result : undefined;
      const value =
        typeof result === "object" && result !== null && "longestTurnMs" in result
          ? result.longestTurnMs
          : undefined;
      return typeof value === "number" ? value : Number.NaN;
    };
    /** When each job ran, on this computer's clock, to place a reply that was not sent. */
    const windows: { job: string; fromMs: number; toMs: number }[] = [];
    const turns: Record<string, number> = { start: await longestTurn() };
    // 1. A backup, now (the request's `commands` record, then `backup_written`).
    // The reply `{job}` comes first; the reports go on until the backup is written.
    const backupFrom = Date.now();
    await during(bench, async () => {
      await op("backup.now", {});
      await Bun.sleep(4000);
    });
    windows.push({ job: "backup", fromMs: backupFrom, toMs: Date.now() });
    turns.backup = await longestTurn();
    // 2. The configuration export, then 3. the export with history, streamed to the real `hsn`
    // (`hsn backup export <file> [--history]`) in a process of its own: decoding some hundred
    // megabytes of chunks here would stall this process, whose gateway would then take the hub's
    // replies late and in a burst, which looks like a held loop when it is the test's own.
    const exportOf = async (history: boolean): Promise<number> => {
      const file = join(
        dataDir,
        "..",
        `${basename(dataDir)}-${history ? "history" : "configuration"}.export`,
      );
      folders.push(file);
      const done = { code: -1 };
      await during(bench, async () => {
        const hsn = spawnTracked(
          [
            "bun",
            testCli,
            "--data",
            dataDir,
            "backup",
            "export",
            file,
            ...(history ? ["--history"] : []),
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        done.code = await hsn.exited;
        if (done.code !== 0)
          console.log(`hsn backup export: ${await new Response(hsn.stderr).text()}`);
      });
      expect(done.code).toBe(0);
      return existsSync(file) ? statSync(file).size : 0;
    };
    const configurationFrom = Date.now();
    const configuration = await exportOf(false);
    windows.push({ job: "configuration export", fromMs: configurationFrom, toMs: Date.now() });
    turns.configurationExport = await longestTurn();
    const historyFrom = Date.now();
    const history = await exportOf(true);
    windows.push({ job: "history export", fromMs: historyFrom, toMs: Date.now() });
    turns.historyExport = await longestTurn();
    // Every transmit result delivered, then a moment for the hub to record it.
    expect(await until(() => bench.settled, 10_000)).toBe(true);
    await Bun.sleep(1000);
    for (const session of sessions) session.close();
    await bench.stop();
    await endProcesses();

    const s = store(dataDir);
    const doors = s.db
      .query<{ n: number }, [number]>(`SELECT count(*) AS n FROM rx_event WHERE device_id = ?`)
      .get(SENSOR)?.n;
    const taken = s.db
      .query<{ counter: number; at_ms: number }, [number]>(
        `SELECT counter, at_ms FROM rx_event WHERE device_id = ?`,
      )
      .all(SENSOR);
    const replies = s.db
      .query<{ outcome: number; n: number }, [number, number]>(
        `SELECT outcome, count(*) AS n FROM tx_event WHERE device_id = ? AND type = ? GROUP BY outcome`,
      )
      .all(SENSOR, MessageType.Reply);
    const notSent = s.db
      .query<{ at_ms: number; outcome: number }, [number, number]>(
        `SELECT at_ms, outcome FROM tx_event WHERE device_id = ? AND type = ? AND outcome != 0`,
      )
      .all(SENSOR, MessageType.Reply);
    const written = s.db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM hub_events WHERE code = 'backup_written'`,
      )
      .get()?.n;
    s.writer.stop()._unsafeUnwrap();
    s.db.close(true);
    // The backup asked for was written.
    expect(written).toBeGreaterThanOrEqual(1);
    const answers = bench.seen;
    console.log(
      `${bench.sent} door reports sent, ${doors} recorded, ${answers.length} answered; ` +
        `configuration export ${configuration} bytes, history export ${history} bytes`,
    );
    // The figures: the hub's own longest turn in each phase (the start's printed only), the cores,
    // and when each reply that was not sent was recorded, against the jobs' windows.
    console.log(
      `longest turn (ms): ${JSON.stringify(turns)}; cores: ${String(availableParallelism())} ` +
        `(${cpus()[0]?.model ?? "unknown"}); jobs: ${JSON.stringify(windows)}; ` +
        `replies not sent: ${JSON.stringify(notSent)}`,
    );
    // Every report is recorded (each is a new door change) and answered: its reply was sent.
    expect(doors).toBe(bench.sent);
    expect(replies).toEqual([{ outcome: TxOutcome.Sent, n: bench.sent }]);
    // The exports ran: the configuration's (of a home's size), and the history's, which spans
    // hundreds of chunks of 48 KB ‡ and so many pieces.
    expect(configuration).toBeGreaterThan(48 * 1024);
    expect(history).toBeGreaterThan(300 * 48 * 1024);
    // No turn of the hub held the loop long during any job, by its own measure.
    const held = (["backup", "configurationExport", "historyExport"] as const).filter(
      (job) => !((turns[job] ?? Number.POSITIVE_INFINITY) <= LONGEST_TURN_BOUND_MS),
    );
    expect(held).toEqual([]);
    if (TIMING) {
      // From a report leaving the gateway to the hub's own record of taking it (`at_ms`, on the
      // same computer's clock): section 3's "within about 50 ms" behind a piece and a commit.
      const waits = taken.map((r) => r.at_ms - (bench.sentAt.get(r.counter) ?? r.at_ms));
      const longest = Math.max(...waits);
      console.log(`longest wait for a report to be taken: ${longest} ms`);
      expect(longest).toBeLessThanOrEqual(TAKEN_WITHIN_MS);
      // Section 3's 20 ms ‡ a turn, during every job.
      expect(
        (["backup", "configurationExport", "historyExport"] as const).filter(
          (job) => !((turns[job] ?? Number.POSITIVE_INFINITY) <= TURN_LIMIT_MS),
        ),
      ).toEqual([]);
    }
  }, 180_000);
});
