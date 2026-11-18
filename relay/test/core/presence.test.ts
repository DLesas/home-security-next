/**
 * The presence core over simulated days (docs/m4-design.md sections 3 and 11): the alert at 180 s
 * and not at 179; the link closed at 75 s; the grace of an announced restart and its end; the
 * fresh clock after a relay restart, with `alerted` kept; `back` only after `unreachable`; once
 * per outage; no targets, no alert. Time is an input; nothing is slept.
 */
import { describe, expect, test } from "bun:test";
import { presenceDeadline, stepOne, stepPresence } from "../../src/core/presence-core.ts";
import type { HubPresence, PresenceInput, PresenceStep } from "../../src/core/presence.ts";
import { PRESENCE_RULES } from "../../src/core/rules.ts";

const ID = "abcdefghijklmnopqrstuvwxyz";
const T0 = Date.UTC(2026, 10, 18, 12);
const S = 1000;

/** Runs inputs in order from an empty map, keeping every step's outputs. */
function run(
  inputs: readonly PresenceInput[],
  start: ReadonlyMap<string, HubPresence> = new Map(),
) {
  let hubs = start;
  const steps: PresenceStep[] = [];
  for (const input of inputs) {
    const step = stepPresence(hubs, input);
    steps.push(step);
    hubs = step.hubs;
  }
  return { hubs, steps, out: steps.flatMap((s) => s.out) };
}

const frame = (atMs: number): PresenceInput => ({ kind: "frame", identity: ID, atMs });
const roster = (atMs: number, hasTargets = true): PresenceInput => ({
  kind: "roster",
  identity: ID,
  hasTargets,
  atMs,
});
const tick = (atMs: number): PresenceInput => ({ kind: "tick", atMs });
const kinds = (out: readonly { kind: string }[]) => out.map((o) => o.kind);

describe("the alert", () => {
  test("is not sent 179.999 s after the last contact, and is at 180 s", () => {
    const before = run([
      frame(T0),
      roster(T0),
      frame(T0 + 10 * S),
      tick(T0 + 10 * S + 180 * S - 1),
    ]);
    expect(kinds(before.out)).not.toContain("sendUnreachable");
    expect(before.hubs.get(ID)?.state).toBe("quiet");
    const at = run([frame(T0), roster(T0), frame(T0 + 10 * S), tick(T0 + 10 * S + 180 * S)]);
    expect(at.out.filter((o) => o.kind === "sendUnreachable")).toEqual([
      { kind: "sendUnreachable", identity: ID },
    ]);
    expect(at.hubs.get(ID)?.state).toBe("alerted");
  });

  test("179 s and 180 s exactly, as the design's test row names them", () => {
    const quiet = run([frame(T0), roster(T0), tick(T0 + 179 * S)]);
    expect(kinds(quiet.out)).not.toContain("sendUnreachable");
    const alerted = run([frame(T0), roster(T0), tick(T0 + 180 * S)]);
    expect(kinds(alerted.out)).toContain("sendUnreachable");
  });

  test("goes once per outage, and `back` only after it", () => {
    const r = run([
      frame(T0),
      roster(T0),
      frame(T0 + 30 * S),
      tick(T0 + 30 * S + 180 * S),
      tick(T0 + 30 * S + 400 * S),
      tick(T0 + 30 * S + 4000 * S),
      frame(T0 + 5000 * S),
      frame(T0 + 5030 * S),
    ]);
    expect(r.out.filter((o) => o.kind === "sendUnreachable")).toHaveLength(1);
    expect(r.out.filter((o) => o.kind === "sendBack")).toHaveLength(1);
    // `back` comes before anything else of the returning frame.
    const backStep = r.steps[6];
    expect(backStep?.out[0]).toEqual({ kind: "sendBack", identity: ID });
    expect(r.hubs.get(ID)?.state).toBe("online");
    // A hub never alerted gets no `back`.
    const never = run([frame(T0), roster(T0), frame(T0 + 60 * S), frame(T0 + 90 * S)]);
    expect(kinds(never.out)).not.toContain("sendBack");
  });

  test("is not sent for a hub without targets, and the next outage alerts again", () => {
    const none = run([frame(T0), tick(T0 + 1000 * S)]);
    expect(kinds(none.out)).not.toContain("sendUnreachable");
    expect(none.steps.at(-1)?.nextWakeMs).toBeNull();
    const twice = run([
      frame(T0),
      roster(T0),
      tick(T0 + 180 * S),
      frame(T0 + 200 * S),
      tick(T0 + 380 * S),
    ]);
    expect(twice.out.filter((o) => o.kind === "sendUnreachable")).toHaveLength(2);
  });

  test("a hub whose roster empties is not alerted", () => {
    const r = run([frame(T0), roster(T0), roster(T0 + S, false), tick(T0 + 200 * S)]);
    expect(kinds(r.out)).not.toContain("sendUnreachable");
  });
});

