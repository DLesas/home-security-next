/**
 * The crash tests' second layer (hub-design.md section 11): a real hub process
 * (`src/shell/main.ts`) killed with `kill -9` at random moments, each time started again on the
 * same data folder, with a scripted gateway connected over the `/device` WebSocket the whole
 * time. 100 times a night in continuous integration (`HSN_KILL9_RUNS=100`); 8 by default.
 *
 * After every run: the database opens and passes SQLite's integrity check; each run was a boot
 * of its own; and no counter the hub sealed for the gateway was ever used by two runs (§4).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MaxPacketLength, readPacketHeader, ResumeStep } from "@hsn/protocol";
import { deviceId } from "../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { DeviceState } from "../../src/core/model/rows.ts";
import type { StoreOp } from "../../src/core/model/store.ts";
import { SystemClock } from "../../src/shell/clock/system-clock.ts";
import { DEVICE_PATH } from "../../src/shell/links/websocket.ts";
import { openStore } from "../../src/shell/storage/store.ts";
import { siteRowAt } from "../scenarios/sensors/bench.ts";
import { SeededBytes } from "../world/entropy.ts";
import { endProcesses, spawnTracked } from "../world/processes.ts";
import { ScriptedGateway } from "../world/scripted-gateway.ts";

const RUNS = Number(process.env.HSN_KILL9_RUNS ?? 8);
const MAIN = join(import.meta.dir, "..", "..", "src", "shell", "main.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "drizzle");
const GATEWAY = deviceId(1);
const ADDRESS = 0x6a000001;
const KEY = new Uint8Array(16).map((_, i) => 0x40 + i);
/** How long one run may take to accept the gateway before the test gives up on it. */
const START_TIMEOUT_MS = 10_000;
const POLL_MS = 20;

// Short, so the control socket's path stays under 104 bytes (section 9).
const dataDir = mkdtempSync("/tmp/hsn-k9-");
afterAll(async () => {
  await endProcesses();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The gateway paired before the first start. */
function seed(): void {
  const store = openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  const ops: StoreOp[] = [
    { table: "site", op: "upsert", row: siteRowAt(5) },
    {
      table: "devices",
      op: "upsert",
      row: {
        id: GATEWAY,
        address: ADDRESS,
        role: 3,
        name: "gateway-1",
        chipId: new Uint8Array(6),
        firmware: 0x010000,
        development: false,
        state: DeviceState.Contacted,
        addedMs: Date.now(),
        removedMs: null,
      },
    },
    { table: "device_keys", op: "upsert", row: { deviceId: GATEWAY, key: KEY } },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: GATEWAY, resumePoint: ResumeStep.SirenOrGateway },
    },
    {
      table: "gateway_config",
      op: "upsert",
      row: {
        deviceId: GATEWAY,
        version: 1,
        statusIntervalS: 1,
        interferenceDb: 10,
        interferenceS: 30,
        defaultPowerDbm: 22,
        sirenPowerDbm: 22,
      },
    },
  ];
  store.writer.stage(ops.map((op) => ({ kind: "write", durability: "now", op })));
  store.writer.flush("now")._unsafeUnwrap();
  store.writer.stop()._unsafeUnwrap();
  store.db.close();
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

/** One run: start the hub, connect the gateway, let it work, then `kill -9` it. */
async function oneRun(
  port: number,
  random: SeededBytes,
  gateway: ScriptedGateway,
  counters: Map<number, number>,
  run: number,
): Promise<string | undefined> {
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
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let socket: WebSocket | undefined;
  let welcomed = false;
  const opened = await until(() => {
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      socket = new WebSocket(`ws://127.0.0.1:${port}${DEVICE_PATH}`);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        const header = readPacketHeader(bytes, MaxPacketLength.Link);
        if (header.ok)
          counters.set(header.value.counter, (counters.get(header.value.counter) ?? 0) + 1);
        for (const answer of gateway.receive(bytes, 0 as never)) socket?.send(answer);
        if (gateway.session !== undefined) welcomed = true;
      };
      socket.onopen = () => {
        const hello = gateway.hello();
        if (hello !== undefined) socket?.send(hello);
      };
    }
    return welcomed;
  }, START_TIMEOUT_MS);
  if (!opened) {
    hub.kill(9);
    await hub.exited;
    const stderr = await new Response(hub.stderr).text();
    return `run ${run}: the hub never welcomed the gateway within ${START_TIMEOUT_MS} ms: ${stderr}`;
  }
  // Statuses while it works, then the power goes at a random moment.
  const workMs = 50 + (random.next() % 600);
  const started = Date.now();
  while (Date.now() - started < workMs) {
    const status = gateway.status({
      settingsVersion: gateway.settings?.settingsVersion ?? 0,
      uptimeSeconds: run,
      airtimeHundredthsPercent: 0,
      noiseMedianDbm: -118,
      noiseHighestDbm: -110,
      normalNoiseDbm: -118,
      packetsReceived: 0,
      packetsCrcFailed: 0,
      wifiRssiDbm: -60,
      flags: { usbConnected: false, cellFitted: false, onMains: true },
    });
    if (status !== undefined) socket?.send(status);
    await Bun.sleep(POLL_MS);
  }
  hub.kill(9);
  await hub.exited;
  socket?.close();
  return undefined;
}

describe(`a real hub killed with kill -9, ${RUNS} times`, () => {
  test(
    "the database stays whole, each run is a boot, and no counter is used by two runs",
    async () => {
      seed();
      const port = await freePort();
      const random = new SeededBytes(99);
      const used = new Map<number, number>();
      // One gateway for the night: its own counters go on across the hub's runs, as a real one's do.
      const gateway = new ScriptedGateway({
        key: KEY,
        address: ADDRESS,
        nextRandom: () => random.bytes(8),
      });
      const problems: string[] = [];
      for (let run = 1; run <= RUNS; run++) {
        const counters = new Map<number, number>();
        const problem = await oneRun(port, random, gateway, counters, run);
        if (problem !== undefined) {
          problems.push(problem);
          break;
        }
        for (const counter of counters.keys()) {
          const runs = used.get(counter);
          if (runs !== undefined)
            problems.push(`run ${run}: counter ${counter} again, first in run ${runs}`);
          used.set(counter, run);
        }
      }
      expect(problems).toEqual([]);
      const store = openStore({
        dataDir,
        migrationsFolder: MIGRATIONS,
        clock: new SystemClock({ wallTrusted: () => true }),
        rules: DEFAULT_RULES,
        platform: process.platform,
      })._unsafeUnwrap();
      expect(store.db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      const boots = store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM boots").get();
      expect(boots?.n).toBe(RUNS);
      expect(store.boot.previousExit).not.toBe("clean");
      store.db.close();
    },
    RUNS * (START_TIMEOUT_MS + 2_000),
  );
});
