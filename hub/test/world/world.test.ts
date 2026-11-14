/**
 * The test world itself (hub-design.md section 11): virtual time that jumps from deadline to
 * deadline, the recording writer's commit rules, the send gate, faults, scripted devices on
 * links, and the same seed giving the same run. Small test modules stand in for the stubs.
 */
import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";
import {
  Direction,
  MaxPacketLength,
  type Message,
  MessageType,
  sealPacket,
  sessionBinding,
  TransmitPriority,
  TransmitWhen,
  welcomeBinding,
} from "@hsn/protocol";
import type { Effect } from "../../src/core/model/effects.ts";
import { coreFault } from "../../src/core/model/errors.ts";
import type { Handler } from "../../src/core/model/handler.ts";
import { deviceId, type LinkId, linkId, sendRef } from "../../src/core/model/ids.ts";
import type { ModuleName } from "../../src/core/model/modules.ts";
import { type Mono, mono } from "../../src/core/model/time.ts";
import type { TimerOf } from "../../src/core/model/timers.ts";
import { makeCore, type ModuleDefinition, type Modules, MODULES } from "../../src/core/step.ts";
import { SeededBytes } from "./entropy.ts";
import { ScriptedGateway } from "./scripted-gateway.ts";
import { MAX_TURNS_WITHOUT_PROGRESS, World } from "./world.ts";

const SECOND = 1_000_000;

/** The world handled the input without a fault. */
function must(result: Result<unknown, unknown>): void {
  expect(result.isOk()).toBe(true);
}

/** The real stubs, with some handlers replaced. */
function core(handlers: { readonly [K in ModuleName]?: Handler<K> }) {
  const pick = <K extends ModuleName>(name: K): ModuleDefinition<K> => {
    const handle = handlers[name];
    return handle === undefined ? MODULES[name] : { ...MODULES[name], handle };
  };
  const modules: Modules = {
    clock: pick("clock"),
    registry: pick("registry"),
    links: pick("links"),
    setup: pick("setup"),
    control: pick("control"),
    people: pick("people"),
    layout: pick("layout"),
    app: pick("app"),
    schedules: pick("schedules"),
    gateways: pick("gateways"),
    intake: pick("intake"),
    alarm: pick("alarm"),
    site: pick("site"),
    sensors: pick("sensors"),
    slots: pick("slots"),
    sirens: pick("sirens"),
    health: pick("health"),
    notify: pick("notify"),
    upkeep: pick("upkeep"),
    audit: pick("audit"),
  };
  return makeCore(modules);
}

describe("the world with the whole core", () => {
  test("boots, takes events and runs an hour with no fault, committing what is written now", () => {
    const world = new World();
    expect(world.boot().isOk()).toBe(true);
    const link = world.openLink("usb", "/dev/ttyACM0");
    expect(world.deliver(link, new Uint8Array([0xf1, 0x02])).isOk()).toBe(true);
    must(world.advanceByMs(3_600_000));
    expect(world.faults).toEqual([]);
    expect(world.now.mono).toBe(mono(3_600 * SECOND));
    // The USB link was asked to identify itself (§10), and the boot's records were committed.
    expect(world.links.get(link)?.sent.map((s) => [...s.bytes])).toEqual([[0xf1, 0x01]]);
    expect(world.writer.commits.length).toBeGreaterThan(0);
  });

  test("its wall clock follows mono, and can be set and trusted as a Pi's is (section 5)", () => {
    const world = new World({ wallAtStartMs: 1_000, wallTrusted: false });
    must(world.advanceByMs(2_500));
    expect(world.now).toEqual({ mono: mono(2.5 * SECOND), wall: 3_500, wallTrusted: false });
    world.setWall(1_800_000_000_000, true);
    must(world.advanceByMs(1_000));
    expect(world.now).toEqual({
      mono: mono(3.5 * SECOND),
      wall: 1_800_000_001_000,
      wallTrusted: true,
    });
  });
});

