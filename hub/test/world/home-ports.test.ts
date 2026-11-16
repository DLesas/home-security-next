/**
 * `HomeSpec.calendar` and `HomeSpec.files` reach the whole hub's loop: with the real calendar a
 * schedule entry has a next time (with the unbuilt one, none); with file jobs, a `fileJob` is
 * handed to them. Left out, the home is as it always was.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { FileWork } from "../../src/core/model/effects.ts";
import type { JobId } from "../../src/core/model/ids.ts";
import { controlCommand, typedCommand } from "../../src/control-protocol/index.ts";
import type { ControlCommand } from "../../src/core/model/control.ts";
import { makeCalendar } from "../../src/shell/calendar/calendar.ts";
import { Home } from "./home.ts";

const homes: Home[] = [];
afterAll(() => {
  for (const home of homes) home.close();
});

/** `hsn op <name>` as the control socket gives it to the core. */
function op(name: string, body: unknown): ControlCommand {
  const typed = typedCommand(controlCommand.parse({ kind: "op", op: name, body }));
  expect(typed).toBeDefined();
  return typed ?? { kind: "status" };
}

const SPEC = { name: "ports", sensors: 1, sirens: 1, gateways: 1, seed: 3 } as const;

/** A schedule entry made with `hsn op`; its reply's `nextMs`. */
function nextOf(home: Home): unknown {
  home.input({ kind: "timeZone", zone: "Europe/London" });
  const request = home.command(
    op("schedule.create", {
      name: "Night",
      action: "switchMode",
      target: { mode: 1 },
      at: "22:00",
      days: "everyDay",
      enabled: true,
    }),
  );
  const reply = home.replyTo(request);
  expect(reply?.ok).toBe(true);
  return reply?.ok === true && reply.result.kind === "op"
    ? (reply.result.body as { nextMs?: unknown }).nextMs
    : undefined;
}

describe("a home's calendar and file jobs (HomeSpec)", () => {
  test("the real calendar: the entry has a next time; the unbuilt one, as before: none", async () => {
    const real = await Home.create({ ...SPEC, calendar: makeCalendar()._unsafeUnwrap() });
    homes.push(real);
    expect(typeof nextOf(real)).toBe("number");
    const unbuilt = await Home.create(SPEC);
    homes.push(unbuilt);
    expect(nextOf(unbuilt)).toBeNull();
  });

  test("file jobs: a backup's job is handed to them", async () => {
    const jobs: { job: JobId; work: FileWork }[] = [];
    const home = await Home.create({
      ...SPEC,
      files: {
        perform: (job, work) => {
          jobs.push({ job, work });
          return { kind: "ready", outcome: { kind: "failed", reason: "io", message: "test" } };
        },
      },
    });
    homes.push(home);
    const set = home.command(op("backup.settings", { folder: "/backups" }));
    expect(home.replyTo(set)?.ok).toBe(true);
    const now = home.command(op("backup.now", {}));
    expect(home.replyTo(now)?.ok).toBe(true);
    expect(jobs.map((j) => j.work.kind)).toContain("backup");
  });
});
