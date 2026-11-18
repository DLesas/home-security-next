/**
 * The relay link's records and warning (docs/m4-design.md section 4, "Records"): `relay_unreachable`
 * after 180 s ‡ down, once per outage, never before; `relay_reachable` after it; one `relay_link`
 * per hour ‡ with ups, downs and the longest down; `relay_identity_in_use` once per outage;
 * events of another relay ignored; the roster made afresh every day ‡.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_RULES } from "../../../src/core/model/rules.ts";
import {
  DAY_US,
  HOUR_US,
  householdSnapshot,
  hubEvents,
  LOCAL_URL,
  MINUTE_US,
  relayRunner,
  rosters,
  type Runner,
  SECOND_US,
} from "./support.ts";

const UNREACHABLE_US = DEFAULT_RULES.relay.unreachableAfterMs * 1000;

function upRunner(): Runner {
  const runner = relayRunner();
  runner.up();
  return runner;
}

describe("relay_unreachable (a warning, written now, once per outage)", () => {
  test("180 s ‡ after the link went down, not a microsecond before", () => {
    const runner = upRunner();
    runner.down("noPong");
    expect(hubEvents(runner.run(UNREACHABLE_US - 1).out)).toEqual([]);
    expect(hubEvents(runner.run(1).out)).toEqual([
      {
        code: "relay_unreachable",
        durability: "now",
        level: "warning",
        detail: { reason: "noPong" },
      },
    ]);
    expect(hubEvents(runner.run(HOUR_US).out).map((e) => e.code)).not.toContain(
      "relay_unreachable",
    );
  });

  test("counted from the start when the hub never joins", () => {
    const runner = relayRunner();
    runner.down("dns");
    runner.down("connect");
    expect(hubEvents(runner.run(UNREACHABLE_US - 1).out)).toEqual([]);
    expect(hubEvents(runner.run(1).out).map((e) => e.detail)).toEqual([{ reason: "connect" }]);
  });

  test("a link back within 180 s: no warning, no reachable", () => {
    const runner = upRunner();
    runner.down();
    runner.run(UNREACHABLE_US - 1);
    expect(hubEvents(runner.up().out)).toEqual([]);
    expect(runner.timerAt("unreachable")).toBeUndefined();
    expect(hubEvents(runner.run(HOUR_US / 2).out)).toEqual([]);
  });

  test("relay_reachable (info, routine) when it is back after the warning, with how long it was down", () => {
    const runner = upRunner();
    runner.down();
    runner.run(5 * MINUTE_US);
    expect(hubEvents(runner.up().out)).toEqual([
      {
        code: "relay_reachable",
        durability: "routine",
        level: "info",
        detail: { downMs: 300_000 },
      },
    ]);
    // A new outage warns again.
    runner.down();
    expect(hubEvents(runner.run(UNREACHABLE_US).out).map((e) => e.code)).toEqual([
      "relay_unreachable",
    ]);
  });

  test("relay_reachable after an outage that began at the start says no length (nothing to measure from)", () => {
    const runner = relayRunner();
    runner.run(UNREACHABLE_US);
    expect(hubEvents(runner.up().out)).toEqual([
      { code: "relay_reachable", durability: "routine", level: "info", detail: { downMs: null } },
    ]);
  });

  test("no relay in use: nothing counts", () => {
    const runner = relayRunner(householdSnapshot());
    runner.down("dns", LOCAL_URL);
    expect(runner.slice.timers).toEqual([]);
    expect(runner.run(DAY_US).out).toEqual([]);
  });
});

describe("relay_link (info, routine, one per hour ‡ with any change)", () => {
  test("ups and downs of the hour, the longest down, once; nothing in an hour without change", () => {
    const runner = relayRunner();
    runner.up(); // the period starts: an up, no down before it to measure
    runner.run(10 * MINUTE_US);
    runner.down();
    runner.run(20 * SECOND_US);
    runner.up();
    runner.run(5 * MINUTE_US);
    runner.down();
    runner.run(90 * SECOND_US);
    runner.up();
    const due = runner.run(
      HOUR_US - 10 * MINUTE_US - 20 * SECOND_US - 5 * MINUTE_US - 90 * SECOND_US - 1,
    );
    expect(hubEvents(due.out)).toEqual([]);
    expect(hubEvents(runner.run(1).out)).toEqual([
      {
        code: "relay_link",
        durability: "routine",
        level: "info",
        detail: { ups: 3, downs: 2, longestDownMs: 90_000 },
      },
    ]);
    expect(runner.timerAt("linkRecord")).toBeUndefined();
    expect(hubEvents(runner.run(3 * HOUR_US).out)).toEqual([]);
  });

  test("a down still going at the hour's end counts up to then", () => {
    const runner = upRunner();
    runner.run(HOUR_US);
    runner.run(10 * MINUTE_US);
    runner.down();
    const events = hubEvents(runner.run(HOUR_US).out);
    expect(events.find((e) => e.code === "relay_link")?.detail).toEqual({
      ups: 0,
      downs: 1,
      longestDownMs: 3_600_000,
    });
  });

  test("a second up while up, and a down while down, are not counted", () => {
    const runner = upRunner();
    expect(runner.up().out).toEqual([]);
    runner.down();
    runner.down("closed");
    expect(runner.slice.tally).toEqual({ ups: 1, downs: 1, longestDownMs: 0 });
  });
});

describe("relay_identity_in_use (a warning, written now)", () => {
  test("when another computer joined with this hub's key, once per outage", () => {
    const runner = upRunner();
    const replaced = runner.down("replaced");
    expect(hubEvents(replaced.out)).toEqual([
      { code: "relay_identity_in_use", durability: "now", level: "warning", detail: null },
    ]);
    expect(hubEvents(runner.down("replaced").out)).toEqual([]);
    runner.up();
    expect(hubEvents(runner.down("replaced").out).map((e) => e.code)).toEqual([
      "relay_identity_in_use",
    ]);
  });

  test("also when it happens while the hub is still trying to join", () => {
    const runner = relayRunner();
    expect(hubEvents(runner.down("replaced").out).map((e) => e.code)).toEqual([
      "relay_identity_in_use",
    ]);
  });
});

describe("the link and its URL", () => {
  test("an event for another relay than the one in use is ignored", () => {
    const runner = relayRunner();
    expect(runner.up("wss://other.example.com").out).toEqual([]);
    expect(runner.slice.link.kind).toBe("down");
    runner.up();
    expect(runner.down("noPong", "wss://other.example.com").out).toEqual([]);
    expect(runner.slice.link.kind).toBe("up");
  });

  test("the roster is made afresh every day ‡ while up, and not while down", () => {
    const runner = upRunner();
    expect(rosters(runner.run(DAY_US - 1).out)).toEqual([]);
    expect(rosters(runner.run(1).out).map((r) => r.rev)).toEqual([2]);
    runner.down();
    expect(runner.timerAt("rosterRefresh")).toBeUndefined();
    expect(rosters(runner.run(2 * DAY_US).out)).toEqual([]);
  });
});