describe("the silent link", () => {
  test("is closed at 75 s and not at 74.999 s", () => {
    const open = run([frame(T0), tick(T0 + PRESENCE_RULES.silentCloseMs - 1)]);
    expect(kinds(open.out)).not.toContain("closeLink");
    expect(open.hubs.get(ID)?.state).toBe("online");
    const closed = run([frame(T0), tick(T0 + PRESENCE_RULES.silentCloseMs)]);
    expect(closed.out).toContainEqual({ kind: "closeLink", identity: ID });
    expect(closed.hubs.get(ID)?.state).toBe("quiet");
    // Every frame moves the close.
    const kept = run([frame(T0), frame(T0 + 30 * S), tick(T0 + 75 * S)]);
    expect(kinds(kept.out)).not.toContain("closeLink");
  });
});

describe("an announced restart", () => {
  const restarting = (atMs: number, withinMs: number): PresenceInput => ({
    kind: "restarting",
    identity: ID,
    reason: "update",
    withinMs,
    atMs,
  });

  test("is acknowledged and keeps the alert back until its grace end", () => {
    const grace = 300 * S;
    const r = run([frame(T0), roster(T0), restarting(T0 + S, grace), tick(T0 + S + 180 * S)]);
    expect(kinds(r.out)).toContain("restartingAck");
    expect(kinds(r.out)).not.toContain("sendUnreachable");
    expect(r.hubs.get(ID)?.graceEndMs).toBe(T0 + S + grace);
    const justBefore = run([], r.hubs);
    const before = stepPresence(justBefore.hubs, tick(T0 + S + grace - 1));
    expect(kinds(before.out)).not.toContain("sendUnreachable");
    // Not back by the grace end: the alert goes at once, more than 3 minutes having passed.
    const atEnd = stepPresence(r.hubs, tick(T0 + S + grace));
    expect(kinds(atEnd.out)).toContain("sendUnreachable");
  });

  test("a hub back within its grace is never alerted", () => {
    const r = run([
      frame(T0),
      roster(T0),
      restarting(T0 + S, 600 * S),
      tick(T0 + 200 * S),
      frame(T0 + 250 * S),
      tick(T0 + 260 * S),
    ]);
    expect(kinds(r.out)).not.toContain("sendUnreachable");
    expect(kinds(r.out)).not.toContain("sendBack");
  });

  test("the grace is at most 10 minutes, whatever `withinMs` says", () => {
    const r = stepOne(
      { identity: ID, lastContactMs: T0, state: "online", graceEndMs: 0, hasTargets: true },
      restarting(T0, PRESENCE_RULES.graceMaxMs + 1),
    );
    expect(r.hubs.get(ID)?.graceEndMs).toBe(T0 + PRESENCE_RULES.graceMaxMs);
    const shorter = stepOne(
      { identity: ID, lastContactMs: T0, state: "online", graceEndMs: 0, hasTargets: true },
      restarting(T0, PRESENCE_RULES.graceMaxMs - 1),
    );
    expect(shorter.hubs.get(ID)?.graceEndMs).toBe(T0 + PRESENCE_RULES.graceMaxMs - 1);
  });

  test("a grace shorter than 3 minutes changes nothing", () => {
    const r = run([frame(T0), roster(T0), restarting(T0, 60 * S), tick(T0 + 180 * S - 1)]);
    expect(kinds(r.out)).not.toContain("sendUnreachable");
    expect(kinds(stepPresence(r.hubs, tick(T0 + 180 * S)).out)).toContain("sendUnreachable");
  });
});

