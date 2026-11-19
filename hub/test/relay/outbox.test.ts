/**
 * The outbox through outages and restarts (docs/m4-design.md section 4, "The outbox (D102)";
 * section 11, "The outbox": "the relay killed, a countdown raised, the hub restarted, the relay
 * started: the push arrives once, marked late; routine notices lost by a crash are exactly those M2
 * accepts"). The real hub as a process with a door and its gateway (`home.ts`), B2's relay on
 * loopback stopped and started on its port, a phone on the phone's own code registered through it;
 * what reaches the relay's push sender is opened with the phone's key.
 *
 * - A short outage: a countdown (critical) and the arming notices (routine) raised while the relay
 *   is away go when it is back, each once, in order, not marked late.
 * - A hub killed during an outage: the countdown, written now, is pushed once after the restart;
 *   of the routine notices, exactly those whose notification the database kept are pushed.
 * - A long outage, with a clean restart of the hub in it (`HSN_M4=1`, about 80 s): every critical
 *   notice and the newest 10 others are pushed, each marked late with its true time; the rest are
 *   dropped and recorded (`push_dropped`), staying unread in the app (QR8).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { PushContent } from "@hsn/protocol/app";
import { endProcesses } from "../world/processes.ts";
import { startRelayRun, stopAll, type RelayRun } from "../unit/shell-relay/support.ts";
import { HomeGateway, SENSOR, seedHome } from "./home.ts";
import { AwayPhone } from "./phone.ts";
import { Seen } from "./leaks.ts";
import { ALL_OUTPUT, check, HubProcess, shortFolder, waitFor } from "./processes.ts";
import { fcmToken } from "./pushes.ts";

const SECOND = 1000;
const SLOW = process.env.HSN_M4 === "1";
const roots: string[] = [];
const closers: (() => void)[] = [];
const seen = new Seen();
afterAll(async () => {
  for (const close of closers) close();
  await endProcesses();
  await stopAll();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Home {
  readonly run: RelayRun;
  readonly hub: HubProcess;
  readonly gateway: HomeGateway;
  readonly phone: AwayPhone;
  readonly token: string;
}

async function home(token: string): Promise<Home> {
  const run = startRelayRun();
  seen.logs.push(() => run.log.text());
  seen.sealed.push(() => run.push.items.map((item) => item.h));
  seen.tokens.push(token);
  const root = shortFolder("hsn-ob-");
  roots.push(root);
  const hub = new HubProcess(root, { seed: seedHome });
  seen.hubDirs.push(hub.dataDir);
  await hub.start();
  const gateway = new HomeGateway();
  closers.push(() => {
    gateway.close();
  });
  check(await gateway.connect(hub.devicePort), "the gateway welcomed");
  check((await hub.op("relay.set", { url: run.url })).ok, "relay.set");
  check(await hub.relayState("up", 15 * SECOND), "the hub's link up");
  const invite = await hub.op("link.create", { kind: { newPerson: { name: "Ola" } }, form: "qr" });
  const linked = await AwayPhone.link(invite.ok ? String(invite.body.qr) : "", "Ola", run.url);
  check(linked instanceof AwayPhone, `linked: ${JSON.stringify(linked)}`);
  const phone = linked as AwayPhone;
  seen.phones.push(phone);
  check(await phone.open(), "the phone's session");
  check((await phone.registerPush("fcm", token)).ok, "push.register");
  const identity = await hub.identity();
  check(await waitFor(() => run.targets(identity).length === 1, 10 * SECOND), "the roster");
  phone.stop();
  return { run, hub, gateway, phone, token };
}

/** What reached the relay for the phone, opened, in order. */
function pushed(h: Home): PushContent[] {
  return h.run.push.items
    .filter((item) => item.token === h.token)
    .flatMap((item) => {
      const content = h.phone.openPush(item.h);
      return content === undefined ? [] : [content];
    });
}

