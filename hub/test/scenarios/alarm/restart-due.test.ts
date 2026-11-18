/**
 * A power cut during a countdown or an alarm whose time then runs out (hub-design.md section 5,
 * "How long was the hub down?"; section 7, "Hub restart"; section 8, "Arming and the countdown";
 * D67, D80, D106, D113), on the whole hub with the crash harness's home: the real store, the loop
 * of section 4 and the scripted devices. The home stops a run when the loop's guard engages (a
 * deadline left at or before its time), so every `must` here also says it never did.
 *
 * - (a) the alarm's time runs out while the hub is off, the downtime known at the start;
 * - (b) the alarm's time had run out by the last commit, its ending lost, the downtime unknown;
 * - (c) the countdown's end passes while the hub is off, the downtime known at the start;
 * - (d) the countdown had no time left at the last commit, its end lost, the downtime unknown.
 *
 * (b) and (d) need a stop at a moment no turn of the loop can leave: a commit after the end with
 * the end not in it. The database is set to that (the deadline a second before the last commit's
 * time) just before the power is cut, which is what such a stop would leave on the disk.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { MessageType, SirenAction, SirenState } from "@hsn/protocol";
import { HUB_DEVICE } from "../../../src/core/model/ids.ts";
import { mono } from "../../../src/core/model/time.ts";
import { Home, HOME_A, HOUR, SECOND } from "../../world/home.ts";
import { DAY_TEST_TIMEOUT_MS } from "../../world/timeouts.ts";

function must(result: { isErr(): boolean; error?: { message: string } }): void {
  expect(result.isErr() ? (result.error?.message ?? "stalled") : "ok").toBe("ok");
}

const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
});

/** When door-5 opens: two hours in, an hour after every sensor was armed. */
const OPENED = 2 * HOUR + 5 * SECOND;

/** Home A, armed, with door-5 opening at `OPENED`. */
async function armedHome(seed: number): Promise<Home> {
  const h = await Home.create({ ...HOME_A, seed });
  homes.push(h);
  must(h.advanceTo(HOUR));
  h.command({ kind: "arm", sensors: "all", continue: false });
  must(h.advanceTo(2 * HOUR));
  h.sensor("door-5")?.door(mono(OPENED), true);
  return h;
}