describe("the relay restarting (D96)", () => {
  test("starts every clock afresh, and keeps `alerted` hubs alerted for their `back`", () => {
    const quiet: HubPresence = {
      identity: ID,
      lastContactMs: T0 - 3600 * S,
      state: "quiet",
      graceEndMs: 0,
      hasTargets: true,
    };
    const alerted: HubPresence = {
      identity: "bbbbbbbbbbbbbbbbbbbbbbbbbb",
      lastContactMs: T0 - 3600 * S,
      state: "alerted",
      graceEndMs: 0,
      hasTargets: true,
    };
    const start = new Map([
      [quiet.identity, quiet],
      [alerted.identity, alerted],
    ]);
    const started = stepPresence(start, { kind: "relayStarted", atMs: T0 });
    expect(started.out).toEqual([]);
    expect(started.hubs.get(ID)?.lastContactMs).toBe(T0);
    expect(started.hubs.get(alerted.identity)).toEqual(alerted);
    expect(started.nextWakeMs).toBe(T0 + 180 * S);
    expect(kinds(stepPresence(started.hubs, tick(T0 + 180 * S - 1)).out)).toEqual([]);
    const at = stepPresence(started.hubs, tick(T0 + 180 * S));
    expect(at.out).toContainEqual({ kind: "sendUnreachable", identity: ID });
    expect(at.out.filter((o) => o.kind === "sendUnreachable")).toHaveLength(1);
    const back = stepPresence(started.hubs, {
      kind: "frame",
      identity: alerted.identity,
      atMs: T0 + 5 * S,
    });
    expect(back.out[0]).toEqual({ kind: "sendBack", identity: alerted.identity });
  });
});

describe("what is stored, and when the core wakes", () => {
  test("a store on each change of state, grace or targets; none for a plain frame", () => {
    const r = run([frame(T0), frame(T0 + 30 * S), frame(T0 + 60 * S)]);
    expect(r.steps.map((s) => kinds(s.out))).toEqual([["store"], [], []]);
    const t = run([frame(T0), roster(T0), roster(T0 + S), tick(T0 + 75 * S)]);
    expect(t.steps.map((s) => kinds(s.out))).toEqual([
      ["store"],
      ["store"],
      [],
      ["closeLink", "store"],
    ]);
  });

  test("the deadline is the close for a linked hub, then the alert, then nothing", () => {
    const linked: HubPresence = {
      identity: ID,
      lastContactMs: T0,
      state: "online",
      graceEndMs: 0,
      hasTargets: true,
    };
    expect(presenceDeadline(linked)).toBe(T0 + 75 * S);
    expect(presenceDeadline({ ...linked, state: "quiet" })).toBe(T0 + 180 * S);
    expect(presenceDeadline({ ...linked, state: "quiet", graceEndMs: T0 + 500 * S })).toBe(
      T0 + 500 * S,
    );
    expect(presenceDeadline({ ...linked, state: "alerted" })).toBeNull();
    expect(presenceDeadline({ ...linked, state: "quiet", hasTargets: false })).toBeNull();
    expect(presenceDeadline({ ...linked, hasTargets: false })).toBe(T0 + 75 * S);
  });

  test("simulated days: a hub pinging every 30 s for two days is never alerted", () => {
    let hubs: ReadonlyMap<string, HubPresence> = stepPresence(new Map(), roster(T0)).hubs;
    let alerts = 0;
    for (let at = T0; at < T0 + 2 * 86_400 * S; at += 30 * S) {
      const step = stepPresence(hubs, frame(at));
      hubs = step.hubs;
      const woke = stepPresence(hubs, tick(at + 29 * S));
      alerts += woke.out.filter((o) => o.kind !== "store").length;
      hubs = woke.hubs;
    }
    expect(alerts).toBe(0);
  });

  test("the map given is left as it was", () => {
    const hub: HubPresence = {
      identity: ID,
      lastContactMs: T0,
      state: "alerted",
      graceEndMs: 0,
      hasTargets: true,
    };
    const given = new Map([[ID, hub]]);
    stepPresence(given, frame(T0 + S));
    expect(given.get(ID)).toBe(hub);
    expect(hub.state).toBe("alerted");
  });
});