const notices = (h: Home) => pushed(h).filter((c) => c.n.seq !== 0);

/** Arms the door, opens it (a countdown), disarms it and shuts it: three notifications. */
async function countdownCycle(h: Home): Promise<void> {
  check((await h.hub.op("arm", { target: { sensor: SENSOR } })).ok, "armed");
  check(h.gateway.door(true), "the door opened");
  check(
    await waitFor(
      async () => {
        const log = await h.hub.hsn("log", "--kind", "decision");
        return log.out.includes("countdown_started");
      },
      5 * SECOND,
      100,
    ),
    "a countdown",
  );
  check((await h.hub.op("disarm", { target: { sensor: SENSOR } })).ok, "disarmed");
  h.gateway.door(false);
}

/** The notifications the hub's database holds, by seq, with whether each is critical. */
function notificationRows(
  dataDir: string,
): { readonly seq: number; readonly critical: boolean; readonly kind: string }[] {
  const db = new Database(join(dataDir, "hub.db"), { readonly: true });
  const rows = db
    .query<{ seq: number; critical: number; kind: string }, []>(
      "SELECT seq, critical, kind FROM notifications ORDER BY seq",
    )
    .all()
    .map((row) => ({ seq: row.seq, critical: row.critical === 1, kind: row.kind }));
  db.close();
  return rows;
}

const notificationSeqs = (dataDir: string) => notificationRows(dataDir).map((row) => row.seq);

