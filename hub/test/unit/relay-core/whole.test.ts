/**
 * The relay module in the real dispatcher with every other module (hub-design.md section 2):
 *
 * - with no relay set, the hub behaves exactly as it did with step 0's stub: the same effects at
 *   every step and the same state in every other module, phones registered or not;
 * - with a relay set and the link up, an arming by `hsn` reaches a registered phone: `alarm` and
 *   `layout` decide, `notify` raises it for the clients its categories let through, and relay
 *   pushes it in the same step.
 */
import { describe, expect, test } from "bun:test";
import { ok } from "neverthrow";
import type { Effect } from "../../../src/core/model/effects.ts";
import type { DurableSnapshot, HubEvent } from "../../../src/core/model/events.ts";
import type { Handler } from "../../../src/core/model/handler.ts";
import { bootId, connId, outboxId, requestId } from "../../../src/core/model/ids.ts";
import type { HubState } from "../../../src/core/model/state.ts";
import { type Mono, mono } from "../../../src/core/model/time.ts";
import { type Core, makeCore, MODULES } from "../../../src/core/step.ts";
import {
  ANNA_LAPTOP,
  ANNA_PHONE,
  BEN_PHONE,
  depsWith,
  householdSnapshot,
  LOCAL_URL,
  MAX_STEPS_AT_ONE_INSTANT,
  MINUTE_US,
  relaySnapshot,
  SECOND_US,
  targetRow,
  WALL0,
} from "./support.ts";

/** Step 0's stub, as it was: nothing changes; its own operations are answered `notBuilt`. */
const stubRelay: Handler<"relay"> = (slice, message) =>
  ok(
    message.kind === "v2OpRequest" && message.owner === "relay"
      ? {
          slice,
          out: [
            {
              kind: "opAnswer",
              answerTo: message.answerTo,
              outcome: { ok: false, error: { code: "notBuilt", detail: { op: message.op.op } } },
            },
          ],
        }
      : { slice, out: [] },
  );

class Hub {
  readonly core: Core;
  state: HubState;
  at: Mono = mono(SECOND_US);
  readonly effects: (readonly Effect[])[] = [];

  constructor(core: Core) {
    this.core = core;
    this.state = core.emptyState();
  }

  input(event: HubEvent): readonly Effect[] {
    const stepped = this.core.step(
      this.state,
      {
        now: { mono: this.at, wall: WALL0 + Math.floor(this.at / 1000), wallTrusted: true },
        entropy: new Uint8Array(32).fill(7),
        event,
      },
      depsWith(),
    );
    expect(stepped.isOk() ? "" : stepped.error.message).toBe("");
    if (stepped.isErr()) return [];
    this.state = stepped.value.state;
    this.effects.push(stepped.value.effects);
    return stepped.value.effects;
  }

  /**
   * Moves on by `us`, with a tick at every wake on the way. More than `MAX_STEPS_AT_ONE_INSTANT`
   * ticks at one instant is a deadline that never clears: the test fails at once, not spins. After
   * each tick, no relay deadline is at or before its time.
   */
  run(us: number): void {
    const until = this.at + us;
    let atOneInstant = 0;
    for (;;) {
      const wake = this.core.nextDeadline(this.state);
      if (wake === undefined || wake > until) break;
      if (wake > this.at) atOneInstant = 0;
      this.at = mono(Math.max(this.at, wake));
      atOneInstant += 1;
      expect(Math.min(atOneInstant, MAX_STEPS_AT_ONE_INSTANT + 1)).toBeLessThanOrEqual(
        MAX_STEPS_AT_ONE_INSTANT,
      );
      this.input({ kind: "tick" });
      expect(this.state.relay.timers.filter((t) => t.at <= this.at)).toEqual([]);
    }
    this.at = mono(until);
  }
}

let request = 1;
function command(command: Extract<HubEvent, { kind: "command" }>["command"]): HubEvent {
  return {
    kind: "command",
    request: requestId(request++),
    conn: connId(7),
    actor: "dimitri",
    command,
  };
}

