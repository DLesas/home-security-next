/**
 * Lockstep (hub-design.md section 11, "Lockstep"): the recorded sessions replayed against the
 * real hub, in this process and as a process on the socket; the same script giving the same
 * bytes and the same database twice; a stop and a kill inside a countdown, the second restart on
 * an untrusted clock; refused lines. Run with `HSN_LOCKSTEP_RECORD=1` to write the sessions again
 * from the scripts in `sessions.ts` (then review the diff: the C++ side is tested against them).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { fromHex, MessageType, Role, SirenAction, toHex } from "@hsn/protocol";
import type { LockstepFromHub, LockstepToHub } from "../../src/control-protocol/index.ts";
import { lockstepFromHub, lockstepToHub } from "../../src/control-protocol/index.ts";
import { mono } from "../../src/core/model/time.ts";
import { lockstepRandom } from "../../src/shell/lockstep/hub.ts";
import { DATABASE_FILE } from "../../src/shell/storage/store.ts";
import { Controller, type HubEnd, MINUTE, SECOND } from "./controller.ts";
import { endProcesses } from "../world/processes.ts";
import { InProcessEnd, ProcessEnd } from "./ends.ts";
import { armedDoor, gatewayReplaced, provision, SEED, SESSIONS, wallAt } from "./sessions.ts";

const RECORD = process.env.HSN_LOCKSTEP_RECORD === "1";
const work = mkdtempSync("/tmp/hsn-ls-");
afterAll(async () => {
  await endProcesses();
  rmSync(work, { recursive: true, force: true });
});
let folders = 0;
const folder = () => {
  const path = join(work, `d${folders++}`);
  return path;
};

const sessionFile = (name: string) => join(import.meta.dir, `${name}.session`);

/** A session file's lines: what the controller sent, each with the hub's answers after it. */
function readSession(
  name: string,
): { readonly sent: LockstepToHub; readonly answers: LockstepFromHub[] }[] {
  const steps: { sent: LockstepToHub; answers: LockstepFromHub[] }[] = [];
  for (const line of readFileSync(sessionFile(name), "utf8").split("\n")) {
    if (line.startsWith("> "))
      steps.push({ sent: lockstepToHub.parse(JSON.parse(line.slice(2))), answers: [] });
    else if (line.startsWith("< "))
      steps.at(-1)?.answers.push(lockstepFromHub.parse(JSON.parse(line.slice(2))));
  }
  return steps;
}

/** An answer without its `wake`, for a captured session the hub's own timers no longer match. */
function withoutWake(answer: LockstepFromHub): unknown {
  return answer.type === "idle" ? { ...answer, wake: null } : answer;
}

/**
 * Sends a session's every line to `end` and compares each answer with the recorded one. A
 * session the bench captured (`burst-hang`) chose its own times, so its answers are compared
 * without the hub's `wake`, which a change of the hub's own timers moves.
 */
async function replay(name: string, end: HubEnd): Promise<number> {
  const captured = !(name in SESSIONS);
  let compared = 0;
  for (const step of readSession(name)) {
    const answers = await end.send(step.sent);
    const got = captured ? answers.map(withoutWake) : answers;
    const want = captured ? step.answers.map(withoutWake) : step.answers;
    expect([JSON.stringify(step.sent), got]).toEqual([JSON.stringify(step.sent), want]);
    compared += answers.length;
  }
  return compared;
}

/** Every row of every table, for comparing two databases. */
function dump(dataDir: string): Record<string, unknown[]> {
  const db = new Database(join(dataDir, DATABASE_FILE), { readonly: true });
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((t) => t.name);
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    // Single-column tables (M2's `people_settings`, `schedule_state`) have no second term.
    const columns = db.query(`SELECT 1 FROM pragma_table_info('${table}')`).all().length;
    out[table] = db.query(`SELECT * FROM "${table}" ORDER BY 1${columns > 1 ? ", 2" : ""}`).all();
  }
  db.close();
  return out;
}

const decisions = (c: Controller, kind: string) =>
  c.idles
    .flatMap((i) => i.records)
    .flatMap((r) => (r.kind === "decision" && r.row.kind === kind ? [r.row] : []));