describe("the outbox (D102)", () => {
  test("a short outage: what was raised meanwhile goes when the relay is back, once each, in order, not late", async () => {
    const h = await home(fcmToken(51));
    const before = notices(h).length;
    await h.run.stop();
    check(await h.hub.relayState("down", 5 * SECOND), "the hub saw the relay go");
    const raisedFrom = Date.now();
    await countdownCycle(h);
    await Bun.sleep(1000);
    expect(notices(h).length).toBe(before);
    h.run.start();
    check(await h.hub.relayState("up", 20 * SECOND), "back on the relay");
    check(await waitFor(() => notices(h).length >= before + 3, 10 * SECOND), "the three pushes");
    await Bun.sleep(1000);
    const late = notices(h).slice(before);
    expect(late.map((c) => c.n.kind)).toEqual([
      "arming_changed",
      "countdown_started",
      "arming_changed",
    ]);
    expect(late.map((c) => c.n.seq)).toEqual(late.map((c) => c.n.seq).toSorted((a, b) => a - b));
    expect(new Set(late.map((c) => c.n.seq)).size).toBe(3);
    for (const content of late) {
      expect(content.delayed).toBe(false);
      expect(content.n.atMs).toBeGreaterThanOrEqual(raisedFrom - 50);
    }
    expect(late.find((c) => c.n.kind === "countdown_started")?.n.critical).toBe(true);
    await h.hub.stop();
  }, 90_000);

  test("the hub killed during an outage: the countdown is pushed once after the restart; routine ones as the database kept them", async () => {
    const h = await home(fcmToken(52));
    const before = notices(h).length;
    const seqsBefore = new Set(notificationSeqs(h.hub.dataDir));
    await h.run.stop();
    check(await h.hub.relayState("down", 5 * SECOND), "the hub saw the relay go");
    await countdownCycle(h);
    await h.hub.kill();
    h.gateway.close();
    const kept = notificationSeqs(h.hub.dataDir).filter((seq) => !seqsBefore.has(seq));
    h.run.start();
    await h.hub.start();
    check(await h.gateway.connect(h.hub.devicePort), "the gateway again");
    check(await h.hub.relayState("up", 20 * SECOND), "back on the relay");
    check(
      await waitFor(
        () =>
          notices(h)
            .slice(before)
            .some((c) => c.n.kind === "countdown_started"),
        10 * SECOND,
      ),
      "the countdown pushed",
    );
    await Bun.sleep(2000);
    const after = notices(h).slice(before);
    const countdowns = after.filter((c) => c.n.kind === "countdown_started");
    expect(countdowns).toHaveLength(1);
    // Every notice pushed is one the database kept, once; every kept one of the outage is pushed.
    const pushedSeqs = after.map((c) => c.n.seq);
    expect(new Set(pushedSeqs).size).toBe(pushedSeqs.length);
    expect(pushedSeqs.toSorted((a, b) => a - b)).toEqual(kept.toSorted((a, b) => a - b));
    expect(kept).toContain(countdowns[0]?.n.seq ?? -1);
    await h.hub.stop();
  }, 90_000);

  test.skipIf(!SLOW)(
    "a long outage with a clean restart in it: every critical notice and the newest 10 others, marked late with their true times; the rest dropped and recorded",
    async () => {
      const h = await home(fcmToken(53));
      const before = notices(h).length;
      const seqsBefore = new Set(notificationSeqs(h.hub.dataDir));
      await h.run.stop();
      check(await h.hub.relayState("down", 5 * SECOND), "the hub saw the relay go");
      const raisedAt: number[] = [];
      // One countdown (critical) between two arming notices, then five more arm-and-disarm pairs:
      // 1 critical and 12 routine notices for the phone.
      raisedAt.push(Date.now());
      await countdownCycle(h);
      for (let i = 0; i < 5; i++) {
        check((await h.hub.op("arm", { target: { sensor: SENSOR } })).ok, "armed");
        check((await h.hub.op("disarm", { target: { sensor: SENSOR } })).ok, "disarmed");
      }
      // Past the 60 s after which a push is late (`HubRules.notify.delayedAfterMs`).
      await Bun.sleep(62 * SECOND);
      await h.hub.stop();
      h.gateway.close();
      // A clean stop commits every routine row: every notice of the outage is on the disk.
      const outage = notificationRows(h.hub.dataDir).filter((row) => !seqsBefore.has(row.seq));
      expect(outage.filter((row) => row.critical).map((row) => row.kind)).toEqual([
        "countdown_started",
      ]);
      expect(outage.filter((row) => !row.critical).map((row) => row.kind)).toEqual(
        new Array<string>(12).fill("arming_changed"),
      );
      h.run.start();
      await h.hub.start();
      check(await h.hub.relayState("up", 20 * SECOND), "back on the relay");
      check(await waitFor(() => notices(h).length >= before + 11, 15 * SECOND), "the burst");
      await Bun.sleep(2000);
      const burst = notices(h).slice(before);
      expect(burst).toHaveLength(11);
      expect(burst.filter((c) => c.n.critical).map((c) => c.n.kind)).toEqual(["countdown_started"]);
      expect(burst.filter((c) => !c.n.critical)).toHaveLength(10);
      for (const content of burst) {
        expect(content.delayed).toBe(true);
        expect(content.n.atMs).toBeGreaterThanOrEqual((raisedAt[0] ?? 0) - 50);
        expect(content.n.atMs).toBeLessThan((raisedAt[0] ?? 0) + 30 * SECOND);
      }
      // The burst: the critical one and the newest 10 others, in order; the two oldest routine
      // ones dropped, said in a record, and still in the database, unread.
      const routine = outage.filter((row) => !row.critical).map((row) => row.seq);
      const expected = [
        ...outage.filter((row) => row.critical).map((row) => row.seq),
        ...routine.slice(-10),
      ].toSorted((a, b) => a - b);
      expect(burst.map((c) => c.n.seq)).toEqual(expected);
      const log = await h.hub.hsn("log", "--kind", "event");
      expect(log.out).toContain("push_dropped");
      const kept = notificationSeqs(h.hub.dataDir);
      for (const seq of routine) expect(kept).toContain(seq);
      await h.hub.stop();
    },
    180_000,
  );
  test("nothing secret in any output, and no guard engaged", async () => {
    expect(await seen.check(ALL_OUTPUT)).toEqual({ leaks: [], guards: [] });
  });
});