/** A day's worth of inputs that touch the relay module's messages. */
function drive(hub: Hub, snapshot: DurableSnapshot): void {
  request = 1;
  hub.input({
    kind: "boot",
    snapshot,
    boot: { id: bootId(1), previousExit: "clean", cause: undefined },
  });
  hub.input({ kind: "relayLink", state: "up", url: LOCAL_URL, roles: ["relay"] });
  hub.input(command({ kind: "arm", sensors: "all", continue: true }));
  hub.run(10 * MINUTE_US);
  hub.input({ kind: "pushResults", results: [{ id: outboxId(1), outcome: "accepted" }] });
  hub.input(command({ kind: "disarm", sensors: ["garage"] }));
  hub.input({ kind: "relayLink", state: "down", url: LOCAL_URL, reason: "noPong" });
  hub.run(30 * MINUTE_US);
  hub.input(command({ kind: "disarm", sensors: "all" }));
  hub.run(24 * 60 * MINUTE_US);
}

function withoutRelay(state: HubState): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(state).filter(([module]) => module !== "relay"));
}

describe("no relay set: every other module exactly as with the stub", () => {
  for (const [name, snapshot] of [
    ["no phone registered", householdSnapshot()],
    [
      "phones registered",
      householdSnapshot({ pushTargets: [targetRow(ANNA_PHONE), targetRow(BEN_PHONE)] }),
    ],
  ] as const) {
    test(name, () => {
      const real = new Hub(makeCore(MODULES));
      const stub = new Hub(
        makeCore({ ...MODULES, relay: { ...MODULES.relay, handle: stubRelay } }),
      );
      drive(real, snapshot);
      drive(stub, snapshot);
      // Booted, relay's slice is never touched again: with no relay it keeps nothing.
      const afterBoot = new Hub(makeCore(MODULES));
      afterBoot.input({
        kind: "boot",
        snapshot,
        boot: { id: bootId(1), previousExit: "clean", cause: undefined },
      });
      expect(real.state.relay).toEqual(afterBoot.state.relay);
      expect(real.effects.length).toBeGreaterThan(10);
      expect(real.effects).toEqual(stub.effects);
      expect(withoutRelay(real.state)).toEqual(withoutRelay(stub.state));
      expect(real.state.relay.outbox.size).toBe(0);
      expect(real.state.relay.timers).toEqual([]);
    });
  }
});

describe("a relay set: from an arming to a push, in one step", () => {
  test("hsn arms everything (a switch to Away); its notice is pushed to each phone notify names", () => {
    const hub = new Hub(makeCore(MODULES));
    hub.input({
      kind: "boot",
      snapshot: relaySnapshot([ANNA_PHONE, BEN_PHONE]),
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
    const up = hub.input({ kind: "relayLink", state: "up", url: LOCAL_URL, roles: ["relay"] });
    expect(up.filter((e) => e.kind === "relayRoster")).toHaveLength(1);
    const armed = hub.input(command({ kind: "arm", sensors: "all", continue: true }));
    const sent = armed.filter((e) => e.kind === "pushSend");
    // Anna views every sensor, Ben two of them: both are told of the arming (armDisarm).
    expect(sent.map((e) => e.client).toSorted()).toEqual([ANNA_PHONE, BEN_PHONE]);
    for (const push of sent) {
      expect(push.content.n.kind).toBe("mode_switched");
      expect(push.content.armed).toBe(true);
      expect(push.content.delayed).toBe(false);
    }
    // The laptop and the console are told in their sessions, never pushed.
    expect(sent.some((e) => e.client === ANNA_LAPTOP)).toBe(false);
    // The arming flipped "any sensor armed": the roster's alerts were made again.
    expect(armed.filter((e) => e.kind === "relayRoster")).toHaveLength(1);
    // The outbox rows are written in the same step as the notification, routine (not critical).
    const rows = armed.filter((e) => e.kind === "write" && e.op.table === "push_outbox");
    expect(rows.map((e) => (e.kind === "write" ? e.durability : ""))).toEqual([
      "routine",
      "routine",
    ]);
  });
});