describe.skipIf(!RECORD)("recording the sessions (HSN_LOCKSTEP_RECORD=1)", () => {
  test.each(Object.keys(SESSIONS))("%s", async (name) => {
    const c = await SESSIONS[name as keyof typeof SESSIONS](new InProcessEnd(folder()));
    expect(c.failure).toBeUndefined();
    writeFileSync(sessionFile(name), `${c.transcript.join("\n")}\n`);
  });
});

/**
 * The recorded sessions, and `burst-hang`: the bench's 30-door load test captured up to the
 * `disarm --all` during the alarm, whose `advance` the hub once never answered (an `idle` of
 * 8.6 KB, over the socket's buffer, lost its tail). Its lines are the bench's; its answers were
 * made again by this hub for version 2 of the wire.
 */
const REPLAYED = [...Object.keys(SESSIONS), "burst-hang"];

describe("the recorded sessions, replayed against the real hub (section 11)", () => {
  test.each(REPLAYED)("%s, in this process", async (name) => {
    expect(await replay(name, new InProcessEnd(folder()))).toBeGreaterThan(10);
  });

  test.each(REPLAYED)(
    "%s, a hub process on the socket",
    async (name) => {
      const end = new ProcessEnd(folder(), join(work, `s${folders}.sock`));
      // Closed (the process killed) whatever the replay found.
      const answers = await replay(name, end).finally(() => end.close());
      expect(answers).toBeGreaterThan(10);
    },
    60_000,
  );
});

describe("what the sessions show", () => {
  test("provisioning: the gateway added by itself, the sensor and the siren by `hsn usb add`", async () => {
    const c = await provision(new InProcessEnd(folder()));
    expect(c.failure).toBeUndefined();
    const added = [...c.replies.values()].flatMap((r) =>
      r.ok && r.result.kind === "usbAdd" ? [r.result.name] : [],
    );
    expect(added).toEqual(["front", "hall"]);
    expect(decisions(c, "gateway_welcomed")).toHaveLength(1);
    expect(c.board("siren1")?.siren?.held.version).toBeGreaterThan(0);
  });

  test("every device's record names it: number, name, address, role and chip (D110)", async () => {
    const c = await provision(new InProcessEnd(folder()));
    const added = c.idles
      .flatMap((i) => i.records)
      .flatMap((r) =>
        r.kind === "hubEvent" && r.row.code === "device_added"
          ? [
              JSON.parse(r.row.detail ?? "{}") as {
                device: number;
                name: string;
                address: number;
                chip: string;
                role: string;
              },
            ]
          : [],
      );
    const front = added.find((d) => d.name === "front");
    expect(front?.role).toBe("sensor");
    const reply = [...c.replies.values()].find(
      (r) => r.ok && r.result.kind === "usbAdd" && r.result.name === "front",
    );
    expect(reply?.ok === true && reply.result.kind === "usbAdd" ? reply.result : undefined).toEqual(
      {
        kind: "usbAdd",
        device: front?.device ?? 0,
        name: "front",
        role: "sensor",
        address: front?.address ?? 0,
        chip: front?.chip ?? "",
      },
    );
    expect(added.map((d) => d.role).toSorted()).toEqual(["gateway", "sensor", "siren"]);
    for (const d of added)
      expect(Object.keys(d).toSorted()).toEqual([
        "address",
        "chip",
        "development",
        "device",
        "firmware",
        "name",
        "role",
        "state",
      ]);
  });

  test("`hsn gateway set` and `hsn siren test` over lockstep", async () => {
    const c = await provision(new InProcessEnd(folder()));
    const gateway = c.idles
      .flatMap((i) => i.records)
      .flatMap((r) =>
        r.kind === "hubEvent" && r.row.code === "device_added"
          ? [JSON.parse(r.row.detail ?? "{}") as { name: string; role: string }]
          : [],
      )
      .find((d) => d.role === "gateway");
    const set = c.command({
      kind: "gatewaySet",
      name: gateway?.name ?? "",
      statusS: 20,
      interferenceDb: 12,
      interferenceS: 40,
      powerDbm: 20,
    });
    const test = c.command({ kind: "sirenTest", name: "hall", seconds: 5 });
    await c.runTo(c.now + 3 * SECOND);
    expect(c.replies.get(set)).toEqual({
      ok: true,
      result: { kind: "gatewaySet", name: gateway?.name ?? "", version: 2 },
    });
    expect(c.board("gateway1")?.gateway?.settings).toMatchObject({
      settingsVersion: 2,
      statusIntervalSeconds: 20,
      interferenceThresholdDb: 12,
      interferenceSeconds: 40,
      defaultTxPowerDbm: 20,
    });
    expect(c.replies.get(test)).toEqual({
      ok: true,
      result: { kind: "sirenTest", name: "hall", seconds: 5 },
    });
    const acted = c.board("siren1")?.siren?.acted.map((a) => a.message) ?? [];
    expect(
      acted.some((m) => m.type === MessageType.SirenCommand && m.action === SirenAction.Test),
    ).toBe(true);
  });

  test("the armed door: the siren sounds at the countdown's end, and the disarm silences it", async () => {
    const c = await armedDoor(new InProcessEnd(folder()));
    const siren = c.board("siren1")?.siren;
    const sounded = siren?.acted.find(
      (a) =>
        a.message.type === MessageType.SirenCommand && a.message.action === SirenAction.SoundAlarm,
    );
    const started = decisions(c, "countdown_started")[0];
    const alarm = decisions(c, "alarm")[0];
    expect(
      started === undefined || alarm === undefined ? 0 : alarm.atMs - started.atMs,
    ).toBeGreaterThanOrEqual(9_900);
    expect(sounded).toBeDefined();
    expect(siren?.output).toBe(0);
  });
});

