/**
 * The relay's address (docs/m4-design.md sections 2 and 9): the default (none while the domain is a
 * placeholder), `relay.set`'s rule at its edges and as `@hsn/deployment` has it, the revision, the
 * shell told when the relay in use changes, `relay.status`, and who may ask.
 */
import { describe, expect, test } from "bun:test";
import { relayStatusObject, RELAY_SET_REFUSALS } from "@hsn/protocol/app";
import {
  isLocalHost as deploymentIsLocal,
  relaySettingProblems,
} from "../../../../packages/deployment/src/deployment.ts";
import { isLocalHost, relaySetRefusal, statusOf } from "../../../src/core/relay/settings.ts";
import { bootId } from "../../../src/core/model/ids.ts";
import { relayForLinkCode, relayInUse, relayStatus } from "../../../src/core/relay/view.ts";
import {
  ANNA_PHONE,
  BEN_PHONE,
  bootedView,
  CONSOLE,
  COMPUTER,
  householdSnapshot,
  LOCAL_URL,
  personActor,
  relayRunner,
  relaySnapshot,
  Runner,
  SECOND_US,
  pushes,
  WALL0,
  writes,
} from "./support.ts";

function fresh(url: string | null = null, revision = 0): Runner {
  const snapshot =
    url === null && revision === 0 ? householdSnapshot() : relaySnapshot([], { url, revision });
  return relayRunner(snapshot);
}

describe("the default relay", () => {
  const DEFAULT = "wss://relay.example.com";

  test("is the boot input's: a hub with no setting connects to it, as the default", () => {
    const snapshot = householdSnapshot();
    const runner = new Runner(bootedView(snapshot));
    const booted = runner.boot(snapshot, DEFAULT);
    expect(booted.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: DEFAULT },
    ]);
    expect(relayStatus(runner.view)).toMatchObject({
      url: DEFAULT,
      isDefault: true,
      state: "down",
    });
    expect(relayInUse(runner.view)).toEqual({ url: DEFAULT });
    // The default needs no `r=` in a link code.
    expect(relayForLinkCode(runner.view)).toBeNull();
    expect(runner.timerAt("unreachable")).toBeDefined();
  });

  test("a boot without one (a test's, or a build that names no relay) reads it as none", () => {
    const snapshot = householdSnapshot();
    const runner = new Runner(bootedView(snapshot));
    runner.send({
      kind: "boot",
      snapshot,
      boot: { id: bootId(1), previousExit: "clean", cause: undefined },
    });
    expect(runner.slice.link).toEqual({ kind: "off" });
  });

  test("a setting wins over the default; back to null returns to the default, the shell told", () => {
    const runner = relayRunner(householdSnapshot(), undefined, DEFAULT);
    const set = runner.op({ op: "relay.set", body: { url: LOCAL_URL } });
    expect(set.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: LOCAL_URL },
    ]);
    expect(relayForLinkCode(runner.view)).toBe(LOCAL_URL);
    const back = runner.op({ op: "relay.set", body: { url: null } });
    expect(back.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: DEFAULT },
    ]);
    expect(back.answer).toMatchObject({
      ok: true,
      body: { url: DEFAULT, isDefault: true, state: "down" },
    });
    // Setting the default's own URL: a setting, but the relay in use does not change.
    const same = runner.op({ op: "relay.set", body: { url: DEFAULT } });
    expect(same.effects.filter((e) => e.kind === "relayConnect")).toEqual([]);
    expect(relayForLinkCode(runner.view)).toBeNull();
    expect(relayStatus(runner.view).isDefault).toBe(false);
  });

  test("a hub with no setting is off: no relayConnect at boot, no timers, status off", () => {
    const snapshot = householdSnapshot();
    const runner = new Runner(bootedView(snapshot));
    const booted = runner.boot(snapshot);
    expect(booted.effects.filter((e) => e.kind === "relayConnect")).toEqual([]);
    expect(runner.slice.timers).toEqual([]);
    expect(statusOf(runner.slice)).toEqual({
      url: null,
      isDefault: true,
      state: "off",
      sinceMs: null,
      roles: [],
    });
    expect(relayInUse(runner.view)).toBeNull();
    expect(relayForLinkCode(runner.view)).toBeNull();
  });

  test("a hub with a relay set connects to it at boot and starts down", () => {
    const snapshot = relaySnapshot([]);
    const runner = new Runner(bootedView(snapshot));
    const booted = runner.boot(snapshot);
    expect(booted.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: LOCAL_URL },
    ]);
    const status = relayStatus(runner.view);
    expect(status).toEqual({
      url: LOCAL_URL,
      isDefault: false,
      state: "down",
      sinceMs: null,
      roles: [],
    });
    expect(relayStatusObject.safeParse(status).success).toBe(true);
    expect(relayInUse(runner.view)).toEqual({ url: LOCAL_URL });
    expect(relayForLinkCode(runner.view)).toBe(LOCAL_URL);
  });
});

