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
 * - **Always (work, not time):** every door report sent is recorded and answered: each has a
 *   reply in `tx_event` whose outcome is Sent, none "radio busy" or "too late" (an event reply goes
 *   too late only if the hub held the report for about 1.5 s, the sensor's listening time at DR5,
 *   so a loaded machine does not fail it, a job done in one piece of that length does). And the
 *   order of the hub's
 *   own records shows the reports taken while a backup ran: door reports recorded after the
 *   `backup.now` request's record and before its `backup_written`. A backup done in one piece
 *   leaves none between. The two exports run too, and every report sent meanwhile is recorded,
 *   but their order cannot be shown: an export writes no record when it ends, and the order in
 *   which the test receives the gateway's frames and the export's lines is the sockets' (a
 *   one-piece export still arrives interleaved). Reported as a FROZEN-CHANGE.
 * - **Opt-in (`HSN_TIMING=1`, run alone):** the loop does not expose a turn's duration (reported
 *   as a FROZEN-CHANGE), so the 20 ms ‡ a turn cannot be asserted as such. What is asserted
 *   instead is section 3's consequence: a report is taken within about 50 ms of leaving the
 *   gateway, by the hub's own record of taking it (`rx_event.at_ms`) against the time it was sent.
 *
 * Not here: staging (the hub carries no publisher key in M2's builds, so a real hub refuses every
 * release before its pieces: `PUBLISHER_KEYS` is empty, and no option admits the test key), and
 * restore's read and rebuild (it waits for a phone's key over Noise on the apps' listener).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import { bootId, deviceId } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { DeviceState, TxOutcome } from "../../src/core/model/rows.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import { SystemClock } from "../../src/shell/clock/system-clock.ts";
import { DEVICE_PATH } from "../../src/shell/links/websocket.ts";
import { openStore } from "../../src/shell/storage/store.ts";
import { sensorRow, siteRowAt } from "../scenarios/sensors/bench.ts";
import { SeededBytes } from "../world/entropy.ts";
import { endProcesses, spawnTracked } from "../world/processes.ts";
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
 * Door reports the hub must record between the backup's request and its end: at least one (4 were
 * measured here, 0 with the backup done in one piece). The primary guard is the reply outcomes:
 * a job that holds the loop leaves the reports to be answered in a burst, and the gateway answers
 * some "radio busy". This one says, by the hub's own records, that the backup ran while reports
 * came; a higher count would depend on the machine's speed.
 */
const AT_LEAST_DURING = 1;
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
    const filler = "x".repeat(500);
    for (let i = 1; i <= 200_000; i++)
      s.db.run(`INSERT INTO people VALUES (?, ?, 0, NULL, 0)`, [i, `person ${i} ${filler}`]);
  })();
  // The folder chosen already, with nothing due: the only backup is the one the test asks for.
  s.db.run(`UPDATE backup_state SET folder = ?`, [backups]);
  writeOlderRows(s, { routinePerDay: 200_000, eventPerDay: 0 }, bootId(s.boot.id - 1));
  s.writer.stop()._unsafeUnwrap();
  s.db.close();
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
    const hub = spawnTracked(
      [
        "bun",
        MAIN,
        "--data",
        dataDir,
        "--port",
        String(port),
        "--no-usb-watch",
        "--app-ports",
        "0,0",
      ],
      { stdout: "ignore", stderr: "pipe" },
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
    this.#hub?.kill("SIGTERM");
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
    const dataDir = mkdtempSync("/tmp/hsn-ll-");
    folders.push(dataDir);
    const backups = join(dataDir, "..", `${dataDir.split("/").at(-1)}-backups`);
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
    // 1. A backup, now (the request's `commands` record, then `backup_written`).
    // The reply `{job}` comes first; the reports go on until the backup is written.
    await during(bench, async () => {
      await op("backup.now", {});
      await Bun.sleep(4000);
    });
    // 2. The configuration export, then 3. the export with history, streamed to `hsn`.
    const exportOf = async (history: boolean): Promise<number> => {
      let chunks = 0;
      await during(bench, async () => {
        await new Promise<void>((resolve) => {
          void op(
            "backup.export",
            { history },
            {
              onChunk: (chunk) => {
                chunks++;
                if (chunk.end !== undefined) resolve();
              },
              onFailed: () => {
                resolve();
              },
            },
          );
        });
      });
      return chunks;
    };
    const configuration = await exportOf(false);
    const history = await exportOf(true);
    // Every transmit result delivered, then a moment for the hub to record it.
    expect(await until(() => bench.settled, 10_000)).toBe(true);
    await Bun.sleep(1000);
    for (const session of sessions) session.close();
    await bench.stop();
    await endProcesses();

    const s = store(dataDir);
    const seqOf = (sql: string): number =>
      s.db.query<{ seq: number }, []>(sql).get()?.seq ?? Number.NaN;
    const start = seqOf(
      `SELECT max(seq) AS seq FROM commands WHERE kind = 'op' AND args LIKE '%"op":"backup.now"%'`,
    );
    // The backup's end: the first `backup_written` after its request.
    const end = seqOf(
      `SELECT min(seq) AS seq FROM hub_events WHERE code = 'backup_written' AND seq > ${start}`,
    );
    const doors = s.db
      .query<{ n: number }, [number]>(`SELECT count(*) AS n FROM rx_event WHERE device_id = ?`)
      .get(SENSOR)?.n;
    const duringBackup = s.db
      .query<{ n: number }, [number, number, number]>(
        `SELECT count(*) AS n FROM rx_event WHERE device_id = ? AND seq > ? AND seq < ?`,
      )
      .get(SENSOR, start, end)?.n;
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
    const written = s.db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM hub_events WHERE code = 'backup_written'`,
      )
      .get()?.n;
    s.writer.stop()._unsafeUnwrap();
    s.db.close();
    // The backup asked for was written.
    expect(written).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(end)).toBe(true);
    const answers = bench.seen;
    console.log(
      `${bench.sent} door reports sent, ${doors} recorded, ${answers.length} answered; ` +
        `${duringBackup} recorded during the backup; ` +
        `configuration export ${configuration} chunks, history export ${history} chunks`,
    );
    // Every report is recorded (each is a new door change) and answered: its reply was sent.
    expect(doors).toBe(bench.sent);
    expect(replies).toEqual([{ outcome: TxOutcome.Sent, n: bench.sent }]);
    // None waited for a whole job: the hub took reports between each job's pieces.
    expect(duringBackup).toBeGreaterThanOrEqual(AT_LEAST_DURING);
    expect(configuration).toBeGreaterThan(1);
    expect(history).toBeGreaterThan(1);
    if (TIMING) {
      // From a report leaving the gateway to the hub's own record of taking it (`at_ms`, on the
      // same computer's clock): section 3's "within about 50 ms" behind a piece and a commit.
      const waits = taken.map((r) => r.at_ms - (bench.sentAt.get(r.counter) ?? r.at_ms));
      const longest = Math.max(...waits);
      console.log(`longest wait for a report to be taken: ${longest} ms`);
      expect(longest).toBeLessThanOrEqual(TAKEN_WITHIN_MS);
    }
  }, 180_000);
});
