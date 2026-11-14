/**
 * The hub's own link closes on the real links (section 8, "Gateway sessions"; section 11): a real
 * hub process closes a gateway's WebSocket and its serial port in the cases lockstep reports in
 * `idle.closed`: the session replaced by a newer one proven, and an unproven one while another
 * is live. So the controller's view of a close and a real device's agree.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cobsDecode, encodeUsbFrame, ResumeStep } from "@hsn/protocol";
import { deviceId } from "../../../src/core/model/ids.ts";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import { DeviceState } from "../../../src/core/model/rows.ts";
import type { StoreOp } from "../../../src/core/model/store.ts";
import { SystemClock } from "../../../src/shell/clock/system-clock.ts";
import { DEVICE_PATH } from "../../../src/shell/links/websocket.ts";
import { openStore } from "../../../src/shell/storage/store.ts";
import { siteRowAt } from "../../scenarios/sensors/bench.ts";
import { SeededBytes } from "../../world/entropy.ts";
import { endProcesses, spawnTracked } from "../../world/processes.ts";
import { ScriptedGateway } from "../../world/scripted-gateway.ts";

const MAIN = join(import.meta.dir, "..", "..", "..", "src", "shell", "main.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "drizzle");
const RELAY = join(import.meta.dir, "..", "shell-links", "pty-relay.ts");
const GATEWAY = deviceId(1);
const ADDRESS = 0x6a000001;
const KEY = new Uint8Array(16).map((_, i) => 0x40 + i);
const ptys = process.platform !== "win32";

const root = mkdtempSync("/tmp/hsn-c-");
afterAll(async () => {
  await endProcesses();
  rmSync(root, { recursive: true, force: true });
});
let folders = 0;

async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(20);
  return condition();
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

/** A data folder with the gateway paired; its status interval 1 s, so an unproven wait is 11 s. */
function seeded(): string {
  const dataDir = join(root, `d${++folders}`);
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
  return dataDir;
}

function gateway(): ScriptedGateway {
  const random = new SeededBytes(7);
  return new ScriptedGateway({ key: KEY, address: ADDRESS, nextRandom: () => random.bytes(8) });
}

