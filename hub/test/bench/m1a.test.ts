/**
 * M1a's "done when" in real time (hub-design.md section 11, "Real time: M1a's 'done when'"): the
 * real hub (`src/shell/main.ts`) against the firmware's real sensor, siren and gateway roles on
 * the bench (`hsn_bench`), meeting on pseudo-terminals: USB links as `--serial` ports, the siren's
 * Wi-Fi through `tools/bench-bridge`.
 *
 * Setup: the gateway is added by itself (D100); the site is set; the sensor and the siren are
 * added with `hsn usb add`; the sensor's USB power goes off. Then three runs, each from a
 * disarmed house with the door shut:
 * 1. armed, the door opens: the sensor buzzes; at the countdown's end the siren's output switches
 *    on; `hsn disarm` switches it off;
 * 2. armed, the door opens, `hsn disarm` inside the countdown: the buzzer stops and the siren
 *    never switches on;
 * 3. armed, the door opens, the hub is stopped and started during the countdown: the siren still
 *    sounds at its end.
 * Every check reads the bench's timeline or `hsn log`, and every wait has a timeout that fails
 * with a message. A check that fails is recorded and the run goes on where it can, so one run
 * shows every finding; the test fails if any did.
 *
 * It needs the bench: `$HSN_BENCH`, or `firmware/build/host-debug/tools/bench/hsn_bench`
 * (`cd firmware && cmake --preset host-debug && cmake --build --preset host-debug --target
 * hsn_bench`). It takes about two minutes, so it runs only with `HSN_M1A=1`: `bun run m1a` at
 * the repository's root.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchManifest } from "../../src/control-protocol/manifest.ts";
import { endProcesses, spawnTracked } from "../world/processes.ts";
import { BenchBridge, networkLinks } from "../../../tools/bench-bridge/src/bridge.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const BENCH =
  process.env.HSN_BENCH ??
  join(ROOT, "firmware", "build", "host-debug", "tools", "bench", "hsn_bench");
const HUB_MAIN = join(ROOT, "hub", "src", "shell", "main.ts");
const HSN = join(ROOT, "hub", "cli", "hsn.ts");
const ENABLED = process.env.HSN_M1A === "1";
const BUILT = existsSync(BENCH);
/** The site's entry countdown for these runs: short, so the three take a few minutes. */
const COUNTDOWN_S = 10;
const SECOND_MS = 1000;

/** One line of the bench's timeline. */
interface TimelineLine {
  readonly t: number;
  readonly actor?: string;
  readonly kind?: string;
  readonly flag?: boolean;
  readonly value?: number;
  readonly command?: string;
  readonly note?: string;
  readonly text?: string;
}

const work = mkdtempSync("/tmp/hsn-m1a-");
afterAll(async () => {
  await endProcesses();
  if (process.env.HSN_M1A_KEEP !== "1") rmSync(work, { recursive: true, force: true });
});

class Run {
  readonly timeline: TimelineLine[] = [];
  readonly findings: string[] = [];
  readonly passed: string[] = [];
  readonly data = join(work, "hub");
  readonly #bench: Bun.Subprocess<"pipe", "pipe", "pipe">;
  #hub: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
  #bridge: BenchBridge | undefined;
  readonly port: number;
  readonly started = Date.now();

  constructor(port: number) {
    this.port = port;
    const bench = spawnTracked(
      [
        BENCH,
        "--sensors",
        "1",
        "--sirens",
        "1",
        "--gateways",
        "1",
        "--manifest",
        join(work, "manifest.json"),
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    this.#bench = bench;
    void (async () => {
      const reader = bench.stdout.getReader();
      let pending = "";
      for (let reads = 0; reads < 10_000_000; reads++) {
        const chunk = await reader.read();
        if (chunk.done) return;
        pending += new TextDecoder().decode(chunk.value);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() !== "") this.timeline.push(JSON.parse(line) as TimelineLine);
        }
      }
    })();
  }

  manifest() {
    return benchManifest.parse(JSON.parse(readFileSync(join(work, "manifest.json"), "utf8")));
  }

  link(device: string, kind: "usb" | "network"): string {
    return (
      this.manifest()
        .devices.find((d) => d.name === device)
        ?.links.find((l) => l.kind === kind)?.path ?? ""
    );
  }