describe("virtual time", () => {
  test("jumps from deadline to deadline, running each timer at its own instant", () => {
    const fired: Mono[] = [];
    const timers: readonly TimerOf<"alarm">[] = [
      {
        at: mono(30 * SECOND),
        key: { module: "alarm", kind: "countdownEnd", sensor: deviceId(3) },
      },
      { at: mono(60 * SECOND), key: { module: "alarm", kind: "alarmEnd" } },
    ];
    const world = new World({
      core: core({
        alarm: (slice, message, ctx) => {
          if (message.kind === "boot") return ok({ slice: { ...slice, timers }, out: [] });
          if (message.kind !== "timer") return ok({ slice, out: [] });
          fired.push(ctx.now.mono);
          return ok({
            slice: { ...slice, timers: slice.timers.filter((t) => t.at !== message.at) },
            out: [],
          });
        },
      }),
    });
    must(world.boot());
    expect(world.nextWake()).toBe(mono(30 * SECOND));
    must(world.advanceTo(mono(45 * SECOND)));
    expect(fired).toEqual([mono(30 * SECOND)]);
    expect(world.now.mono).toBe(mono(45 * SECOND));
    must(world.advanceByMs(3_600_000));
    expect(fired).toEqual([mono(30 * SECOND), mono(60 * SECOND)]);
    expect(world.state.alarm.timers).toEqual([]);
  });
});

describe("the run loop's guard", () => {
  test("a wake that is never handled fails with a message instead of spinning for ever", () => {
    let ticks = 0;
    // A timer due at 1 s that its module ignores: the world keeps finding it due.
    const stuck: TimerOf<"alarm"> = {
      at: mono(SECOND),
      key: { module: "alarm", kind: "alarmEnd" },
    };
    const world = new World({
      core: core({
        alarm: (slice, message) => {
          if (message.kind === "tick") ticks++;
          return ok({
            slice: message.kind === "boot" ? { ...slice, timers: [stuck] } : slice,
            out: [],
          });
        },
      }),
    });
    must(world.boot());
    const result = world.advanceByMs(60_000);
    expect(result.isErr() && result.error.message).toContain("is never handled");
    // One turn moves time to the wake; then the guard allows its number of turns with no progress.
    expect(ticks).toBe(MAX_TURNS_WITHOUT_PROGRESS + 1);
    expect(world.now.mono).toBe(mono(SECOND));
    // Once stalled, the world says so on every later run.
    expect(world.advanceByMs(1).isErr()).toBe(true);
  });

  test("a wake that is handled at its instant is progress, however many there are", () => {
    const many: readonly TimerOf<"alarm">[] = Array.from(
      { length: 3 * MAX_TURNS_WITHOUT_PROGRESS },
      (_, i): TimerOf<"alarm"> => ({
        at: mono(SECOND + i),
        key: { module: "alarm", kind: "countdownEnd", sensor: deviceId(i) },
      }),
    );
    const world = new World({
      core: core({
        alarm: (slice, message) => {
          if (message.kind === "boot") return ok({ slice: { ...slice, timers: many }, out: [] });
          if (message.kind !== "timer") return ok({ slice, out: [] });
          return ok({
            slice: { ...slice, timers: slice.timers.filter((t) => t.at !== message.at) },
            out: [],
          });
        },
      }),
    });
    must(world.boot());
    must(world.advanceByMs(10_000));
    expect(world.state.alarm.timers).toEqual([]);
  });
});

