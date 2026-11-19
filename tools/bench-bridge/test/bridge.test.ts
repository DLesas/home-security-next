/**
 * The bench bridge (`src/bridge.ts`) between a fake bench end (`fake-bench-end.py`: a
 * pseudo-terminal left as a new one is, which reports when its far end opens and closes it) and,
 * first, a WebSocket server standing in for the hub, then the real hub (`hub/src/shell/main.ts`)
 * with a scripted gateway behind the terminal. They need `python3`; they are skipped without it.
 */
import { shortTempFolder } from "../../../hub/test/world/temp-folder.ts";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  encodeUsbFrame,
  MaxPacketLength,
  MessageType,
  ResumeStep,
  UsbFrameDecoder,
} from "@hsn/protocol";
import { deviceId } from "@hsn/hub/src/core/model/ids.ts";
import { DEFAULT_RULES } from "@hsn/hub/src/core/model/rules.ts";
import { DeviceState } from "@hsn/hub/src/core/model/rows.ts";
import type { StoreOp } from "@hsn/hub/src/core/model/store.ts";
import { SystemClock } from "@hsn/hub/src/shell/clock/system-clock.ts";
import { openStore } from "@hsn/hub/src/shell/storage/store.ts";
import { siteRowAt } from "@hsn/hub/test/scenarios/sensors/bench.ts";
import { SeededBytes } from "@hsn/hub/test/world/entropy.ts";
import { ScriptedGateway } from "@hsn/hub/test/world/scripted-gateway.ts";
import { BenchBridge } from "../src/bridge.ts";

const python = Bun.which("python3");
const FAKE_END = join(import.meta.dir, "fake-bench-end.py");
// The tests' entry: `main.ts`'s, with the clock synchronised on any Linux (`hub/test/world`).
const HUB_MAIN = join(import.meta.dir, "..", "..", "..", "hub", "test", "world", "hub-entry.ts");
const MIGRATIONS = join(import.meta.dir, "..", "..", "..", "hub", "drizzle");
const TRICKY = [0x0a, 0x0d, 0x11, 0x13, 0x03, 0x04, 0x7f, 0x00];

/** The bench's end of one network link. */
class FakeBenchEnd {
  readonly path: string;
  readonly lines: string[] = [];
  readonly #proc: Bun.Subprocess<"pipe", "pipe", "ignore">;

  private constructor(
    proc: Bun.Subprocess<"pipe", "pipe", "ignore">,
    path: string,
    rest: string[],
  ) {
    this.#proc = proc;
    this.path = path;
    this.lines.push(...rest);
  }

  static async start(): Promise<FakeBenchEnd> {
    const proc = Bun.spawn([python ?? "python3", FAKE_END], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = proc.stdout.getReader();
    let text = "";
    for (let reads = 0; !text.includes("\n") && reads < 100; reads++) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const [first = "", ...rest] = text.split("\n");
    const end = new FakeBenchEnd(
      proc,
      first.replace(/^path /u, ""),
      rest.filter((l) => l !== ""),
    );
    void (async () => {
      let pending = "";
      for (let reads = 0; reads < 1_000_000; reads++) {
        const chunk = await reader.read();
        if (chunk.done) return;
        pending += new TextDecoder().decode(chunk.value);
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        end.lines.push(...parts);
      }
    })();
    running.push(() => {
      end.kill();
    });
    return end;
  }

  write(bytes: Uint8Array): void {
    void this.#proc.stdin.write(`write ${Buffer.from(bytes).toString("hex")}\n`);
    void this.#proc.stdin.flush();
  }

  /** Every byte the far end wrote, in order. */
  received(): Uint8Array {
    return Uint8Array.from(
      this.lines.flatMap((l) => (l.startsWith("data ") ? [...Buffer.from(l.slice(5), "hex")] : [])),
    );
  }

  states(): readonly string[] {
    return this.lines.filter((l) => l === "open" || l === "closed");
  }

  kill(): void {
    this.#proc.kill();
  }
}

/** What each test started, stopped after it in reverse order (a bridge before its hub). */
const running: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of running.splice(0).toReversed()) await stop();
});

async function until(condition: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(10);
  if (!condition()) expect(`timed out after ${ms} ms waiting for ${what}`).toBe("");
}

/** A WebSocket server standing in for the hub's `/device`. */
function fakeHub(): {
  readonly url: string;
  readonly messages: Uint8Array[];
  readonly sockets: Bun.ServerWebSocket[];
  readonly closed: number[];
  stop(): void;
} {
  const messages: Uint8Array[] = [];
  const sockets: Bun.ServerWebSocket[] = [];
  const closed: number[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (request, s) => (s.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => {
        sockets.push(ws);
      },
      message: (_ws, message) => {
        messages.push(
          typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message),
        );
      },
      close: () => {
        closed.push(Date.now());
      },
    },
  });
  running.push(() => {
    void server.stop(true);
  });
  return {
    url: `ws://127.0.0.1:${server.port}/device`,
    messages,
    sockets,
    closed,
    stop: () => {
      void server.stop(true);
    },
  };
}

