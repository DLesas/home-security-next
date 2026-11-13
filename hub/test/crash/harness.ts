/**
 * The crash harness (hub-design.md section 11, "Crash tests"): a day of home A on the whole hub
 * (`test/world/home.ts`: every real module, the loop of section 4, the real writer on a real
 * SQLite file), which loses power at any point of section 4's table, starts again from what was
 * on the disk and carries on, while the scripted devices go on without it.
 *
 * "Losing power" keeps exactly the committed transactions, which is what `synchronous = FULL`
 * guarantees: the database and its WAL are copied as they are at that moment, never the WAL
 * index, and the copy is the next run's disk. During a commit, the WAL is cut anywhere inside the
 * frames that commit appended; during a checkpoint, the main file holds any mix of its pages
 * before and after. After every restart the harness checks the seven conditions of section 11.
 */
import { MessageType, Role, SirenAction } from "@hsn/protocol";
import { ArmState } from "../../src/core/model/rows.ts";
import type { StagedEffect } from "../../src/ports/writer.ts";
import { auditTableOf } from "../../src/shell/storage/statements.ts";
import type { OpenedStore } from "../../src/shell/storage/store.ts";
import { HUB_DEVICE } from "../../src/core/model/ids.ts";
import { mono } from "../../src/core/model/time.ts";
import { ScriptedBoard } from "../unit/setup/support/board.ts";
import {
  type CrashPoint,
  DAY,
  Home,
  HOME_A,
  HOUR,
  MINUTE,
  SECOND,
  WALL_AT_START_MS,
} from "../world/home.ts";

export { CRASH_POINTS, type CrashPoint } from "../world/home.ts";

/** Decisions a refused replay must never cause (condition 6). */
const REPLAY_FORBIDDEN = new Set([
  "countdown_started",
  "countdown_continued",
  "late_report_sirens",
  "alarm",
  "armed",
  "disarmed",
  "siren_confirmed",
  "report_while_disarmed",
  "device_started",
]);

/** A crash planned at a true time of the day. */
export interface PlannedCrash {
  readonly at: number;
  readonly point: CrashPoint;
  /** Only a turn that stages something written now. */
  readonly needsNow: boolean;
}

export class CrashRun {
  readonly home: Home;
  readonly violations: string[] = [];
  readonly board = new ScriptedBoard({
    role: Role.Sensor,
    chipId: new Uint8Array([0xc0, 0xff, 0xee, 0, 0, 1]),
    development: true,
  });
  /** Commits not yet checked against a restarted database. */
  #unchecked = 0;
  #lastCommitWall: number | undefined;
  /** At the last restart: whether an alarm was saved, and when the hub came back. */
  #lastStart = { at: 0, alarmSaved: false };

  private constructor(home: Home) {
    this.home = home;
    home.onOpen = (store) => {
      this.#checkDisk(store);
    };
    home.onStarted = () => {
      this.#checkStarted();
    };
  }

  static async create(seed: number): Promise<CrashRun> {
    return new CrashRun(await Home.create({ ...HOME_A, seed }));
  }

  close(): void {
    this.home.close();
  }

  /**
   * The day: ten openings while disarmed by day; armed at 08:00 and 22:00, disarmed at 18:00 and
   * 23:10, the back door opening at 23:00 for an alarm; a board added at noon. Losing power at
   * each planned crash.
   */
  run(crashes: readonly PlannedCrash[], until = DAY): readonly string[] {
    const h = this.home;
    h.scriptDoors(10);
    h.sensor("door-2")?.door(mono(23 * HOUR), true);
    h.sensor("door-2")?.door(mono(23 * HOUR + 15 * SECOND), false);
    const script: { at: number; act: () => void }[] = [
      { at: 8 * HOUR, act: () => h.command({ kind: "arm", sensors: "all", continue: true }) },
      {
        at: 12 * HOUR,
        act: () => {
          h.plugBoard(this.board, "/dev/ttyACM0");
        },
      },
      {
        at: 12 * HOUR + SECOND,
        act: () => {
          h.command({ kind: "usbAdd", port: "/dev/ttyACM0", name: "garage" });
        },
      },
      { at: 18 * HOUR, act: () => h.command({ kind: "disarm", sensors: "all" }) },
      { at: 22 * HOUR, act: () => h.command({ kind: "arm", sensors: "all", continue: true }) },
      { at: 23 * HOUR + 10 * MINUTE, act: () => h.command({ kind: "disarm", sensors: "all" }) },
    ];
    const events = [
      ...script.map((s) => ({ at: s.at, act: s.act })),
      ...crashes.map((c) => ({
        at: c.at,
        act: () => {
          h.crashAt(c.point, c.needsNow);
        },
      })),
    ]
      .filter((e) => e.at < until)
      .toSorted((a, b) => a.at - b.at);
    for (const event of events) {
      const advanced = h.advanceTo(event.at);
      if (advanced.isErr()) {
        this.violations.push(advanced.error.message);
        return this.violations;
      }
      event.act();
    }
    const last = h.advanceTo(until);
    if (last.isErr()) this.violations.push(last.error.message);
    this.#checkNoCounterTwice();
    return this.violations;
  }