/** A WebSocket connection of `g` to the hub: its hello, and everything it answers. */
function connect(port: number, g: ScriptedGateway): { socket: WebSocket; closed: number[] } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${DEVICE_PATH}`);
  socket.binaryType = "arraybuffer";
  const closed: number[] = [];
  socket.onopen = () => {
    const hello = g.hello();
    if (hello !== undefined) socket.send(hello);
  };
  socket.onmessage = (event) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    for (const answer of g.receive(bytes, 0 as never)) socket.send(answer);
  };
  socket.onclose = (event) => {
    closed.push(event.code);
  };
  return { socket, closed };
}

function hub(dataDir: string, port: number, serial: readonly string[] = []) {
  return spawnTracked(
    [
      "bun",
      MAIN,
      "--data",
      dataDir,
      "--port",
      String(port),
      "--no-usb-watch",
      ...serial.flatMap((p) => ["--serial", p]),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
}

describe("the hub's own closes on a real WebSocket", () => {
  test("a newer session proven: the old socket is closed with 1000, the new one stays", async () => {
    const port = await freePort();
    const process = hub(seeded(), port);
    const g = gateway();
    let first = connect(port, g);
    // Up once the hub answers: the first connection's session is proven by its Started.
    for (let tries = 0; tries < 50 && g.session === undefined; tries++) {
      if (first.closed.length > 0) first = connect(port, g);
      await until(() => g.session !== undefined, 200);
    }
    expect(g.session).toBeDefined();
    await Bun.sleep(200);
    const before = g.session;
    const second = connect(port, g);
    expect(await until(() => g.session !== before && first.closed.length > 0, 5000)).toBe(true);
    expect(first.closed).toEqual([1000]);
    await Bun.sleep(200);
    expect(second.closed).toEqual([]);
    second.socket.close();
    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
  }, 30_000);

  test("an unproven one while another is live: closed after the status interval and 10 s", async () => {
    const port = await freePort();
    const process = hub(seeded(), port);
    const g = gateway();
    let first = connect(port, g);
    for (let tries = 0; tries < 50 && g.session === undefined; tries++) {
      if (first.closed.length > 0) first = connect(port, g);
      await until(() => g.session !== undefined, 200);
    }
    expect(g.session).toBeDefined();
    // The second connection sends its hello and never anything bound to its session.
    g.startedOnEveryConnection = false;
    const second = connect(port, g);
    const opened = Date.now();
    expect(await until(() => second.closed.length > 0, 20_000)).toBe(true);
    expect(second.closed).toEqual([1000]);
    expect(Date.now() - opened).toBeGreaterThan(10_000);
    first.socket.close();
    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
  }, 40_000);
});

/** A pseudo-terminal whose relay passes bytes both ways and reports the hub's hang-up. */
async function terminal(): Promise<{
  readonly path: string;
  readonly states: string[];
  write(bytes: Uint8Array): Promise<void>;
  onFrame(handler: (frame: Uint8Array) => void): void;
}> {
  const relay = spawnTracked(["bun", RELAY, "--watch"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = relay.stdout.getReader();
  let header = "";
  let rest: number[] = [];
  for (let reads = 0; !header.includes("\n") && reads < 100; reads++) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const text = new TextDecoder().decode(chunk.value);
    header += text;
    const at = chunk.value.indexOf(0x0a);
    if (at >= 0) rest = [...chunk.value.subarray(at + 1)];
  }
  const states: string[] = [];
  void (async () => {
    const errors = relay.stderr.getReader();
    let pending = "";
    for (let reads = 0; reads < 100_000; reads++) {
      const chunk = await errors.read();
      if (chunk.done) return;
      pending += new TextDecoder().decode(chunk.value);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      states.push(...lines);
    }
  })();
  let handler: (frame: Uint8Array) => void = () => undefined;
  let buffer = rest;
  const take = (): void => {
    for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
      const encoded = Uint8Array.from(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (encoded.length === 0) continue;
      const decoded = cobsDecode(encoded);
      if (decoded.ok) handler(decoded.value);
    }
  };
  void (async () => {
    for (let reads = 0; reads < 100_000; reads++) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer = [...buffer, ...chunk.value];
      take();
    }
  })();
  return {
    path: header.slice(0, header.indexOf("\n")),
    states,
    write: async (bytes) => {
      await relay.stdin.write(bytes);
      await relay.stdin.flush();
    },
    onFrame: (h) => {
      handler = h;
      take();
    },
  };
}

describe.skipIf(!ptys)("the hub's own closes on a real serial port", () => {
  test("its session replaced over Wi-Fi: the hub closes the port, and the far end sees the hang-up", async () => {
    const t = await terminal();
    const port = await freePort();
    const process = hub(seeded(), port, [t.path]);
    const g = gateway();
    t.onFrame((frame) => {
      for (const answer of g.receive(frame, 0 as never)) void t.write(encodeUsbFrame(answer));
    });
    // The hub opens the port and identifies the board (§10): then the gateway says hello on it.
    expect(await until(() => t.states.includes("open"), 10_000)).toBe(true);
    const hello = g.hello();
    if (hello !== undefined) await t.write(encodeUsbFrame(hello));
    expect(await until(() => g.session !== undefined, 5000)).toBe(true);
    await Bun.sleep(200);
    const before = g.session;
    const wifi = connect(port, g);
    expect(await until(() => g.session !== before, 5000)).toBe(true);
    expect(await until(() => t.states.includes("closed"), 5000)).toBe(true);
    expect(wifi.closed).toEqual([]);
    wifi.socket.close();
    process.kill("SIGTERM");
    expect(await process.exited).toBe(0);
  }, 40_000);
});