describe("relay.set's rule (m4-design section 2)", () => {
  const accepted = [
    "wss://relay.example.com",
    "wss://relay.example.com/",
    "wss://relay.example.com:443",
    "wss://relay.example.com:1",
    "wss://relay.example.com:65535",
    "wss://203.0.113.9",
    "wss://[2001:db8::1]:8480",
    "ws://localhost:8480",
    "ws://LOCALHOST",
    "ws://127.0.0.1:8480",
    "ws://127.255.255.255",
    "ws://10.0.0.1",
    "ws://10.255.255.255",
    "ws://172.16.0.1",
    "ws://172.31.255.255",
    "ws://192.168.0.1",
    "ws://192.168.255.255:8480/",
    "ws://[::1]:8480",
    "ws://[fc00::1]",
    "ws://[fd12:3456::1]",
    "ws://[fdff::1]",
  ];
  const notLocal = [
    "ws://relay.example.com",
    "ws://relay.local",
    "ws://9.255.255.255",
    "ws://11.0.0.1",
    "ws://172.15.255.255",
    "ws://172.32.0.1",
    "ws://192.167.255.255",
    "ws://192.169.0.1",
    "ws://169.254.1.1",
    "ws://203.0.113.9",
    "ws://[fe80::1]",
    "ws://[fbff::1]",
    "ws://[fe00::1]",
    "ws://[2001:db8::1]",
    "ws://256.1.1.1",
  ];
  const format = [
    "http://relay.example.com",
    "https://relay.example.com",
    "wss://",
    "wss://relay.example.com/v1",
    "wss://relay.example.com/v1/hub",
    "wss://user@relay.example.com",
    "wss://user:pass@relay.example.com",
    "wss://relay.example.com:0",
    "wss://relay.example.com:65536",
    "wss://relay.example.com:",
    "wss://relay.example.com?x=1",
    "wss://relay.example.com#f",
    "wss://relay .example.com",
    "ws://::1",
    "wss://[::1",
  ];

  test.each(accepted)("%s is accepted", (url) => {
    expect(relaySetRefusal(url)).toBeUndefined();
  });
  test.each(notLocal)("%s is refused notLocal", (url) => {
    expect(relaySetRefusal(url)).toEqual(RELAY_SET_REFUSALS.notLocal);
  });
  test.each(format)("%s is refused format", (url) => {
    expect(relaySetRefusal(url)).toEqual(RELAY_SET_REFUSALS.format);
  });

  /**
   * Where the two differ, ours is the stricter: WHATWG URL parsing accepts port 0, an empty port
   * and IPv4 shorthand (`127.1` read as 127.0.0.1); `relay.set` refuses them.
   */
  const stricter = ["wss://relay.example.com:0", "wss://relay.example.com:", "ws://127.1"];

  test("never accepts what @hsn/deployment's rule refuses, and agrees with it but where stricter", () => {
    for (const url of [...accepted, ...notLocal, ...format, ...stricter]) {
      const theirs = relaySettingProblems(url).length === 0;
      const ours = relaySetRefusal(url) === undefined;
      if (ours) expect({ url, theirs }).toEqual({ url, theirs: true });
      // `http(s)://` is refused by `relay.set`'s schema before the rule.
      if (!ours && !url.startsWith("http") && !stricter.includes(url)) {
        expect({ url, theirs }).toEqual({ url, theirs: false });
      }
    }
    for (const url of stricter) {
      expect(relaySetRefusal(url)).toBeDefined();
      expect(relaySettingProblems(url)).toEqual([]);
    }
  });

  test("isLocalHost is the deployment's", () => {
    const hosts = [
      "localhost",
      "127.0.0.1",
      "126.255.255.255",
      "128.0.0.1",
      "10.0.0.0",
      "9.0.0.1",
      "172.16.0.0",
      "172.15.0.1",
      "172.31.0.1",
      "172.32.0.1",
      "192.168.1.1",
      "192.169.1.1",
      "::1",
      "::2",
      "fc00::",
      "fdff:ffff::1",
      "fe00::1",
      "fbff::1",
      "[fd00::1]",
      "example.com",
      "300.0.0.1",
    ];
    for (const host of hosts)
      expect({ host, ours: isLocalHost(host) }).toEqual({ host, ours: deploymentIsLocal(host) });
  });
});