  startHub(): void {
    const usb = this.manifest().devices.flatMap((d) =>
      d.links.filter((l) => l.kind === "usb").map((l) => l.path),
    );
    this.#hub = spawnTracked(
      [
        "bun",
        HUB_MAIN,
        "--data",
        this.data,
        "--port",
        String(this.port),
        "--no-usb-watch",
        ...usb.flatMap((p) => ["--serial", p]),
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
  }

  async stopHub(): Promise<number> {
    const hub = this.#hub;
    if (hub === undefined) return -1;
    hub.kill("SIGTERM");
    const code = await Promise.race([hub.exited, Bun.sleep(10 * SECOND_MS).then(() => -2)]);
    if (code === -2) hub.kill(9);
    this.#hub = undefined;
    return code;
  }

  startBridge(): void {
    this.#bridge = new BenchBridge(networkLinks(this.manifest()), {
      hubUrl: `ws://127.0.0.1:${this.port}/device`,
      retryMs: 250,
    });
    this.#bridge.start();
  }

  /** A line of the bench's script. */
  bench(line: string): void {
    void this.#bench.stdin.write(`${line}\n`);
    void this.#bench.stdin.flush();
  }

  /** `hsn …` with the run's data folder: exit code and output. */
  async hsn(...args: string[]): Promise<{ code: number; out: string }> {
    const proc = spawnTracked(["bun", HSN, "--data", this.data, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: out + err };
  }

  /** The bench's true time now: its last line's. */
  get t(): number {
    return this.timeline.at(-1)?.t ?? 0;
  }

  /** The first timeline line after `from` that matches, waiting at most `ms`. */
  async waitLine(
    what: string,
    match: (line: TimelineLine) => boolean,
    from: number,
    ms: number,
  ): Promise<TimelineLine | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.timeline.find((line) => line.t >= from && match(line));
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        this.findings.push(`timed out after ${ms / SECOND_MS} s waiting for ${what}`);
        return undefined;
      }
      await Bun.sleep(50);
    }
  }

  /** Waits until `hsn …`'s output passes `check`, at most `ms`. */
  async waitHsn(
    what: string,
    args: readonly string[],
    check: (out: string) => boolean,
    ms: number,
  ): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      const { out } = await this.hsn(...args);
      if (check(out)) return true;
      if (Date.now() > deadline) {
        this.findings.push(
          `timed out after ${ms / SECOND_MS} s waiting for ${what}; \`hsn ${args.join(" ")}\` said:\n${out}`,
        );
        return false;
      }
      await Bun.sleep(500);
    }
  }

  check(ok: boolean, what: string, evidence = ""): void {
    if (ok) this.passed.push(what);
    else this.findings.push(evidence === "" ? what : `${what}\n${evidence}`);
  }

  /** The bench's command line `command` and what follows it, for a finding. */
  around(from: number, to: number, actors: readonly string[]): string {
    return this.timeline
      .filter(
        (l) =>
          l.t >= from &&
          l.t <= to &&
          (l.actor === undefined || actors.includes(l.actor)) &&
          l.kind !== "wait",
      )
      .map((l) => JSON.stringify(l))
      .join("\n");
  }

  async close(): Promise<void> {
    this.bench("quit");
    await this.#bridge?.stop();
    await this.stopHub();
    await Promise.race([this.#bench.exited, Bun.sleep(3 * SECOND_MS)]);
    this.#bench.kill(9);
    writeFileSync(
      join(work, "timeline.jsonl"),
      this.timeline.map((l) => JSON.stringify(l)).join("\n"),
    );
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port ?? 0;
  await server.stop(true);
  return port;
}

const isBuzzer = (on: boolean) => (l: TimelineLine) =>
  l.actor === "sensor1" && l.kind === "buzzer" && l.value === (on ? 1 : 0);
const isSiren = (on: boolean) => (l: TimelineLine) =>
  l.actor === "siren1" && l.kind === "output" && l.flag === on;

/** Arms, waits until the sensor has been told, and opens the door: the door command's line. */
async function armAndOpen(run: Run, label: string): Promise<TimelineLine | undefined> {
  const armed = await run.hsn("arm", "--all");
  run.check(armed.code === 0, `${label}: \`hsn arm --all\` answers`, armed.out);
  // The sensor learns it is armed from its next reply; the hub arms at once, which is what counts.
  const from = run.t;
  run.bench("door sensor1 open");
  return run.waitLine(
    "the door command",
    (l) => l.command === "door sensor1 open",
    from,
    5 * SECOND_MS,
  );
}

/** Shuts the door, and waits until the hub has heard it shut (its report may need a retry). */
async function shutDoor(run: Run, label: string): Promise<void> {
  const from = run.t;
  run.bench("door sensor1 close");
  await run.waitLine(
    `${label}: the door command`,
    (l) => l.command === "door sensor1 close",
    from,
    5 * SECOND_MS,
  );
  await run.waitHsn(
    `${label}: the hub hearing the door shut`,
    ["status"],
    (out) => /front\s+\S+\s+(closed|shut)/u.test(out),
    30 * SECOND_MS,
  );
}

describe.skipIf(!ENABLED || !BUILT)(
  "M1a: the real hub against the bench's roles, in real time",
  () => {
    test(
      "set up; the armed door through to the siren; a disarm in the countdown; a restart in the countdown",
      async () => {
        const run = new Run(await freePort());
        const durations: string[] = [];
        // The bench, the hub and the bridge are stopped however the steps end.
        await (async () => {
          await run.waitLine(
            "the bench's start",
            (l) => l.note !== undefined || l.kind === "boot",
            0,
            10 * SECOND_MS,
          );
          expect(existsSync(join(work, "manifest.json"))).toBe(true);
          run.startHub();
          run.startBridge();
          const setupStart = Date.now();

          // The gateway is added by itself (D100).
          await run.waitHsn(
            "the gateway added by itself",
            ["devices"],
            (out) => /gateway-\S+\s+gateway\s+contacted/u.test(out),
            20 * SECOND_MS,
          );
          const site = await run.hsn(
            "site",
            "set",
            "channel=868.3",
            "rate=DR5",
            `countdown=${COUNTDOWN_S}`,
          );
          run.check(site.code === 0, "`hsn site set` answers", site.out);
          const wifi = await run.hsn("site", "wifi", "--name", "bench", "--password", "benchpass1");
          run.check(wifi.code === 0, "`hsn site wifi` answers", wifi.out);
          for (const [device, name] of [
            ["sensor1", "front"],
            ["siren1", "hall"],
          ] as const) {
            const from = run.t;
            const added = await run.hsn("usb", "add", run.link(device, "usb"), "--name", name);
            run.check(
              added.code === 0,
              `\`hsn usb add ${run.link(device, "usb")} --name ${name}\` (${device}) answers`,
              `exit ${added.code}: ${added.out.trim()}\n${run.around(from, run.t, [device])}`,
            );
            await run.waitHsn(
              `${name} contacted`,
              ["devices"],
              (out) => new RegExp(`${name}\\s+\\S+\\s+contacted`, "u").test(out),
              20 * SECOND_MS,
            );
          }
          run.bench("usb-power sensor1 off");
          await run.waitHsn(
            "the siren up on Wi-Fi and LoRa",
            ["status"],
            (out) => /hall\s+off\s+\S+\s+off\s+up\s+up/u.test(out),
            60 * SECOND_MS,
          );
          durations.push(`setup ${((Date.now() - setupStart) / SECOND_MS).toFixed(0)} s`);

          // Run 1: the armed door through to the siren, then a disarm.
          const one = Date.now();
          const open1 = await armAndOpen(run, "run 1");
          if (open1 !== undefined) {
            const buzz = await run.waitLine(
              "run 1: the sensor buzzing",
              isBuzzer(true),
              open1.t,
              5 * SECOND_MS,
            );
            run.check(buzz !== undefined, "run 1: the sensor buzzes when the armed door opens");
            const on = await run.waitLine(
              "run 1: the siren's output on",
              isSiren(true),
              open1.t,
              (COUNTDOWN_S + 10) * SECOND_MS,
            );
            const late = on === undefined ? Number.NaN : on.t - open1.t;
            run.check(
              on !== undefined && late >= COUNTDOWN_S - 1 && late <= COUNTDOWN_S + 3,
              `run 1: the siren switches on at the countdown's end (${late.toFixed(2)} s after the door, countdown ${COUNTDOWN_S} s)`,
              run.around(open1.t, open1.t + COUNTDOWN_S + 5, ["sensor1", "siren1"]),
            );
            const from = run.t;
            const disarm = await run.hsn("disarm", "--all");
            run.check(
              disarm.code === 0 && disarm.out.includes("alarm ended"),
              "run 1: `hsn disarm` answers and ends the alarm",
              disarm.out,
            );
            const off = await run.waitLine(
              "run 1: the siren's output off",
              isSiren(false),
              from,
              5 * SECOND_MS,
            );
            run.check(off !== undefined, "run 1: `hsn disarm` switches the siren off");
            const log = await run.hsn("log", "--kind", "decision");
            for (const kind of [
              "armed",
              "countdown_started",
              "alarm",
              "siren_command",
              "siren_confirmed",
              "disarmed",
            ])
              run.check(
                log.out.includes(`decision ${kind}`),
                `run 1: \`hsn log\` has the ${kind} decision`,
                log.out,
              );
            await shutDoor(run, "run 1");
          }
          durations.push(`run 1 ${((Date.now() - one) / SECOND_MS).toFixed(0)} s`);

          // Run 2: disarmed inside the countdown.
          const two = Date.now();
          const open2 = await armAndOpen(run, "run 2");
          if (open2 !== undefined) {
            await run.waitLine("run 2: the sensor buzzing", isBuzzer(true), open2.t, 5 * SECOND_MS);
            await Bun.sleep(3 * SECOND_MS);
            const from = run.t;
            const disarm = await run.hsn("disarm", "--all");
            run.check(
              disarm.code === 0,
              "run 2: `hsn disarm` inside the countdown answers",
              disarm.out,
            );
            const quiet = await run.waitLine(
              "run 2: the buzzer stopping",
              isBuzzer(false),
              from,
              8 * SECOND_MS,
            );
            run.check(
              quiet !== undefined,
              "run 2: the buzzer stops on `hsn disarm`",
              run.around(from, run.t, ["sensor1"]),
            );
            await Bun.sleep((COUNTDOWN_S + 5) * SECOND_MS);
            const sounded = run.timeline.find((l) => l.t >= open2.t && isSiren(true)(l));
            run.check(
              sounded === undefined,
              "run 2: the siren never switches on",
              sounded === undefined ? "" : JSON.stringify(sounded),
            );
            await shutDoor(run, "run 2");
          }
          durations.push(`run 2 ${((Date.now() - two) / SECOND_MS).toFixed(0)} s`);

          // Run 3: the hub stopped and started during the countdown.
          const three = Date.now();
          const open3 = await armAndOpen(run, "run 3");
          if (open3 !== undefined) {
            await run.waitLine("run 3: the sensor buzzing", isBuzzer(true), open3.t, 5 * SECOND_MS);
            await Bun.sleep(2 * SECOND_MS);
            const stopped = await run.stopHub();
            run.check(stopped === 0, `run 3: the hub stops cleanly (exit ${stopped})`);
            run.startHub();
            const on = await run.waitLine(
              "run 3: the siren's output on after the restart",
              isSiren(true),
              open3.t,
              (COUNTDOWN_S + 20) * SECOND_MS,
            );
            const late = on === undefined ? Number.NaN : on.t - open3.t;
            run.check(
              on !== undefined && late >= COUNTDOWN_S - 1 && late <= COUNTDOWN_S + 5,
              `run 3: after the restart the siren still sounds at the countdown's end (${late.toFixed(2)} s after the door)`,
              run.around(open3.t, open3.t + COUNTDOWN_S + 10, ["sensor1", "siren1"]),
            );
            const from = run.t;
            const disarm = await run.hsn("disarm", "--all");
            run.check(
              disarm.code === 0,
              "run 3: `hsn disarm` answers after the restart",
              disarm.out,
            );
            const off = await run.waitLine(
              "run 3: the siren's output off",
              isSiren(false),
              from,
              5 * SECOND_MS,
            );
            run.check(off !== undefined, "run 3: `hsn disarm` switches the siren off");
            const log = await run.hsn("log", "--kind", "event");
            run.check(log.out.includes("restarted"), "run 3: `hsn log` has the restart", log.out);
            await shutDoor(run, "run 3");
          }
          durations.push(`run 3 ${((Date.now() - three) / SECOND_MS).toFixed(0)} s`);
        })().finally(async () => {
          await run.close();
        });
        console.log(`M1a: ${durations.join(", ")}; ${run.passed.length} checks passed`);
        for (const finding of run.findings) console.log(`M1a FINDING: ${finding}`);
        expect(run.findings).toEqual([]);
      },
      10 * 60 * SECOND_MS,
    );
  },
);

describe("M1a: what it needs", () => {
  test.skipIf(ENABLED && BUILT)(
    `skipped: ${!BUILT ? `the bench is not built at ${BENCH} (cd firmware && cmake --preset host-debug && cmake --build --preset host-debug --target hsn_bench), or set HSN_BENCH` : "set HSN_M1A=1 to run it (bun run m1a)"}`,
    () => {
      expect(ENABLED && BUILT).toBe(false);
    },
  );
});
