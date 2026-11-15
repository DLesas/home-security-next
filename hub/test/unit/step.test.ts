/**
 * The dispatcher (hub-design.md section 2): the fixed module order, the one queue, due timers
 * first, the 10,000-message guard, the entropy and record cursors, a fault leaving the state as
 * it was, the deep freeze, and the same inputs giving the same outputs. Test modules replace
 * the stubs one at a time; the rest stay the real stubs.
 */
import { nodeSha256 } from "@hsn/protocol";
import { describe, expect, test } from "bun:test";
import { EMPTY_ALARM_SLICE } from "../../src/core/alarm/state.ts";
import { EMPTY_AUDIT_SLICE } from "../../src/core/audit/state.ts";
import { EMPTY_SIRENS_SLICE } from "../../src/core/sirens/state.ts";

import { err, ok } from "neverthrow";
import type { Effect } from "../../src/core/model/effects.ts";
import { coreFault } from "../../src/core/model/errors.ts";
import type { HubEvent, Input } from "../../src/core/model/events.ts";
import type { CoreDeps, Handler } from "../../src/core/model/handler.ts";
import {
  bootId,
  deviceId,
  linkId,
  recordSeq,
  requestId,
  seq,
  type Seq,
  sendRef,
  connId,
} from "../../src/core/model/ids.ts";
import type { Internal } from "../../src/core/model/messages.ts";
import { MODULE_ORDER, type ModuleName } from "../../src/core/model/modules.ts";
import { DEFAULT_RULES } from "../../src/core/model/rules.ts";
import { mono } from "../../src/core/model/time.ts";
import type { TimerOf } from "../../src/core/model/timers.ts";
import {
  emptyState,
  makeCore,
  MAX_MESSAGES_PER_STEP,
  type ModuleDefinition,
  type Modules,
  MODULES,
  nextDeadline,
  step,
} from "../../src/core/step.ts";
import { UNBUILT_CALENDAR } from "../../src/shell/calendar/unbuilt.ts";
import { VectorCipher } from "../world/vector-cipher.ts";
import { emptySnapshot } from "../world/world.ts";

const deps: CoreDeps = {
  cipher: VectorCipher.fromVectors(),
  rules: DEFAULT_RULES,
  calendar: UNBUILT_CALENDAR,
  sha256: nodeSha256,
  deepFreeze: true,
};

function input(
  event: HubEvent,
  at = 1_000_000,
  entropy = new Uint8Array(32).map((_, i) => i),
): Input {
  return { now: { mono: mono(at), wall: 1_700_000_000_000, wallTrusted: true }, entropy, event };
}

const tick: HubEvent = { kind: "tick" };
const boot: HubEvent = {
  kind: "boot",
  snapshot: emptySnapshot(),
  boot: { id: bootId(3), previousExit: "clean", cause: undefined },
};