// The bridge connects to POSIX pseudo-terminals through Python’s pty module.
describe.skipIf(process.platform === "win32" || python === null)(
  "the bench bridge, against a stand-in hub",
  () => {
    test("opens the terminal once the hub took the WebSocket; one frame per message, both ways, byte-clean", async () => {
      const end = await FakeBenchEnd.start();
      const hub = fakeHub();
      const bridge = new BenchBridge([{ device: "siren1", path: end.path }], { hubUrl: hub.url });
      running.push(() => bridge.stop());
      bridge.start();
      await until(() => end.states().includes("open"), "the terminal opened");
      expect(hub.sockets).toHaveLength(1);

      const frames = [
        new Uint8Array(TRICKY),
        new Uint8Array([0x0a]),
        new Uint8Array(300).fill(0x0d),
      ];
      for (const frame of frames) end.write(encodeUsbFrame(frame));
      await until(() => hub.messages.length >= frames.length, "every frame at the hub");
      expect(hub.messages.map((m) => [...m])).toEqual(frames.map((f) => [...f]));

      const replies = [new Uint8Array([1, 0x0a, 2]), new Uint8Array(TRICKY.toReversed())];
      for (const reply of replies) hub.sockets[0]?.send(reply);
      const expected = replies.flatMap((r) => [...encodeUsbFrame(r)]);
      await until(() => end.received().length >= expected.length, "every message at the bench");
      expect([...end.received()]).toEqual(expected);
    });

    test("the hub closing the WebSocket closes the terminal; the bridge comes back with the hub", async () => {
      const end = await FakeBenchEnd.start();
      const hub = fakeHub();
      const bridge = new BenchBridge([{ device: "siren1", path: end.path }], {
        hubUrl: hub.url,
        retryMs: 100,
      });
      running.push(() => bridge.stop());
      bridge.start();
      await until(() => end.states().includes("open"), "the terminal opened");
      hub.sockets[0]?.close();
      await until(() => end.states().includes("closed"), "the terminal closed");
      await until(
        () => end.states().filter((s) => s === "open").length === 2,
        "the terminal opened again",
      );
      expect(hub.sockets).toHaveLength(2);
    });

    test("the bench closing its end closes the WebSocket", async () => {
      const end = await FakeBenchEnd.start();
      const hub = fakeHub();
      const bridge = new BenchBridge([{ device: "siren1", path: end.path }], {
        hubUrl: hub.url,
        retryMs: 100,
      });
      running.push(() => bridge.stop());
      bridge.start();
      await until(() => end.states().includes("open"), "the terminal opened");
      end.kill();
      await until(() => hub.closed.length === 1, "the WebSocket closed");
    });
  },
);

// Short, so the hub's control socket path stays under 104 bytes.
const dataDir = shortTempFolder("hsn-br-");
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const GATEWAY_KEY = new Uint8Array(16).map((_, i) => 0x60 + i);
const GATEWAY_ADDRESS = 0x6a000009;

/** A hub data folder with one gateway paired. */
function seedHub(): void {
  const store = openStore({
    dataDir,
    migrationsFolder: MIGRATIONS,
    clock: new SystemClock({ wallTrusted: () => true }),
    rules: DEFAULT_RULES,
    platform: process.platform,
  })._unsafeUnwrap();
  const id = deviceId(1);
  const ops: StoreOp[] = [
    { table: "site", op: "upsert", row: siteRowAt(5) },
    {
      table: "devices",
      op: "upsert",
      row: {
        id,
        address: GATEWAY_ADDRESS,
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
    {
      table: "device_keys",
      op: "upsert",
      row: { deviceId: id, key: GATEWAY_KEY, nextKey: null, rekey: 0 },
    },
    {
      table: "send_counters",
      op: "upsert",
      row: { deviceId: id, resumePoint: ResumeStep.SirenOrGateway },
    },
  ];
  store.writer.stage(ops.map((op) => ({ kind: "write", durability: "now", op })));
  store.writer.flush("now")._unsafeUnwrap();
  store.writer.stop()._unsafeUnwrap();
  store.db.close();
}

// The bridge connects to POSIX pseudo-terminals through Python’s pty module.
describe.skipIf(process.platform === "win32" || python === null)(
  "the bench bridge, against the real hub",
  () => {
    test("a gateway behind the terminal is welcomed and given its settings; the hub killed is the link down", async () => {
      seedHub();
      const server = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = server.port ?? 0;
      await server.stop(true);
      const hub = Bun.spawn(
        [
          "bun",
          HUB_MAIN,
          "--data",
          dataDir,
          "--port",
          String(port),
          "--no-usb-watch",
          "--app-ports",
          "0,0",
        ],
        // The hub's own words, if it does not start, are what the timeout below cannot say.
        { stdout: "ignore", stderr: "inherit" },
      );
      running.push(() => {
        hub.kill(9);
      });
      const end = await FakeBenchEnd.start();
      const bridge = new BenchBridge([{ device: "gateway1", path: end.path }], {
        hubUrl: `ws://127.0.0.1:${port}/device`,
        retryMs: 100,
      });
      running.push(() => bridge.stop());
      bridge.start();
      await until(() => end.states().includes("open"), "the bridge reached the hub", 15_000);

      const random = new SeededBytes(3);
      const gateway = new ScriptedGateway({
        key: GATEWAY_KEY,
        address: GATEWAY_ADDRESS,
        nextRandom: () => random.bytes(8),
      });
      end.write(encodeUsbFrame(gateway.hello() ?? new Uint8Array()));
      const decoder = new UsbFrameDecoder(MaxPacketLength.Link);
      let taken = 0;
      const take = (): void => {
        const bytes = end.received();
        for (const frame of decoder.push(bytes.subarray(taken))) {
          if (!frame.ok) continue;
          for (const answer of gateway.receive(frame.value, 0 as never))
            end.write(encodeUsbFrame(answer));
        }
        taken = bytes.length;
      };
      await until(() => {
        take();
        return gateway.settings !== undefined;
      }, "the hub's welcome and settings through the bridge");
      expect(gateway.session).toBeDefined();
      expect(gateway.settings?.siteChannel).toBe(1);
      expect(MessageType.GatewaySettings).toBeDefined();

      hub.kill(9);
      await until(() => end.states().includes("closed"), "the terminal closed when the hub went");
    }, 30_000);
  },
);