describe("relay.set", () => {
  test("a new setting: written now with the next revision, the shell told, the link down", () => {
    const runner = fresh();
    runner.advance(5 * SECOND_US);
    const set = runner.op({ op: "relay.set", body: { url: LOCAL_URL } }, CONSOLE);
    expect(writes(set.out)).toEqual([
      {
        kind: "write",
        durability: "now",
        op: { table: "relay_settings", op: "upsert", row: { url: LOCAL_URL, revision: 1 } },
      },
    ]);
    expect(set.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: LOCAL_URL },
    ]);
    expect(set.answer).toEqual({
      ok: true,
      body: {
        url: LOCAL_URL,
        isDefault: false,
        state: "down",
        sinceMs: WALL0 + 5000,
        roles: [],
      },
    });
    expect(runner.timerAt("unreachable")).toBeDefined();
  });

  test("the same setting again changes nothing and tells the shell nothing", () => {
    const runner = fresh(LOCAL_URL, 4);
    const set = runner.op({ op: "relay.set", body: { url: LOCAL_URL } });
    expect(writes(set.out)).toEqual([]);
    expect(set.effects.filter((e) => e.kind === "relayConnect")).toEqual([]);
    expect(runner.slice.settings).toEqual({ url: LOCAL_URL, revision: 4 });
    expect(set.answer?.ok).toBe(true);
  });

  test("back to the default: written, the link off (the default is none), the outage over", () => {
    const runner = fresh(LOCAL_URL, 4);
    runner.up();
    const set = runner.op({ op: "relay.set", body: { url: null } });
    expect(writes(set.out).map((w) => w.op)).toEqual([
      { table: "relay_settings", op: "upsert", row: { url: null, revision: 5 } },
    ]);
    expect(set.effects.filter((e) => e.kind === "relayConnect")).toEqual([
      { kind: "relayConnect", url: null },
    ]);
    expect(runner.slice.link).toEqual({ kind: "off" });
    expect(runner.timerAt("unreachable")).toBeUndefined();
    expect(runner.timerAt("rosterRefresh")).toBeUndefined();
    expect(set.answer).toEqual({
      ok: true,
      body: { url: null, isDefault: true, state: "off", sinceMs: runner.now.wall, roles: [] },
    });
  });

  test("another relay while up: the link starts again from down; events of the old one are ignored", () => {
    const runner = relayRunner(relaySnapshot([ANNA_PHONE], { url: LOCAL_URL, revision: 1 }));
    runner.up();
    runner.raise({
      kind: "battery_low",
      category: "batteryLow",
      critical: false,
      device: null,
      clients: [ANNA_PHONE],
    });
    expect([...runner.slice.outbox.values()].map((p) => p.inFlight)).toEqual([true]);
    const other = "wss://relay.example.com";
    runner.op({ op: "relay.set", body: { url: other } });
    expect(runner.slice.link).toEqual({ kind: "down", reason: undefined });
    // What was in flight on the old relay is sent again on the new one.
    expect([...runner.slice.outbox.values()].map((p) => p.inFlight)).toEqual([false]);
    expect(runner.timerAt("rosterRefresh")).toBeUndefined();
    expect(runner.up(LOCAL_URL).out).toEqual([]);
    expect(runner.slice.link.kind).toBe("down");
    const up = runner.up(other);
    expect(runner.slice.link.kind).toBe("up");
    expect(pushes(up.out).map((p) => p.client)).toEqual([ANNA_PHONE]);
  });

  test("a refused URL writes nothing", () => {
    const runner = fresh();
    const set = runner.op({ op: "relay.set", body: { url: "ws://relay.example.com" } });
    expect(set.answer).toEqual({ ok: false, error: RELAY_SET_REFUSALS.notLocal });
    expect(writes(set.out)).toEqual([]);
    expect(runner.slice.settings).toEqual({ url: null, revision: 0 });
  });
});

describe("who may ask (manage system)", () => {
  test("hsn, the console and Anna may; Ben, without manage system, may not", () => {
    for (const actor of [COMPUTER, CONSOLE, personActor(ANNA_PHONE)]) {
      const runner = fresh();
      expect(runner.op({ op: "relay.status", body: {} }, actor).answer?.ok).toBe(true);
      expect(runner.op({ op: "relay.set", body: { url: LOCAL_URL } }, actor).answer?.ok).toBe(true);
    }
    const runner = fresh();
    const refusal = {
      ok: false as const,
      error: { code: "unauthorized" as const, detail: { permission: "manageSystem" as const } },
    };
    expect(runner.op({ op: "relay.status", body: {} }, personActor(BEN_PHONE)).answer).toEqual(
      refusal,
    );
    const set = runner.op({ op: "relay.set", body: { url: LOCAL_URL } }, personActor(BEN_PHONE));
    expect(set.answer).toEqual(refusal);
    expect(writes(set.out)).toEqual([]);
  });
});

describe("relay.status", () => {
  test("up with the welcome's roles; down with the last failure; since when", () => {
    const runner = fresh(LOCAL_URL, 1);
    runner.advance(10 * SECOND_US);
    runner.up(LOCAL_URL, ["relay", "releases", "somethingNew"]);
    expect(runner.op({ op: "relay.status", body: {} }).answer).toEqual({
      ok: true,
      body: {
        url: LOCAL_URL,
        isDefault: false,
        state: "up",
        sinceMs: WALL0 + 10_000,
        roles: ["relay", "releases"],
      },
    });
    runner.advance(SECOND_US);
    runner.down("tls");
    const status = relayStatus(runner.view);
    expect(status).toEqual({
      url: LOCAL_URL,
      isDefault: false,
      state: "down",
      sinceMs: WALL0 + 11_000,
      lastError: "tls",
      roles: [],
    });
    expect(relayStatusObject.safeParse(status).success).toBe(true);
    // A second failure while down changes the error, not since when.
    runner.advance(SECOND_US);
    runner.down("dns");
    expect(relayStatus(runner.view)).toMatchObject({ lastError: "dns", sinceMs: WALL0 + 11_000 });
  });
});