/** The real stubs, with some handlers replaced. */
function withHandlers(handlers: { readonly [K in ModuleName]?: Handler<K> }): Modules {
  const pick = <K extends ModuleName>(name: K): ModuleDefinition<K> => {
    const handle = handlers[name];
    return handle === undefined ? MODULES[name] : { ...MODULES[name], handle };
  };
  return {
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
}

/** Handlers that log each delivery and otherwise do nothing. */
function loggingHandlers(log: string[]): { readonly [K in ModuleName]: Handler<K> } {
  const logging =
    <K extends ModuleName>(name: K): Handler<K> =>
    (slice, message) => {
      log.push(`${name}:${message.kind}`);
      return ok({ slice, out: [] });
    };
  return {
    clock: logging("clock"),
    registry: logging("registry"),
    links: logging("links"),
    setup: logging("setup"),
    control: logging("control"),
    people: logging("people"),
    layout: logging("layout"),
    app: logging("app"),
    schedules: logging("schedules"),
    gateways: logging("gateways"),
    intake: logging("intake"),
    alarm: logging("alarm"),
    site: logging("site"),
    sensors: logging("sensors"),
    slots: logging("slots"),
    sirens: logging("sirens"),
    health: logging("health"),
    notify: logging("notify"),
    upkeep: logging("upkeep"),
    audit: logging("audit"),
  };
}

describe("the whole core", () => {
  test("takes a first boot and every other kind of event without a fault", () => {
    const events: readonly HubEvent[] = [
      boot,
      { kind: "linkOpened", link: linkId(1), linkKind: "usb", label: "/dev/ttyACM0" },
      { kind: "frame", link: linkId(1), bytes: new Uint8Array([0xf1, 0x02]) },
      { kind: "frame", link: linkId(1), bytes: new Uint8Array(30) },
      {
        kind: "inputRejected",
        rejection: { source: "frame", link: linkId(1), reason: "badFrame" },
      },
      { kind: "linkClosed", link: linkId(1), reason: "remote" },
      { kind: "commit", outcome: { kind: "failed", message: "disk full" } },
      { kind: "commit", outcome: { kind: "recovered" } },
      {
        kind: "command",
        conn: connId(0),
        request: requestId(1),
        actor: "a",
        command: { kind: "status" },
      },
      {
        kind: "inputRejected",
        rejection: { source: "control", reason: "notJson", bytes: 12, issues: [] },
      },
      tick,
    ];
    let state = emptyState();
    for (const [i, event] of events.entries()) {
      const result = step(state, input(event, 1_000_000 * (i + 1)), deps);
      expect(result.isErr() ? result.error : undefined).toBeUndefined();
      if (result.isErr()) return;
      state = result.value.state;
    }
    // A first boot writes the hub's own rows and records; the wake is a module's timer.
    expect(nextDeadline(state)).toBeDefined();
  });

  test("answers a command it is given, once", () => {
    const booted = step(emptyState(), input(boot), deps);
    expect(booted.isOk()).toBe(true);
    if (booted.isErr()) return;
    const asked = step(
      booted.value.state,
      input(
        {
          kind: "command",
          conn: connId(0),
          request: requestId(5),
          actor: "a",
          command: { kind: "devices" },
        },
        2_000_000,
      ),
      deps,
    );
    const answers = asked.isOk() ? asked.value.effects.filter((e) => e.kind === "respond") : [];
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ request: requestId(5), reply: { ok: true } });
  });
});

