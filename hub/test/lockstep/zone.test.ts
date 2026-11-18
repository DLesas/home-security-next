/**
 * The time zone on the lockstep wire (`start.zone`, hub-design.md section 11): given, the core has
 * it from the boot's turn, as `main.ts` gives the system's, so a schedule entry has a next time and
 * runs when the clock reaches it; left out, as before, no entry has one; a zone the calendar does
 * not know is refused before anything starts (no database is opened).
 */
import { shortTempFolder } from "../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LockstepFromHub, LockstepToHub } from "../../src/control-protocol/index.ts";
import { InProcessEnd } from "./ends.ts";
import { SEED, WALL_AT_ZERO } from "./sessions.ts";

const work = shortTempFolder("hsn-zone-");
afterAll(() => {
  InProcessEnd.closeAll();
  rmSync(work, { recursive: true, force: true });
});
let folders = 0;
const folder = (): string => mkdtempSync(join(work, `z${String(folders++)}-`));

const SECOND = 1_000_000;
const MINUTE = 60 * SECOND;
const AT = SECOND;

function start(zone?: string): LockstepToHub {
  return {
    type: "start",
    version: 2,
    at: AT,
    wall: WALL_AT_ZERO,
    trusted: true,
    seed: SEED,
    ...(zone === undefined ? {} : { zone }),
  };
}

type Idle = Extract<LockstepFromHub, { readonly type: "idle" }>;

function idles(answers: readonly LockstepFromHub[]): readonly Idle[] {
  return answers.flatMap((a) => (a.type === "idle" ? [a] : []));
}

/** A schedule entry switching to Away at 00:05 local, every day; its reply's `nextMs`. */
async function entry(end: InProcessEnd): Promise<number | null | undefined> {
  const at = AT + SECOND;
  await end.send({
    type: "control",
    at,
    request: {
      id: 1,
      actor: "bench",
      command: {
        kind: "op",
        op: "schedule.create",
        body: {
          name: "Night",
          action: "switchMode",
          target: { mode: 1 },
          at: "00:05",
          days: "everyDay",
          enabled: true,
        },
      },
    },
  });
  const replies = idles(await end.send({ type: "advance", to: at })).flatMap((i) => i.replies);
  const reply = replies.find((r) => r.id === 1)?.reply;
  expect(reply?.ok).toBe(true);
  if (reply?.ok !== true || reply.result.kind !== "op") return undefined;
  return (reply.result.body as { nextMs?: number | null }).nextMs;
}

describe("start.zone on the lockstep wire (section 11)", () => {
  test("given: the entry has a next time, and runs when the clock reaches it", async () => {
    const end = new InProcessEnd(folder());
    expect(idles(await end.send(start("Europe/London")))).toHaveLength(1);
    // 13 November is GMT in London: 00:05 local is 00:05 UTC.
    expect(await entry(end)).toBe(WALL_AT_ZERO + 5 * 60_000);
    const before = idles(await end.send({ type: "advance", to: 4 * MINUTE })).flatMap(
      (i) => i.records,
    );
    expect(before.filter((r) => r.kind === "decision" && r.row.kind === "mode_switched")).toEqual(
      [],
    );
    const after = idles(await end.send({ type: "advance", to: 6 * MINUTE })).flatMap(
      (i) => i.records,
    );
    const switched = after.flatMap((r) =>
      r.kind === "decision" && r.row.kind === "mode_switched" ? [r.row] : [],
    );
    expect(switched).toHaveLength(1);
    expect(switched[0]?.atMs).toBe(WALL_AT_ZERO + 5 * 60_000);
    end.kill();
  });

  test("left out: as before, no time zone, so no entry has a next time", async () => {
    const end = new InProcessEnd(folder());
    expect(idles(await end.send(start()))).toHaveLength(1);
    expect(await entry(end)).toBeNull();
    const after = idles(await end.send({ type: "advance", to: 6 * MINUTE })).flatMap(
      (i) => i.records,
    );
    expect(after.filter((r) => r.kind === "decision" && r.row.kind === "mode_switched")).toEqual(
      [],
    );
    end.kill();
  });

  test("a zone the calendar does not know: error, and nothing started (no database)", async () => {
    const dir = folder();
    const end = new InProcessEnd(dir);
    const answers = await end.send(start("Mars/Olympus_Mons"));
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ type: "error" });
    expect(answers[0]?.type === "error" ? answers[0].message : "").toContain("Mars/Olympus_Mons");
    expect(existsSync(join(dir, "hub.db"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("a zone of the wrong shape is refused by the schema", async () => {
    const { lockstepToHub } = await import("../../src/control-protocol/index.ts");
    expect(lockstepToHub.safeParse({ ...start(), zone: "" }).success).toBe(false);
    expect(lockstepToHub.safeParse({ ...start(), zone: 3 }).success).toBe(false);
    expect(lockstepToHub.safeParse(start("UTC")).success).toBe(true);
  });
});