describe("the recording writer", () => {
  const write = (durability: "now" | "routine", resumePoint: number): Effect => ({
    kind: "write",
    durability,
    op: { table: "send_counters", op: "upsert", row: { deviceId: deviceId(3), resumePoint } },
  });

  test("commits a now item at once with everything staged, routine items after five minutes", () => {
    const outs: (readonly Effect[])[] = [
      [write("routine", 1)],
      [write("routine", 2)],
      [write("now", 3)],
      [write("routine", 4)],
    ];
    const world = new World({
      core: core({
        registry: (slice, message) =>
          ok({ slice, out: message.kind === "tick" ? (outs.shift() ?? []) : [] }),
      }),
    });
    must(world.input({ kind: "tick" }));
    must(world.advanceByMs(1_000));
    must(world.input({ kind: "tick" }));
    expect(world.writer.commits).toEqual([]);
    must(world.advanceByMs(1_000));
    must(world.input({ kind: "tick" }));
    expect(world.writer.commits.map((c) => c.items.length)).toEqual([3]);
    must(world.input({ kind: "tick" }));
    expect(world.writer.staged).toHaveLength(1);
    must(world.advanceByMs(299_000));
    expect(world.writer.commits).toHaveLength(1);
    must(world.advanceByMs(1_000));
    expect(world.writer.commits.map((c) => [c.at, c.items.length])).toEqual([
      [mono(2 * SECOND), 3],
      [mono(302 * SECOND), 1],
    ]);
    expect(world.writer.durable(deviceId(3))).toBe(4);
  });

  test("commits every second under the core's cadence effect (D112)", () => {
    const outs: (readonly Effect[])[] = [
      [{ kind: "cadence", everyMs: 1_000 }, write("routine", 1)],
    ];
    const world = new World({
      core: core({
        registry: (slice, message) =>
          ok({ slice, out: message.kind === "tick" ? (outs.shift() ?? []) : [] }),
      }),
    });
    must(world.input({ kind: "tick" }));
    must(world.advanceByMs(1_000));
    expect(world.writer.commits.map((c) => c.at)).toEqual([mono(SECOND)]);
  });
});

describe("the send gate (section 4)", () => {
  test("holds back a send whose counter is not below the durable resume point, and says so", () => {
    const failed: string[] = [];
    const send = (counter: number): Effect => ({
      kind: "send",
      link: linkId(1),
      bytes: new Uint8Array([counter]),
      ref: sendRef(counter),
      counters: [{ device: deviceId(5), counter }],
    });
    const world = new World({
      core: core({
        sirens: (slice, message) => {
          if (message.kind === "sendFailed") failed.push(`${message.ref}:${message.error}`);
          if (message.kind !== "frame") return ok({ slice, out: [] });
          const counter = message.bytes[0] ?? 0;
          const out: Effect[] =
            counter === 1
              ? [send(1)]
              : [
                  {
                    kind: "write",
                    durability: "now",
                    op: {
                      table: "send_counters",
                      op: "upsert",
                      row: { deviceId: deviceId(5), resumePoint: 2048 },
                    },
                  },
                  send(1024),
                ];
          return ok({ slice, out });
        },
      }),
    });
    const link = world.openLink("network", "hall");
    must(world.deliver(link, new Uint8Array([1])));
    expect(failed).toEqual(["1:notDurable"]);
    expect(world.links.get(link)?.sent).toEqual([]);
    must(world.deliver(link, new Uint8Array([2])));
    expect(world.links.get(link)?.sent.map((s) => [...s.bytes])).toEqual([[1024 & 0xff]]);
    expect(failed).toEqual(["1:notDurable"]);
  });
});

describe("faults", () => {
  test("are kept, and leave the state as it was", () => {
    const world = new World({
      core: core({
        alarm: (slice, message, ctx) =>
          message.kind === "frame"
            ? err(coreFault(ctx.event, "core/alarm", "probe"))
            : ok({
                slice:
                  message.kind === "boot"
                    ? {
                        ...slice,
                        timers: [{ at: mono(SECOND), key: { module: "alarm", kind: "alarmEnd" } }],
                      }
                    : slice,
                out: [],
              }),
      }),
    });
    must(world.boot());
    const before = world.state;
    const link = world.openLink("usb", "x");
    expect(world.deliver(link, new Uint8Array([1])).isErr()).toBe(true);
    expect(world.faults).toMatchObject([
      { kind: "internal", origin: "core/alarm", event: "frame" },
    ]);
    expect(world.state.alarm).toBe(before.alarm);
  });
});