describe("the dispatcher", () => {
  test("delivers every message to the twenty modules in the fixed order, one queue, FIFO", () => {
    const log: string[] = [];
    const handlers = loggingHandlers(log);
    const core = makeCore(
      withHandlers({
        ...handlers,
        // links emits a message and an effect on the frame; intake emits one more on that message.
        links: (slice, message) => {
          log.push(`links:${message.kind}`);
          return ok({
            slice,
            out:
              message.kind === "frame"
                ? [
                    { kind: "gatewayPacket", link: message.link, bytes: message.bytes },
                    { kind: "close", link: message.link, reason: "probe" },
                  ]
                : [],
          });
        },
        intake: (slice, message) => {
          log.push(`intake:${message.kind}`);
          const out: Internal[] =
            message.kind === "gatewayPacket" ? [{ kind: "gatewayDown", gateway: deviceId(2) }] : [];
          return ok({ slice, out });
        },
      }),
    );
    const result = core.step(
      core.emptyState(),
      input({ kind: "frame", link: linkId(4), bytes: new Uint8Array([1]) }),
      deps,
    );
    expect(result.isOk()).toBe(true);
    const order = (kind: string) => MODULE_ORDER.map((name) => `${name}:${kind}`);
    expect(log).toEqual([...order("frame"), ...order("gatewayPacket"), ...order("gatewayDown")]);
    expect(result.isOk() && result.value.effects).toEqual([
      { kind: "close", link: linkId(4), reason: "probe" },
    ]);
  });

  test("runs due timers first, earliest first, each to its owner only; later ones wait", () => {
    const log: string[] = [];
    const handlers = loggingHandlers(log);
    const timers: readonly TimerOf<"alarm">[] = [
      { at: mono(20), key: { module: "alarm", kind: "countdownEnd", sensor: deviceId(3) } },
      { at: mono(5), key: { module: "alarm", kind: "alarmEnd" } },
      { at: mono(999), key: { module: "alarm", kind: "countdownEnd", sensor: deviceId(4) } },
    ];
    const sirenTimer: TimerOf<"sirens"> = {
      at: mono(10),
      key: { module: "sirens", kind: "giveUp", siren: deviceId(5) },
    };
    const core = makeCore(
      withHandlers({
        ...handlers,
        alarm: (slice, message) => {
          log.push(`alarm:${message.kind}`);
          if (message.kind !== "timer") return ok({ slice, out: [] });
          log.push(`alarm fired ${message.at}`);
          return ok({
            slice: { ...slice, timers: slice.timers.filter((t) => t.at !== message.at) },
            out: [],
          });
        },
        sirens: (slice, message) => {
          log.push(`sirens:${message.kind}`);
          if (message.kind === "timer") log.push(`sirens fired ${message.at}`);
          return ok({
            slice: message.kind === "timer" ? { ...slice, timers: [] } : slice,
            out: [],
          });
        },
      }),
    );
    const state = {
      ...core.emptyState(),
      alarm: { ...EMPTY_ALARM_SLICE, timers },
      sirens: { ...EMPTY_SIRENS_SLICE, timers: [sirenTimer] },
    };
    expect(core.nextDeadline(state)).toBe(mono(5));

    const result = core.step(state, input(tick, 100), deps);
    expect(result.isOk()).toBe(true);
    const fired = log.filter((line) => line.includes("fired") || line.endsWith(":timer"));
    expect(fired).toEqual([
      "alarm:timer",
      "alarm fired 5",
      "sirens:timer",
      "sirens fired 10",
      "alarm:timer",
      "alarm fired 20",
    ]);
    // The event comes after every due timer.
    expect(log.indexOf("clock:tick")).toBeGreaterThan(log.indexOf("alarm fired 20"));
    expect(result.isOk() && result.value.wake).toBe(mono(999));
  });

  test("a step that would handle more than 10,000 messages is a CoreFault", () => {
    let handled = 0;
    const core = makeCore(
      withHandlers({
        audit: (slice) => {
          handled++;
          return ok({ slice, out: [{ kind: "gatewayDown", gateway: deviceId(2) }] });
        },
      }),
    );
    const result = core.step(core.emptyState(), input(tick), deps);
    expect(result.isErr() && result.error).toMatchObject({
      kind: "internal",
      event: "tick",
      message: "too many messages in one step",
    });
    expect(handled).toBe(MAX_MESSAGES_PER_STEP);
  });

  test("a fault leaves the state as it was, even after earlier handlers changed theirs", () => {
    const timer: TimerOf<"alarm"> = { at: mono(50), key: { module: "alarm", kind: "alarmEnd" } };
    const core = makeCore(
      withHandlers({
        alarm: () => ok({ slice: { ...EMPTY_ALARM_SLICE, timers: [timer] }, out: [] }),
        sirens: (_, message, ctx) =>
          err(coreFault(ctx.event, "core/sirens", "probe fault", { saw: message.kind })),
      }),
    );
    const before = core.emptyState();
    const snapshot = structuredClone(before);
    const result = core.step(before, input(tick), deps);
    expect(result.isErr() && result.error).toEqual({
      kind: "internal",
      origin: "core/sirens",
      message: "probe fault",
      event: "tick",
      detail: { saw: "tick" },
    });
    expect(before).toEqual(snapshot);
    expect(before.alarm.timers).toEqual([]);
  });

  test("the same state and input give the same output", () => {
    const core = makeCore(
      withHandlers({
        setup: (slice, message, ctx) => {
          if (message.kind !== "frame") return ok({ slice, out: [] });
          return ctx.entropy.take(4).map((random) => ({
            slice,
            out: [
              { kind: "send", link: message.link, bytes: random, ref: sendRef(7), counters: [] },
            ],
          }));
        },
      }),
    );
    const event: HubEvent = { kind: "frame", link: linkId(2), bytes: new Uint8Array([9]) };
    const first = core.step(core.emptyState(), input(event), deps);
    const second = core.step(core.emptyState(), input(event), deps);
    expect(first.isOk()).toBe(true);
    expect(first).toEqual(second);
  });

  test("effects and messages are told apart by kind", () => {
    const effects: readonly Effect[] = [{ kind: "cadence", everyMs: 1000 }];
    const core = makeCore(
      withHandlers({
        clock: (slice, message) => ok({ slice, out: message.kind === "tick" ? effects : [] }),
      }),
    );
    const result = core.step(core.emptyState(), input(tick), deps);
    expect(result.isOk() && result.value.effects).toEqual(effects);
  });
});

