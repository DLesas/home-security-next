/**
 * The relay's crash points (docs/m4-design.md section 4, "The outbox (D102)" and "New tables"; HD
 * 4's table, "What a crash leaves behind"), on the whole hub of `test/world/home.ts` with M2's
 * household, a phone, and a relay client that answers at once (`../budget/relay-world.ts`): power
 * lost at each point of the table in the turn that commits each, then the restart from the disk.
 *
 * - A push registration (`push_targets` and `push_keys`, now): answered only after its commit;
 *   its target and its key on the disk together or not at all, never the key in its `commands`
 *   row; the roster the relay is given after the restart names the phone exactly when it is on the
 *   disk; retried with the same `seq`, done once.
 * - The outbox across an outage: a countdown raised while the relay link is down (its row written
 *   now, with its notification) is pushed once when the link is back, whether the cut lost it (the
 *   door's report is then sent again and the countdown raised again) or kept it.
 *
 * A release fetch cut off by a power cut is `relay-fetch-kill.test.ts`: the fetch is the relay
 * client's, which this world does not run, so it is cut there in the real hub (`kill -9`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AppReplyV2 } from "@hsn/protocol/app";
import { type ClientId, clientId, type ConnId, connId } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import { homePorts, seedHousehold } from "../budget/household.ts";
import { ScriptedRelayClient, seedPhones } from "../budget/relay-world.ts";
import { CRASH_POINTS, type CrashPoint, Home, HOUR, SECOND } from "../world/home.ts";
import { DAY_TEST_TIMEOUT_MS } from "../world/timeouts.ts";

/** Ben's phone (kind 2), added to the household. */
const PHONE = clientId(30);
const BEN = 2;
const REGISTER = {
  op: "push.register",
  body: {
    platform: "fcm",
    environment: "production",
    token: "fcm-token-of-bens-phone".padEnd(40, "x"),
    keyId: "0102030405060708",
    key: Buffer.from(new Uint8Array(32).fill(0x5c)).toString("base64url"),
  },
} as const;

let home: Home | undefined;
afterEach(() => {
  home?.close();
  home = undefined;
});

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

/** A small home with the household, Ben's phone, the relay in use and its link up, at 01:00. */
async function relayHome(
  seed: number,
  registered: boolean,
): Promise<{ readonly home: Home; readonly relay: ScriptedRelayClient }> {
  const ports = homePorts();
  const relay = new ScriptedRelayClient();
  const made = await Home.create(
    {
      name: "relay",
      sensors: 2,
      sirens: 1,
      gateways: 1,
      seed,
      calendar: ports.calendar,
      files: ports.files,
      relay,
    },
    (store) => {
      seedHousehold(store);
      seedPhones(store, [{ client: PHONE, person: BEN }], { registered });
    },
  );
  home = made;
  ports.attach(made);
  relay.home = made;
  relay.connectNow();
  made.input({
    kind: "hubFacts",
    version: "0.1.0",
    addresses: ["192.168.1.20"],
    appsPort: 8444,
    consolePort: 8445,
    certificateSha256: new Uint8Array(32),
  });
  made.input({ kind: "timeZone", zone: "Europe/London" });
  must(made.advanceTo(HOUR));
  return { home: made, relay };
}

let conns = 7000;
let ids = 0;

/** A version 2 session of the phone through the relay, as the channel gives it. */
function phoneSession(h: Home, client: ClientId): ConnId {
  const conn = connId(conns++);
  h.input({ kind: "clientConnected", conn, client, listener: "relay", proto: 2, app: "2.0.0" });
  return conn;
}

function request(h: Home, conn: ConnId, client: ClientId, seq: number): number {
  const id = ++ids;
  h.input({ kind: "clientRequest", conn, client, request: { id, seq, op: REGISTER } });
  return id;
}

function replyTo(h: Home, conn: ConnId, id: number): AppReplyV2 | undefined {
  for (const e of h.app)
    if (
      e.kind === "appSend" &&
      e.conn === conn &&
      "t" in e.message &&
      e.message.t === "res" &&
      e.message.id === id
    )
      return e.message;
  return undefined;
}

const rows = (h: Home, table: "push_targets" | "push_keys"): number =>
  h.query<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE client_id = ?`, PHONE)[0]?.n ??
  0;

describe.each(CRASH_POINTS.map((p) => [p]))("power lost at %s", (point: CrashPoint) => {
  test(
    "a push registration: on the disk whole or not at all, answered only after; the roster after the restart agrees; retried, done once",
    async () => {
      const { home: h, relay } = await relayHome(41, false);
      const conn = phoneSession(h, PHONE);
      const restarts = h.restarts;
      h.crashAt(point, true);
      const id = request(h, conn, PHONE, 1);
      expect(h.restarts).toBe(restarts + 1);
      const answered = replyTo(h, conn, id);
      const committed = rows(h, "push_targets") === 1;
      // "Now": answered only once on the disk; the key with its target, in the same commit.
      if (answered !== undefined) expect(committed).toBe(true);
      expect(rows(h, "push_keys")).toBe(rows(h, "push_targets"));
      // The roster the restarted hub gave its relay names the phone exactly when it is registered.
      const roster = relay.rosters.at(-1) ?? [];
      expect(roster.some((entry) => entry.client === PHONE)).toBe(committed);
      // Retried with the same `seq`: done once, and the phone then in the roster.
      const again = phoneSession(h, PHONE);
      const retried = replyTo(h, again, request(h, again, PHONE, 1));
      expect(retried?.ok).toBe(true);
      if (committed && retried?.ok === true) expect(retried.repeat).toBe(true);
      expect(rows(h, "push_targets")).toBe(1);
      expect(rows(h, "push_keys")).toBe(1);
      expect((relay.rosters.at(-1) ?? []).some((entry) => entry.client === PHONE)).toBe(true);
      // The key is never in the `commands` row.
      const args = h.query<{ args: string | null }>(
        `SELECT args FROM commands WHERE kind = 'push.register'`,
      );
      for (const row of args) expect(row.args ?? "").not.toContain(REGISTER.body.key);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "a countdown raised while the link is down: pushed once when it is back, kept or lost by the cut",
    async () => {
      const { home: h, relay } = await relayHome(42, true);
      relay.cut();
      h.command({ kind: "arm", sensors: "all", continue: true });
      must(h.advanceTo(h.now + 5 * SECOND));
      const restarts = h.restarts;
      h.crashAt(point, true);
      h.sensor("door-1")?.door(mono(h.now + SECOND), true);
      must(h.advanceTo(h.now + 20 * SECOND));
      expect(h.restarts).toBe(restarts + 1);
      // Lost or kept, the countdown is on the disk once the door's report was taken.
      const countdowns = h.query<{ seq: number }>(
        `SELECT seq FROM notifications WHERE kind = 'countdown_started'`,
      );
      expect(countdowns).toHaveLength(1);
      expect(relay.sent.filter((p) => p.content.n.kind === "countdown_started")).toEqual([]);
      relay.mend();
      must(h.advanceTo(h.now + 10 * SECOND));
      const pushed = relay.sent.filter((p) => p.content.n.kind === "countdown_started");
      expect(pushed).toHaveLength(1);
      expect(pushed[0]?.client).toBe(PHONE);
      expect(pushed[0]?.content.n.seq).toBe(countdowns[0]?.seq);
      expect(pushed[0]?.content.n.critical).toBe(true);
      // Nothing left waiting.
      expect(h.query<{ n: number }>(`SELECT count(*) AS n FROM push_outbox`)[0]?.n).toBe(0);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});