describe("a tick makes progress", () => {
  test("after a tick at t, no hub is left due at t: every deadline is later, or none", () => {
    let seed = 11;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let round = 0; round < 2000; round++) {
      const lastContactMs = T0 + (next() % 1000) * S;
      const hub: HubPresence = {
        identity: ID,
        lastContactMs,
        state: (["online", "quiet", "alerted"] as const)[next() % 3] ?? "online",
        graceEndMs: next() % 2 === 0 ? 0 : lastContactMs + (next() % 900) * S,
        hasTargets: next() % 4 !== 0,
      };
      // Ticks at the edges themselves, and between them.
      const edges = [
        lastContactMs + PRESENCE_RULES.silentCloseMs,
        lastContactMs + PRESENCE_RULES.alertAfterMs,
        hub.graceEndMs,
        lastContactMs + (next() % 1200) * S + (next() % 1000),
      ];
      for (const at of edges) {
        const after = stepOne(hub, tick(at)).hubs.get(ID);
        const deadline = after === undefined ? null : presenceDeadline(after);
        if (deadline !== null) expect(deadline).toBeGreaterThan(at);
      }
    }
  });
});

describe("a new link ends the grace (linkJoined)", () => {
  const restarting = (atMs: number, withinMs: number): PresenceInput => ({
    kind: "restarting",
    identity: ID,
    reason: "update",
    withinMs,
    atMs,
  });
  const joined = (atMs: number): PresenceInput => ({ kind: "linkJoined", identity: ID, atMs });

  test("back at once, then silent: the alert goes 180 s after the last contact, not at the grace's end", () => {
    const back = T0 + 20 * S;
    const r = run([frame(T0), roster(T0), restarting(T0 + S, 600 * S), joined(back)]);
    expect(r.hubs.get(ID)?.graceEndMs).toBe(0);
    expect(kinds(stepPresence(r.hubs, tick(back + 180 * S - 1)).out)).not.toContain(
      "sendUnreachable",
    );
    expect(kinds(stepPresence(r.hubs, tick(back + 180 * S)).out)).toContain("sendUnreachable");
  });

  test("never back: the alert goes at the grace's end, as before", () => {
    const r = run([frame(T0), roster(T0), restarting(T0, 600 * S), tick(T0 + 600 * S - 1)]);
    expect(kinds(r.out)).not.toContain("sendUnreachable");
    expect(kinds(stepPresence(r.hubs, tick(T0 + 600 * S)).out)).toContain("sendUnreachable");
  });

  test("a second announcement after a return starts a new grace", () => {
    const r = run([
      frame(T0),
      roster(T0),
      restarting(T0, 600 * S),
      joined(T0 + 30 * S),
      restarting(T0 + 60 * S, 400 * S),
    ]);
    expect(r.hubs.get(ID)?.graceEndMs).toBe(T0 + 460 * S);
    expect(kinds(stepPresence(r.hubs, tick(T0 + 460 * S - 1)).out)).not.toContain(
      "sendUnreachable",
    );
    expect(kinds(stepPresence(r.hubs, tick(T0 + 460 * S)).out)).toContain("sendUnreachable");
  });

  test("is a contact: an alerted hub gets `back` first, and a plain frame keeps the grace", () => {
    const alerted: HubPresence = {
      identity: ID,
      lastContactMs: T0,
      state: "alerted",
      graceEndMs: 0,
      hasTargets: true,
    };
    expect(stepOne(alerted, joined(T0 + 900 * S)).out[0]).toEqual({
      kind: "sendBack",
      identity: ID,
    });
    const r = run([frame(T0), roster(T0), restarting(T0, 600 * S), frame(T0 + 30 * S)]);
    expect(r.hubs.get(ID)?.graceEndMs).toBe(T0 + 600 * S);
  });
});
