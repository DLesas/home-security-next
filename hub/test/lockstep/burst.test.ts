/**
 * The 30-door burst (section 5's peak; the firmware's load test): 30 sensors and 8 sirens on an
 * armed site, every door opening in the same second, the reports and their repeats arriving
 * together. Every `advance` must be answered, with `idle` or `error`, in this process and on the
 * socket, however large the answer.
 */
import { shortTempFolder } from "../world/temp-folder.ts";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Role } from "@hsn/protocol";
import { err } from "neverthrow";
import { coreFault } from "../../src/core/model/errors.ts";
import { mono } from "../../src/core/model/time.ts";
import { type Core, MODULES, makeCore } from "../../src/core/step.ts";
import { MAX_FAULTS_PER_HOUR } from "../../src/shell/loop.ts";
import { endProcesses } from "../world/processes.ts";
import { Controller, type HubEnd, MINUTE, SECOND } from "./controller.ts";
import { InProcessEnd, ProcessEnd } from "./ends.ts";
import { provision, SEED, wallAt } from "./sessions.ts";

const work = shortTempFolder("hsn-bu-");
afterAll(async () => {
  await endProcesses();
  rmSync(work, { recursive: true, force: true });
});
let folders = 0;
const folder = (): string => join(work, `h${++folders}`);

const SENSORS = 30;
const SIRENS = 8;
const START = SECOND;

/** The burst home provisioned, armed, and every door opened at one instant. */
export async function burst(end: HubEnd): Promise<Controller> {
  const c = new Controller(end, START);
  await c.start(START, wallAt(START), true, SEED);
  const sensors = Array.from({ length: SENSORS }, (_, i) => `sensor${i + 1}`);
  const sirens = Array.from({ length: SIRENS }, (_, i) => `siren${i + 1}`);
  c.plug("gateway1", Role.Gateway, START + 100_000);
  for (const name of sensors) c.plug(name, Role.Sensor, START + 100_000);
  for (const name of sirens) c.plug(name, Role.Siren, START + 100_000);
  await c.runTo(START + 3 * SECOND);
  c.command({ kind: "siteSet", channel: 1, rate: 5, countdown: 10 });
  c.command({ kind: "siteWifi", name: "bench", password: "benchpass1" });
  await c.runTo(START + 4 * SECOND);
  for (const [i, name] of sensors.entries())
    c.command({ kind: "usbAdd", port: `${name}:usb`, name: `door${i + 1}` });
  for (const [i, name] of sirens.entries())
    c.command({ kind: "usbAdd", port: `${name}:usb`, name: `bell${i + 1}` });
  await c.runTo(START + 20 * SECOND);
  for (const name of sensors) c.unplug(name);
  await c.runTo(START + MINUTE);
  c.command({ kind: "arm", sensors: "all", continue: false });
  await c.runTo(c.now + 2 * SECOND);
  const opened = c.now + SECOND;
  for (const name of sensors) c.board(name)?.sensor?.door(mono(opened), true);
  await c.runTo(opened + 15 * SECOND);
  return c;
}

const added = (c: Controller) =>
  [...c.replies.values()].filter((r) => r.ok && r.result.kind === "usbAdd").length;
const decided = (c: Controller, kind: string) =>
  c.idles.flatMap((i) => i.records).filter((r) => r.kind === "decision" && r.row.kind === kind)
    .length;
const largestIdle = (c: Controller) =>
  Math.max(...c.transcript.filter((l) => l.startsWith("< ")).map((l) => l.length - 2));

describe("the 30-door burst, armed, 8 sirens (section 5)", () => {
  test("in this process: every advance answered, every door counted, the sirens sound", async () => {
    const c = await burst(new InProcessEnd(folder()));
    expect(c.failure).toBeUndefined();
    expect(added(c)).toBe(SENSORS + SIRENS);
    expect(decided(c, "countdown_started")).toBe(SENSORS);
    expect(decided(c, "alarm")).toBe(1);
    expect(decided(c, "siren_command")).toBeGreaterThanOrEqual(SIRENS);
    // Over the socket's 8 KB buffer: the answer that once lost its tail (section 11).
    expect(largestIdle(c)).toBeGreaterThan(8192);
  }, 120_000);

  test("a hub process on the socket: the same answers, every one whole", async () => {
    const inProcess = await burst(new InProcessEnd(folder()));
    const end = new ProcessEnd(folder(), join(work, "b.sock"));
    const c = await burst(end).finally(() => end.close());
    expect(c.failure).toBeUndefined();
    expect(c.transcript.length).toBe(inProcess.transcript.length);
    expect(decided(c, "alarm")).toBe(1);
  }, 180_000);
});

/** Every `advance` in the transcript has an answer, `idle` or `error`, before the next line. */
function everyAdvanceAnswered(c: Controller): void {
  const lines = c.transcript;
  const unanswered = lines.flatMap((line, i) =>
    line.startsWith('> {"type":"advance"') && !/^< \{"type":"(idle|error)"/.test(lines[i + 1] ?? "")
      ? [line]
      : [],
  );
  expect(unanswered).toEqual([]);
}

describe("every advance is answered, whatever happens inside (section 11)", () => {
  test("a step that faults: recorded, and the advance answered", async () => {
    let faults = 0;
    const real = makeCore(MODULES);
    const core: Core = {
      ...real,
      step: (state, input, deps) => {
        if (input.event.kind === "frame" && faults < 3) {
          faults += 1;
          return err(coreFault("frame", "test/burst", "a fault the test asked for", {}));
        }
        return real.step(state, input, deps);
      },
    };
    const c = await provision(new InProcessEnd(folder(), { core }));
    expect(faults).toBe(3);
    everyAdvanceAnswered(c);
    const recorded = c.idles
      .flatMap((i) => i.records)
      .filter((r) => r.kind === "hubEvent" && r.row.code === "core_fault");
    expect(recorded).toHaveLength(3);
  });

  test("a core that faults on everything: the loop stops (section 10), and the answer is error", async () => {
    const real = makeCore(MODULES);
    const core: Core = {
      ...real,
      step: (state, input, deps) =>
        input.event.kind === "boot"
          ? real.step(state, input, deps)
          : err(coreFault(input.event.kind, "test/burst", "always", {})),
    };
    const c = await provision(new InProcessEnd(folder(), { core }));
    // More faults within an hour than the loop takes (section 10): 101 commands at one instant.
    for (let n = 0; n <= MAX_FAULTS_PER_HOUR; n++) c.command({ kind: "status" });
    await c.runTo(c.now + SECOND);
    everyAdvanceAnswered(c);
    expect(c.failure).toMatch(/fatal error/u);
  });

  test("commits that fail: the advance is still answered", async () => {
    const end = new InProcessEnd(folder());
    const c = await provision(end);
    end.hub?.store.db.close(true);
    c.command({ kind: "arm", sensors: "all", continue: false });
    await c.runTo(c.now + 10 * MINUTE);
    everyAdvanceAnswered(c);
  });
});
