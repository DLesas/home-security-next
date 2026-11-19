/**
 * A day in seconds (hub-design.md section 11, "Lockstep"): home B of section 5 (30 sensors,
 * 4 sirens, one gateway) provisioned over USB, then a whole day against the lockstep hub, its
 * clock driven by the controller. Prints how long it took; checks the routine commits come every
 * five minutes as in the write-budget test, and every device was heard all day.
 */
import { shortTempFolder } from "../world/temp-folder.ts";
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Role } from "@hsn/protocol";
import { Controller, DAY, MINUTE, SECOND } from "./controller.ts";
import { InProcessEnd } from "./ends.ts";
import { SEED, wallAt } from "./sessions.ts";

const work = shortTempFolder("hsn-day-");
afterAll(() => {
  InProcessEnd.closeAll();
  rmSync(work, { recursive: true, force: true });
});

test("home B's day against the lockstep hub", async () => {
  const end = new InProcessEnd(join(work, "hub"));
  const started = performance.now();
  const c = new Controller(end, SECOND, 7);
  await c.start(SECOND, wallAt(SECOND), true, SEED);
  c.plug("gateway1", Role.Gateway);
  const sensors = Array.from({ length: 30 }, (_, i) => `sensor${i + 1}`);
  const sirens = Array.from({ length: 4 }, (_, i) => `siren${i + 1}`);
  for (const name of sensors) c.plug(name, Role.Sensor);
  for (const name of sirens) c.plug(name, Role.Siren);
  await c.runTo(3 * SECOND);
  c.command({ kind: "siteSet", channel: 1, rate: 5 });
  c.command({ kind: "siteWifi", name: "bench", password: "benchpass1" });
  for (const [i, name] of [...sensors, ...sirens].entries()) {
    c.command(
      { kind: "usbAdd", port: `${name}:usb`, name: name.replace(/(\d+)$/u, "-$1") },
      4 * SECOND + i * SECOND,
    );
  }
  await c.runTo(45 * SECOND);
  for (const name of sensors) c.unplug(name);
  const from = c.now + MINUTE;
  await c.runTo(from);
  const hub = end.hub;
  const before = hub?.store.writer.stats.commitsByReason.due ?? 0;
  await c.runTo(from + DAY);
  const seconds = (performance.now() - started) / 1000;
  const stats = end.hub?.store.writer.stats;
  const added = [...c.replies.values()].filter((r) => r.ok && r.result.kind === "usbAdd").length;
  console.log(
    `home B's day in lockstep: ${seconds.toFixed(1)} s real time; ${stats?.commits} commits ` +
      `(${JSON.stringify(stats?.commitsByReason)}), ${c.transcript.length} lines on the wire`,
  );
  expect(c.failure).toBeUndefined();
  expect(added).toBe(34);
  // Routine flushes come five minutes after the first routine item: at most 288 a day.
  const routine = (stats?.commitsByReason.due ?? 0) - before;
  expect(routine).toBeLessThanOrEqual(288);
  expect(routine).toBeGreaterThanOrEqual(270);
  expect(stats?.commits ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1_400);
  for (const name of sensors) expect(c.board(name)?.sensor?.sent.length).toBeGreaterThan(470);
  for (const name of sirens) expect(c.board(name)?.siren?.reports.length).toBeGreaterThan(2_800);
  end.kill();
}, 600_000);