describe("the same script, the same run (section 11: nothing reads the host's clock or random source)", () => {
  test("a run with a restart reproduces exactly too", async () => {
    const one = await SESSIONS["restart-in-countdown"](new InProcessEnd(folder()));
    const two = await SESSIONS["restart-in-countdown"](new InProcessEnd(folder()));
    expect(two.transcript).toEqual(one.transcript);
  });

  test("each boot of one seed has its own stream, and the same boot the same one", () => {
    const seed = fromHex(SEED);
    const draw = (boot: number) => toHex(lockstepRandom(seed, boot).bytes(64)._unsafeUnwrap());
    expect(draw(2)).not.toBe(draw(1));
    expect(draw(1)).toBe(draw(1));
    expect(draw(2)).toBe(draw(2));
  });

  test("two boots with one seed: the same steps add devices at different addresses", async () => {
    const end = new InProcessEnd(folder());
    const c = new Controller(end, SECOND);
    const addOne = async (name: string, from: number): Promise<number | undefined> => {
      await c.start(from, wallAt(from), true, SEED);
      // The same steps in each boot: the site (a sensor needs its channel), the board, the add.
      c.command({ kind: "siteSet", channel: 1, rate: 5 }, from);
      c.plug(name, Role.Sensor, from + 100_000);
      await c.runTo(from + SECOND);
      const id = c.command({ kind: "usbAdd", port: `${name}:usb`, name }, from + SECOND);
      await c.runTo(from + 3 * SECOND);
      c.unplug(name, from + 3 * SECOND);
      await c.runTo(from + 4 * SECOND);
      await c.stop(from + 4 * SECOND);
      const reply = c.replies.get(id);
      expect(reply?.ok === true ? "added" : JSON.stringify(reply)).toBe("added");
      return reply?.ok === true && reply.result.kind === "usbAdd"
        ? reply.result.address
        : undefined;
    };
    const first = await addOne("one", SECOND);
    const second = await addOne("two", 100 * SECOND);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  test("two runs give identical idle streams and identical databases", async () => {
    const a = folder();
    const b = folder();
    const one = await armedDoor(new InProcessEnd(a));
    const two = await armedDoor(new InProcessEnd(b));
    expect(two.transcript).toEqual(one.transcript);
    expect(dump(b)).toEqual(dump(a));
  });
});

describe("a stop or a kill inside a countdown (section 11, the restart tests)", () => {
  test("a clean stop: the second boot reads it, and the siren sounds at the countdown's end", async () => {
    const dataDir = folder();
    const c = await SESSIONS["restart-in-countdown"](new InProcessEnd(dataDir));
    // The second boot's own clock began at 0 at its start, as a real hub's does: its commit mark
    // reads no more than the time since then.
    const restartedAt = c.idles.find((i) => i.boot === 2)?.to ?? 0;
    const db = new Database(join(dataDir, DATABASE_FILE), { readonly: true });
    const mark = db
      .query<{ boot: number; last_seen_mono: number }, []>(
        "SELECT boot, last_seen_mono FROM device_state WHERE device_id = 0",
      )
      .get();
    db.close();
    expect(mark?.boot).toBe(2);
    expect(mark?.last_seen_mono ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      c.now - restartedAt,
    );
    expect(c.failure).toBeUndefined();
    expect(new Set(c.idles.map((i) => i.boot))).toEqual(new Set([1, 2]));
    const restarted = c.idles
      .flatMap((i) => i.records)
      .find((r) => r.kind === "hubEvent" && r.row.code === "restarted");
    expect(restarted?.kind === "hubEvent" ? restarted.row.detail : "").toContain(
      '"previousExit":"clean"',
    );
    const started = decisions(c, "countdown_started")[0];
    const alarm = decisions(c, "alarm")[0];
    const late =
      started === undefined || alarm === undefined ? Number.NaN : alarm.atMs - started.atMs;
    expect(late).toBeGreaterThanOrEqual(9_900);
    expect(late).toBeLessThanOrEqual(11_000);
  });

  test("a kill, and a start on an untrusted clock: the alarm comes, never early", async () => {
    const end = new InProcessEnd(folder());
    const c = await provision(end);
    c.command({ kind: "arm", sensors: "all", continue: false });
    await c.runTo(c.now + SECOND);
    const opened = c.now + SECOND;
    c.board("sensor1")?.sensor?.door(mono(opened), true);
    await c.runTo(opened + 3 * SECOND);
    end.kill();
    c.killed(c.now);
    const back = c.now + 2 * SECOND;
    await c.runTo(back);
    // The wall clock reads an hour behind and is not trusted: the downtime is not known by it.
    await c.start(back, wallAt(back) - 3_600_000, false, SEED);
    await c.runTo(opened + 60 * SECOND);
    expect(c.failure).toBeUndefined();
    const restarted = c.idles
      .flatMap((i) => i.records)
      .find((r) => r.kind === "hubEvent" && r.row.code === "restarted");
    expect(restarted?.kind === "hubEvent" ? restarted.row.detail : "").not.toContain(
      '"previousExit":"clean"',
    );
    const alarmAt = c.idles.findIndex((i) =>
      i.records.some((r) => r.kind === "decision" && r.row.kind === "alarm"),
    );
    expect(alarmAt).toBeGreaterThan(0);
    const idle = c.idles[alarmAt];
    expect(idle === undefined ? 0 : idle.to).toBeGreaterThanOrEqual(opened + 10 * SECOND - 50_000);
  });
});

describe("lines the hub refuses (section 11, errors)", () => {
  test("a line that is not a message, or a time already handled: `error`, and the hub process ends with 65", async () => {
    const end = new ProcessEnd(folder(), join(work, `r${folders}.sock`));
    const started = await end.send({
      type: "start",
      version: 2,
      at: 1000,
      wall: wallAt(1000),
      trusted: true,
      seed: SEED,
    });
    expect(started[0]?.type).toBe("idle");
    const advanced = await end.send({ type: "advance", to: 5000 });
    expect(advanced[0]?.type).toBe("idle");
    const past = await end.send({ type: "advance", to: 4000 });
    expect(past[0]?.type).toBe("error");
    await end.close();
  }, 30_000);

  test("in this process: a frame in the past and an unknown version are refused", async () => {
    const end = new InProcessEnd(folder());
    expect(
      (
        await end.send({
          type: "start",
          version: 2,
          at: 0,
          wall: wallAt(0),
          trusted: true,
          seed: SEED,
        })
      )[0]?.type,
    ).toBe("idle");
    expect((await end.send({ type: "advance", to: 2000 }))[0]?.type).toBe("idle");
    expect(
      (await end.send({ type: "frame", link: "x:usb", at: 1000, bytes: "0101" }))[0]?.type,
    ).toBe("error");
    expect(
      lockstepToHub.safeParse({
        type: "start",
        version: 1,
        at: 0,
        wall: 0,
        trusted: true,
        seed: SEED,
      }).success,
    ).toBe(false);
    end.kill();
  });
});

describe("the disarm during a 30-door alarm (burst-hang.session)", () => {
  test("is answered whole on the socket: the alarm ends, every siren is told off", async () => {
    const steps = readSession("burst-hang");
    const end = new ProcessEnd(folder(), join(work, "bh.sock"));
    const answers: LockstepFromHub[] = [];
    const sent = await (async () => {
      for (const step of steps) answers.push(...(await end.send(step.sent)));
      return answers;
    })().finally(() => end.close());
    const last = sent.at(-1);
    expect(last?.type).toBe("idle");
    const idle = last?.type === "idle" ? last : undefined;
    expect(JSON.stringify(idle).length).toBeGreaterThan(8192);
    const kinds = (idle?.records ?? []).flatMap((r) => (r.kind === "decision" ? [r.row.kind] : []));
    expect(kinds).toContain("alarm_ended");
    expect(kinds.filter((k) => k === "disarmed").length).toBeGreaterThan(0);
    expect(idle?.replies.map((r) => r.reply.ok)).toEqual([true]);
  }, 120_000);
});

describe("a settings change reaches each device by its own path (section 9)", () => {
  test("gateway at once and acknowledged by its status; siren at once; sensor in its next reply", async () => {
    const c = await provision(new InProcessEnd(folder()));
    const gatewayName =
      c.idles
        .flatMap((i) => i.records)
        .flatMap((r) =>
          r.kind === "hubEvent" && r.row.code === "device_added"
            ? [JSON.parse(r.row.detail ?? "{}") as { name: string; role: string }]
            : [],
        )
        .find((d) => d.role === "gateway")?.name ?? "";
    const gateway = c.command({ kind: "gatewaySet", name: gatewayName, powerDbm: 20 });
    const siren = c.command({ kind: "sirenSet", name: "hall", max: 120 });
    const sensor = c.command({ kind: "sensorSet", name: "front", countdown: 20 });
    const before = c.idles.length;
    await c.runTo(c.now + 1);
    const answered = c.idles.slice(before).find((i) => i.replies.some((r) => r.id === gateway));
    // The settings leave in the same `idle` as the answer: to the gateway and to the siren.
    const links = new Set(answered?.frames.map((f) => f.link));
    expect([links.has("gateway1:usb"), links.has("siren1:network")]).toEqual([true, true]);
    const version = (id: number) => {
      const reply = c.replies.get(id);
      return reply?.ok === true && "version" in reply.result ? reply.result.version : undefined;
    };
    // The gateway's next status carries the version: applied, nothing sent again after it.
    await c.runTo(c.now + 40 * SECOND);
    expect(c.board("gateway1")?.gateway?.settings?.settingsVersion).toBe(version(gateway));
    expect(c.board("gateway1")?.gateway?.settings?.defaultTxPowerDbm).toBe(20);
    const sentAgain = c.idles
      .slice(before + 1)
      .flatMap((i) => i.records)
      .filter((r) => r.kind === "decision" && r.row.kind === "gateway_settings");
    expect(sentAgain).toEqual([]);
    expect(c.board("siren1")?.siren?.held.version).toBe(version(siren));
    // A sensor takes settings only in a reply (§6): its next heartbeat brings them.
    await c.runTo(c.now + 15 * MINUTE);
    expect(c.board("sensor1")?.sensor?.held.version).toBe(version(sensor));
    expect(c.board("sensor1")?.sensor?.held.countdownS).toBe(20);
  }, 60_000);
});

describe("a door report through a gateway the hub counts offline (D97, D110)", () => {
  test("a reconnected gateway with no status and no Started: its forward proves the session, the report is acted on", async () => {
    // A gateway and a sensor only: no siren whose LoRa reports would prove the session sooner.
    const c = new Controller(new InProcessEnd(folder()), SECOND);
    await c.start(SECOND, wallAt(SECOND), true, SEED);
    c.plug("gateway1", Role.Gateway, SECOND + 100_000);
    c.plug("sensor1", Role.Sensor, SECOND + 100_000);
    await c.runTo(4 * SECOND);
    c.command({ kind: "siteSet", channel: 1, rate: 5, countdown: 10 });
    await c.runTo(5 * SECOND);
    c.command({ kind: "usbAdd", port: "sensor1:usb", name: "front" });
    await c.runTo(11 * SECOND);
    c.unplug("sensor1");
    await c.runTo(MINUTE);
    c.command({ kind: "arm", sensors: "all", continue: false });
    await c.runTo(c.now + 2 * SECOND);
    const board = c.board("gateway1");
    expect(board?.gateway).toBeDefined();
    // As the firmware: Started once per start-up, so the reconnection after the hub's restart
    // sends only its hello; and from now on no status.
    if (board?.gateway !== undefined) board.gateway.startedOnEveryConnection = false;
    if (board !== undefined) delete board.statusAt;
    await c.stop(c.now);
    await c.start(c.now + SECOND, wallAt(c.now + SECOND), true, SEED);
    const restarted = c.idles.length;
    await c.runTo(c.now + 70 * SECOND);
    const after = () => c.idles.slice(restarted).flatMap((i) => i.records);
    expect(
      after().filter((r) => r.kind === "decision" && r.row.kind === "gateway_offline"),
    ).toHaveLength(1);
    // Nothing from it since its hello: the session is still unproven when the door opens.
    expect(after().filter((r) => r.kind === "rx" && r.row.gatewayId !== null)).toEqual([]);
    const opened = c.now + SECOND;
    c.board("sensor1")?.sensor?.door(mono(opened), true);
    await c.runTo(opened + 15 * SECOND);
    const kinds = after().flatMap((r) => (r.kind === "decision" ? [r.row.kind] : []));
    expect([kinds.includes("countdown_started"), kinds.includes("alarm")]).toEqual([true, true]);
    // Recorded with the gateway and its counter, and the gateway heard from again.
    const report = after().find(
      (r) => r.kind === "rx" && r.row.type === MessageType.DoorChanged && r.row.gatewayId !== null,
    );
    expect(report?.kind === "rx" ? report.row.gwCounter : null).not.toBeNull();
    expect(c.failure).toBeUndefined();
  }, 60_000);
});

describe("the hub's own closes, on the wire (version 2, gateway-replaced.session)", () => {
  test("a newer session proven: idle.closed names the old link, nothing goes to it after, the alarm path uses the new one", async () => {
    const c = await gatewayReplaced(new InProcessEnd(folder()));
    expect(c.failure).toBeUndefined();
    const closed = c.idles.flatMap((i) => i.closed);
    expect(closed.map((x) => [x.link, x.reason])).toEqual([
      ["gateway1:usb", "gateway session replaced"],
    ]);
    const at = closed[0]?.at ?? 0;
    const later = c.idles.flatMap((i) => i.frames).filter((f) => f.at > at);
    expect(later.filter((f) => f.link === "gateway1:usb")).toEqual([]);
    expect(later.some((f) => f.link === "gateway1:network")).toBe(true);
    const kinds = c.idles.flatMap((i) =>
      i.to > at ? i.records.flatMap((r) => (r.kind === "decision" ? [r.row.kind] : [])) : [],
    );
    expect(
      ["countdown_started", "alarm", "siren_command", "alarm_ended"].every((k) =>
        kinds.includes(k),
      ),
    ).toBe(true);
  });
});