function count(h: Home, table: string): number {
  return h.query<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`)[0]?.n ?? 0;
}

/** How many commands each siren had acted on: a mark to read what comes after. */
function actedMark(h: Home): readonly number[] {
  return h.sirens.map((m) => m.siren.acted.length);
}

/**
 * The siren commands the sirens acted on after `mark`, as [action, seconds], but "report now",
 * which a start sends every siren (section 7, "Hub restart", step 4).
 */
function commandsActed(h: Home, mark: readonly number[]): [number, number][] {
  return h.sirens.flatMap((m, i) =>
    m.siren.acted
      .slice(mark[i] ?? 0)
      .flatMap((a): [number, number][] =>
        a.message.type === MessageType.SirenCommand && a.message.action !== SirenAction.ReportNow
          ? [[a.message.action, a.message.soundSeconds]]
          : [],
      ),
  );
}

/**
 * The hub's last commit mark: its run and monotonic time. `deadline_mono` and `until_mono` are on
 * that run's clock.
 */
function lastCommitMono(h: Home): number {
  return (
    h.query<{ m: number }>(
      "SELECT last_seen_mono AS m FROM device_state WHERE device_id = ?",
      HUB_DEVICE,
    )[0]?.m ?? 0
  );
}

describe("(a) the alarm's time runs out while the hub is off, the downtime known", () => {
  test(
    "the start ends it by itself, once; nothing is sent to the sirens, which stopped on their own",
    async () => {
      const h = await armedHome(71);
      must(h.advanceTo(OPENED + 40 * SECOND));
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.sirensSounding()).toBe(true);
      // About 290 s of the sirens' 300 have gone; off for a minute, with the clock trusted.
      must(h.advanceTo(OPENED + 325 * SECOND));
      const cut = h.now;
      const mark = actedMark(h);
      must(h.restart("cut", 60 * SECOND));
      const ended = h.decisions("alarm_ended");
      expect(ended.map((d) => d.value)).toEqual([0]);
      expect(count(h, "alarm")).toBe(0);
      expect(count(h, "alarm_sirens")).toBe(0);
      must(h.advanceTo(cut + 3 * 60 * SECOND));
      expect(h.sirens.every((m) => m.siren.output === SirenState.Off)).toBe(true);
      expect(commandsActed(h, mark)).toEqual([]);
      // A second cut straight after: nothing comes again.
      must(h.restart("cut", 10 * SECOND));
      must(h.advanceTo(h.now + 2 * 60 * SECOND));
      expect(h.decisions("alarm_ended")).toHaveLength(1);
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.restarts).toBe(2);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("(b) the alarm's time had run out by the last commit, the downtime unknown", () => {
  test(
    "the start ends it by itself, once; a siren still sounding is commanded off when it reports",
    async () => {
      const h = await armedHome(72);
      must(h.advanceTo(OPENED + 40 * SECOND));
      expect(h.sirensSounding()).toBe(true);
      h.clock.trusted = false;
      must(h.advanceTo(OPENED + 60 * SECOND));
      // The sirens' time ran out a second before the last commit, and the ending was lost.
      h.store?.db.run("UPDATE alarm_sirens SET until_mono = ?", [lastCommitMono(h) - SECOND]);
      const cut = h.now;
      const mark = actedMark(h);
      must(h.restart("cut", 10 * SECOND));
      expect(h.loop?.state.clock.downtime.kind).toBe("unknown");
      expect(h.decisions("alarm_ended").map((d) => d.value)).toEqual([0]);
      expect(count(h, "alarm")).toBe(0);
      // The sirens' own timers run for minutes yet: told to stop, by the correction rule.
      must(h.advanceTo(cut + 3 * 60 * SECOND));
      expect(commandsActed(h, mark)).toEqual(h.sirens.map(() => [SirenAction.Off, 0]));
      expect(h.sirens.every((m) => m.siren.output === SirenState.Off)).toBe(true);
      must(h.restart("cut", 10 * SECOND));
      must(h.advanceTo(h.now + 2 * 60 * SECOND));
      expect(h.decisions("alarm_ended")).toHaveLength(1);
      expect(h.decisions("alarm")).toHaveLength(1);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("(c) the countdown's end passes while the hub is off, the downtime known (D106)", () => {
  test(
    "the start sounds the sirens for what is left from the would-be end, late_report_sirens, once",
    async () => {
      const h = await armedHome(73);
      must(h.advanceTo(OPENED + 10 * SECOND));
      expect(h.decisions("countdown_started")).toHaveLength(1);
      const cut = h.now;
      const mark = actedMark(h);
      // Off a minute: the countdown would have ended about 40 s before the start.
      must(h.restart("cut", 60 * SECOND));
      expect(h.decisions("alarm")).toEqual([]);
      const late = h.decisions("late_report_sirens");
      expect(late).toHaveLength(1);
      expect(late[0]?.value ?? 0).toBeGreaterThanOrEqual(258);
      expect(late[0]?.value ?? 0).toBeLessThanOrEqual(262);
      must(h.advanceTo(cut + 120 * SECOND));
      expect(h.sirensSounding()).toBe(true);
      const sounded = commandsActed(h, mark).filter(
        ([action]) => action === SirenAction.SoundAlarm,
      );
      expect(sounded.length).toBeGreaterThan(0);
      // Never past the would-be end plus the automatic stop.
      expect(Math.max(...sounded.map(([, seconds]) => seconds))).toBeLessThanOrEqual(262);
      // A second cut while it sounds: resumed, not raised again.
      must(h.restart("cut", 5 * SECOND));
      must(h.advanceTo(h.now + 30 * SECOND));
      expect(h.decisions("late_report_sirens")).toHaveLength(1);
      expect(h.decisions("alarm")).toEqual([]);
      expect(h.sirensSounding()).toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );

  test(
    "off past the sirens' time too: only late_report_notification, naming when the door opened",
    async () => {
      const h = await armedHome(74);
      must(h.advanceTo(OPENED + 10 * SECOND));
      must(h.restart("cut", 400 * SECOND));
      expect(h.decisions("late_report_sirens")).toEqual([]);
      expect(h.decisions("alarm")).toEqual([]);
      const late = h.decisions("late_report_notification");
      expect(late).toHaveLength(1);
      // The opening's wall time, whole seconds, to within the age's whole second.
      const openedS = Math.floor((h.clock.now().wall - (h.now - OPENED) / 1000) / 1000);
      expect(Math.abs((late[0]?.value ?? 0) - openedS)).toBeLessThanOrEqual(1);
      must(h.advanceTo(h.now + 60 * SECOND));
      expect(h.sirens.every((m) => m.siren.output === SirenState.Off)).toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});

describe("(d) the countdown had no time left at the last commit, the downtime unknown (D113)", () => {
  test(
    "the start ends it and sounds the sirens, `alarm`, once; a second cut resumes the alarm",
    async () => {
      const h = await armedHome(75);
      must(h.advanceTo(OPENED + 4 * SECOND));
      h.clock.trusted = false;
      must(h.advanceTo(OPENED + 10 * SECOND));
      expect(h.decisions("countdown_started")).toHaveLength(1);
      h.store?.db.run("UPDATE countdowns SET deadline_mono = ?", [lastCommitMono(h) - SECOND]);
      const cut = h.now;
      const mark = actedMark(h);
      must(h.restart("cut", 10 * SECOND));
      expect(h.loop?.state.clock.downtime.kind).toBe("unknown");
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.decisions("late_report_sirens")).toEqual([]);
      expect(count(h, "countdowns")).toBe(0);
      must(h.advanceTo(cut + 120 * SECOND));
      expect(h.sirensSounding()).toBe(true);
      const sounded = commandsActed(h, mark).filter(
        ([action]) => action === SirenAction.SoundAlarm,
      );
      // Counted from the countdown's end, a second before the start.
      expect(Math.max(...sounded.map(([, seconds]) => seconds))).toBeLessThanOrEqual(300);
      must(h.restart("cut", 5 * SECOND));
      must(h.advanceTo(h.now + 30 * SECOND));
      expect(h.decisions("alarm")).toHaveLength(1);
      expect(h.sirensSounding()).toBe(true);
    },
    DAY_TEST_TIMEOUT_MS,
  );
});