describe("the entropy cursor", () => {
  test("hands out the input's 32 bytes in order, and running out is a CoreFault", () => {
    const taken: Uint8Array[] = [];
    const core = makeCore(
      withHandlers({
        gateways: (slice, _, ctx) => {
          for (const length of [8, 4, 16, 4]) {
            const bytes = ctx.entropy.take(length);
            if (bytes.isErr()) return err(bytes.error);
            taken.push(bytes.value);
          }
          return ok({ slice, out: [] });
        },
      }),
    );
    expect(core.step(core.emptyState(), input(tick), deps).isOk()).toBe(true);
    expect(taken.map((bytes) => [...bytes])).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7],
      [8, 9, 10, 11],
      [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
      [28, 29, 30, 31],
    ]);

    const greedy = makeCore(
      withHandlers({
        gateways: (slice, _, ctx) => ctx.entropy.take(33).map(() => ({ slice, out: [] })),
      }),
    );
    const result = greedy.step(greedy.emptyState(), input(tick), deps);
    expect(result.isErr() && result.error).toMatchObject({
      message: "entropy exhausted",
      event: "tick",
    });
  });
});

describe("the record cursor", () => {
  function takingCore(seqs: Seq[]) {
    return makeCore(
      withHandlers({
        intake: (slice, _, ctx) => {
          for (let i = 0; i < 2; i++) {
            const taken = ctx.records.take();
            if (taken.isErr()) return err(taken.error);
            seqs.push(taken.value);
          }
          return ok({ slice, out: [] });
        },
      }),
    );
  }

  test("starts at the boot's first sequence number on a boot input", () => {
    const seqs: Seq[] = [];
    const core = takingCore(seqs);
    expect(core.step(core.emptyState(), input(boot), deps).isOk()).toBe(true);
    expect(seqs).toEqual([seq(3 * 2 ** 32), seq(3 * 2 ** 32 + 1)]);
    expect(recordSeq(bootId(3), 1)).toBe(seq(3 * 2 ** 32 + 1));
  });

  test("otherwise starts where the audit slice says", () => {
    const seqs: Seq[] = [];
    const core = takingCore(seqs);
    const start = seq(3 * 2 ** 32 + 41);
    const state = { ...core.emptyState(), audit: { ...EMPTY_AUDIT_SLICE, nextRecord: start } };
    expect(core.step(state, input(tick), deps).isOk()).toBe(true);
    expect(seqs).toEqual([start, seq(start + 1)]);
  });
});

describe("test builds", () => {
  test("deep-freeze the state after every step, so a mutation fails at once", () => {
    const timer: TimerOf<"alarm"> = { at: mono(50), key: { module: "alarm", kind: "alarmEnd" } };
    const core = makeCore(
      withHandlers({
        alarm: () => ok({ slice: { ...EMPTY_ALARM_SLICE, timers: [timer] }, out: [] }),
      }),
    );
    const result = core.step(core.emptyState(), input(tick), deps);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) return;
    const { state } = result.value;
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.alarm.timers)).toBe(true);
    expect(Object.isFrozen(state.alarm.timers[0]?.key)).toBe(true);
    expect(Reflect.set(state.alarm, "timers", [])).toBe(false);
    expect(Reflect.set(state, "alarm", EMPTY_ALARM_SLICE)).toBe(false);
  });

  test("leave the state unfrozen when not asked", () => {
    const result = step(emptyState(), input(tick), { ...deps, deepFreeze: false });
    expect(result.isOk() && Object.isFrozen(result.value.state)).toBe(false);
  });
});