  #v(message: string): void {
    this.violations.push(`after restart ${this.home.restarts}: ${message}`);
  }

  /** The restarted database, before the boot event reads it. */
  #checkDisk(store: OpenedStore): void {
    const h = this.home;
    if (h.restarts === 0) return;
    const { db, snapshot, boot } = store;
    if (boot.previousExit === "clean") this.#v("a power cut read as a clean stop");

    // 5: every commit's items are there; only the batch staged since the last commit is missing.
    const unchecked = h.commitLog.slice(this.#unchecked);
    this.#unchecked = h.commitLog.length;
    for (const commit of unchecked)
      for (const item of commit.items)
        if (!present(store, item)) this.#v(`5: committed ${describe(item)} is missing`);
    for (const item of h.pendingItems) {
      if (item.kind === "record" && item.record.kind !== "reject" && present(store, item))
        this.#v(`5: ${describe(item)} was never committed yet is there`);
    }
    const mark = snapshot.deviceState.find((row) => row.deviceId === HUB_DEVICE);
    const lastCommit = h.commitLog.at(-1);
    if (lastCommit !== undefined && mark?.lastSeenMs !== lastCommit.wallMs)
      this.#v(`5: commit mark at ${mark?.lastSeenMs}, the last commit at ${lastCommit.wallMs}`);
    this.#lastCommitWall = mark?.lastSeenMs;

    // 2: every "countdown started" reply that left has a countdown, an alarm or a disarm.
    for (const m of h.sensors) {
      const told = m.sensor.replies.filter((r) => r.reply.flags.countdownStarted);
      const latest = told.at(-1);
      if (latest === undefined || latest.at < this.#lastStart.at) continue;
      const config = snapshot.sensorConfig.find((c) => c.deviceId === m.row.id);
      const counted =
        snapshot.countdowns.some((c) => c.sensorId === m.row.id) ||
        snapshot.alarm !== undefined ||
        config?.arm === ArmState.Disarmed ||
        h
          .decisions("alarm")
          .some(
            (d) =>
              d.atMs >= WALL_AT_START_MS + latest.at / 1000 &&
              db.query("SELECT 1 FROM decisions WHERE seq = ?").get(d.seq) !== null,
          );
      if (!counted)
        this.#v(`2: ${m.row.name} was told its countdown started, and the restart lost it`);
    }

    // 3: every arm or disarm the CLI was told of survives.
    const told = h.told.filter(
      (t) => (t.command.kind === "arm" || t.command.kind === "disarm") && t.reply.ok,
    );
    const lastTold = told.at(-1);
    if (lastTold !== undefined) {
      const armed = lastTold.command.kind === "arm";
      const scripted = new Set(h.sensors.map((m) => m.row.id));
      // The board paired at noon came after the morning's arm: it was not part of it.
      for (const config of snapshot.sensorConfig.filter((c) => scripted.has(c.deviceId))) {
        const isArmed = config.arm !== ArmState.Disarmed;
        if (isArmed !== armed)
          this.#v(
            `3: \`hsn ${lastTold.command.kind}\` was answered, device ${config.deviceId} is not`,
          );
      }
    }

    // 4, the first half: an alarm saved before the stop is still there to resume.
    this.#lastStart = { at: h.now, alarmSaved: snapshot.alarm !== undefined };

    // 7: every key a board was given is in the database.
    const pairing = this.board.pairing;
    if (pairing !== undefined) {
      const row = db
        .query<{ key: Uint8Array }, [number]>(
          "SELECT k.key FROM device_keys k JOIN devices d ON d.id = k.device_id WHERE d.address = ?",
        )
        .get(pairing.address);
      if (row === null || !Buffer.from(row.key).equals(Buffer.from(pairing.key)))
        this.#v("7: the key given to the board is not in the database");
    }
  }

  /** The hub is up again: the restart notice, condition 4's second half, and the replay (6). */
  #checkStarted(): void {
    const h = this.home;
    if (h.restarts === 0) return;
    // 5: the restart says records after the last commit's time may be missing.
    const notice = h.hubEvents("restarted").at(-1);
    const missingAfter = (JSON.parse(notice?.detail ?? "{}") as { missingAfterMs?: number | null })
      .missingAfterMs;
    if (missingAfter !== this.#lastCommitWall)
      this.#v(
        `5: says records after ${missingAfter} may be missing, the last commit was at ${this.#lastCommitWall}`,
      );

    // 4: no alarm is cancelled by the restart.
    if (this.#lastStart.alarmSaved && h.decisions("alarm").length > 0) {
      const alarmRows = h.query<{ n: number }>("SELECT count(*) AS n FROM alarm")[0]?.n ?? 0;
      const ended = h.records.some(
        (r) =>
          r.kind === "decision" &&
          r.row.kind === "disarmed" &&
          r.row.atMs >= this.#lastStart.at / 1000,
      );
      if (alarmRows === 0 && !ended) this.#v("4: the restart cancelled a running alarm");
    }

    // 6: every packet accepted since the last commit, and the last 20 before it, forwarded again.
    // The turns the power was lost in are left out: they never finished, nothing of them left
    // the hub, and their packets are as new to the restarted hub as packets it never heard.
    const lastTurn = h.commitLog.at(-1)?.turn ?? -1;
    const stepped = h.forwardedLog.filter(
      (f) => f.turn !== undefined && !h.crashedTurns.has(f.turn),
    );
    const firstAfter = stepped.findIndex((f) => (f.turn ?? 0) > lastTurn);
    const from = Math.max(0, (firstAfter < 0 ? stepped.length : firstAfter) - 20);
    const replayed = stepped.slice(from).map((f) => f.packet);
    const before = h.records.length;
    h.replay(replayed);
    for (const record of h.records.slice(before)) {
      if (record.kind === "decision" && REPLAY_FORBIDDEN.has(record.row.kind))
        this.#v(
          `6: a replayed packet caused \`${record.row.kind}\` for device ${record.row.deviceId}`,
        );
    }
  }

  /** 1: no (key, counter) pair was ever sent twice, over all runs; 4: no ended alarm sounded again. */
  #checkNoCounterTwice(): void {
    // One packet may go on two paths, or again, with its counter (a siren command on Wi-Fi and
    // LoRa, section 8): the same bytes. A counter used by two runs of the hub is a reuse.
    const runs = new Map<string, Set<number>>();
    for (const left of this.home.left)
      for (const use of left.counters) {
        const key = `${use.device}:${use.counter}`;
        runs.set(key, (runs.get(key) ?? new Set()).add(left.run));
      }
    for (const [key, used] of runs)
      if (used.size > 1) this.violations.push(`1: counter ${key} sent by ${used.size} runs`);
    const alarms = this.home.decisions("alarm").length;
    for (const m of this.home.sirens) {
      const sounded = m.siren.acted.filter(
        (a) =>
          a.message.type === MessageType.SirenCommand &&
          a.message.action === SirenAction.SoundAlarm,
      );
      // An alarm's command may come again after a restart while it runs, never for a new one.
      const distinct = new Set(sounded.map((a) => a.counter)).size;
      if (alarms === 0 && distinct > 0)
        this.violations.push(`4: ${m.row.name} sounded with no alarm`);
    }
  }

  /** Sends that left the hub, over all runs. */
  get sends(): number {
    return this.home.left.length;
  }
}