describe("a scripted gateway on a link", () => {
  const key = new Uint8Array(16).map((_, i) => 0x40 + i);
  const address = 0x0a0b0c0d;
  const hubRandom = new Uint8Array(8).fill(0xbb);

  /** A hub module that answers the first frame with a welcome, settings and a transmit request. */
  function answeringCore(gatewayRandom: Uint8Array, received: Mono[]) {
    const fromHub = (message: Message, counter: number, binding: Uint8Array) =>
      sealPacket(message, {
        key,
        direction: Direction.FromHub,
        address,
        counter,
        binding,
        maxLength: MaxPacketLength.Link,
      });
    const session = sessionBinding(gatewayRandom, hubRandom);
    const sends = (link: LinkId): Effect[] =>
      [
        fromHub({ type: MessageType.Welcome, hubRandom }, 1, welcomeBinding(gatewayRandom)),
        fromHub(
          {
            type: MessageType.GatewaySettings,
            settingsVersion: 4,
            siteChannel: 1,
            listenDataRateMask: 0x20,
            statusIntervalSeconds: 30,
            interferenceThresholdDb: 10,
            interferenceSeconds: 30,
            defaultTxPowerDbm: 22,
            sirenTxPowerDbm: 22,
          },
          2,
          session,
        ),
        fromHub(
          {
            type: MessageType.TransmitRequest,
            when: TransmitWhen.AtTime,
            gatewayTimeMicros: 5 * SECOND,
            dataRate: 5,
            powerDbm: 22,
            priority: TransmitPriority.Normal,
            packet: new Uint8Array(30).fill(0x18),
          },
          3,
          session,
        ),
      ].map((bytes, i) => ({ kind: "send", link, bytes, ref: sendRef(i), counters: [] }));
    return core({
      gateways: (slice, message, ctx) => {
        if (message.kind !== "frame") return ok({ slice, out: [] });
        received.push(ctx.now.mono);
        return ok({ slice, out: received.length === 1 ? sends(message.link) : [] });
      },
    });
  }

  test("answers the hub at once and sends its transmit result when the radio has sent", () => {
    const random = new SeededBytes(9);
    const gatewayRandom = new SeededBytes(9).bytes(8);
    const received: Mono[] = [];
    const world = new World({ core: answeringCore(gatewayRandom, received) });
    const gateway = new ScriptedGateway({ key, address, nextRandom: () => random.bytes(8) });
    const link = world.openLink("network", "ws gw", gateway);
    must(world.deliver(link, gateway.hello() ?? new Uint8Array()));
    // The hello, then Started straight after the settings, at the same instant.
    expect(received).toEqual([mono(0), mono(0)]);
    expect(gateway.settings?.settingsVersion).toBe(4);
    expect(world.nextWake()).toBe(mono(5 * SECOND));
    must(world.advanceByMs(10_000));
    expect(received).toEqual([mono(0), mono(0), mono(5 * SECOND)]);
    expect(gateway.transmissions.map((t) => t.startMicros)).toEqual([5 * SECOND]);
  });
});

describe("repeatability", () => {
  function run(seed: number): readonly Effect[] {
    const world = new World({
      seed,
      core: core({
        setup: (slice, message, ctx) =>
          message.kind === "frame"
            ? ctx.entropy.take(16).map((bytes) => ({
                slice,
                out: [{ kind: "send", link: message.link, bytes, ref: sendRef(1), counters: [] }],
              }))
            : ok({ slice, out: [] }),
      }),
    });
    must(world.boot());
    const link = world.openLink("usb", "x");
    for (let i = 0; i < 5; i++) {
      must(world.advanceByMs(1_000));
      must(world.deliver(link, new Uint8Array([i])));
    }
    return world.effects;
  }

  test("the same seed and inputs give the same effects; another seed other random bytes", () => {
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
    expect(run(7).filter((effect) => effect.kind === "send")).toHaveLength(5);
  });
});