/** Whether a staged item is in the database: a record by its row, a write by its row's state. */
function present(store: OpenedStore, item: StagedEffect): boolean {
  const { db } = store;
  if (item.kind === "record") {
    if (item.record.kind === "reject") return true;
    return (
      db
        .query(`SELECT 1 FROM "${auditTableOf(item.record)}" WHERE seq = ?`)
        .get(item.record.row.seq) !== null
    );
  }
  const op = item.op;
  if (op.op !== "upsert") return true;
  switch (op.table) {
    case "device_keys":
    case "devices":
      return (
        db
          .query(
            `SELECT 1 FROM "${op.table}" WHERE ${op.table === "devices" ? "id" : "device_id"} = ?`,
          )
          .get(op.table === "devices" ? op.row.id : op.row.deviceId) !== null
      );
    case "send_counters": {
      const row = db
        .query<{ resume_point: number }, [number]>(
          "SELECT resume_point FROM send_counters WHERE device_id = ?",
        )
        .get(op.row.deviceId);
      // A later commit may have moved it on, never back.
      return row !== null && row.resume_point >= op.row.resumePoint;
    }
    case "boots":
      return db.query("SELECT 1 FROM boots WHERE id = ?").get(op.row.id) !== null;
    default:
      return true;
  }
}

function describe(item: StagedEffect): string {
  if (item.kind === "record")
    return `${item.durability} ${item.record.kind} record ${item.record.kind === "reject" ? "" : item.record.row.seq}`;
  return `${item.durability} ${item.op.op} of ${item.op.table}`;
}
