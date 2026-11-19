/**
 * The bench as its process serves it (`src/bench.ts`): its boards start as real boards do, with no
 * pairing window open, and its commands hold a board's button for as long as they say; the smoke
 * page's siren is held when the page asks for its session.
 */
import { afterEach, expect, test } from "bun:test";
import { type Bench, type BenchLine, readCommand, startBench } from "../src/bench.ts";
import { PAIRING_HOLD_MS, RESET_HOLD_MS } from "../src/boards/board.ts";

let running: Bench | undefined;

afterEach(() => {
  running?.stop();
  running = undefined;
});

/** Starts the bench with the smoke boards on any free port, keeping the lines it says. */
async function started(): Promise<{ bench: Bench; lines: BenchLine[] } | undefined> {
  const lines: BenchLine[] = [];
  const bench = await startBench({ port: 0, smoke: true }, (line) => lines.push(line));
  expect(bench.ok).toBe(true);
  if (!bench.ok) return undefined;
  running = bench.value;
  return { bench: bench.value, lines };
}

test("no board's pairing window is open at the start; a five-second hold opens one", async () => {
  const run = await started();
  if (run === undefined) return;
  const { bench } = run;
  expect([...bench.boards.values()].map((board) => board.window)).toEqual(
    [...bench.boards.keys()].map(() => "closed"),
  );
  bench.command({ cmd: "hold", board: "siren", ms: PAIRING_HOLD_MS });
  expect(bench.boards.get("siren")?.window).toBe("pairing");
  expect(bench.boards.get("sensor")?.window).toBe("closed");
});

test("hold: under 5 seconds nothing, from 5 the window, through 15 a reset with a new code", async () => {
  const run = await started();
  if (run === undefined) return;
  const { bench } = run;
  const gateway = bench.boards.get("gateway");
  const code = gateway?.code;
  bench.command({ cmd: "hold", board: "gateway", ms: PAIRING_HOLD_MS - 1 });
  expect(gateway?.window).toBe("closed");
  bench.command({ cmd: "hold", board: "gateway", ms: PAIRING_HOLD_MS });
  expect(gateway?.window).toBe("pairing");
  bench.command({ cmd: "hold", board: "gateway", ms: RESET_HOLD_MS });
  expect(gateway?.window).toBe("closed");
  expect(gateway?.resets).toBe(1);
  expect(gateway?.code).not.toBe(code);
});

test("asking for the smoke session holds the smoke siren's button: its window opens", async () => {
  const run = await started();
  if (run === undefined) return;
  const { bench } = run;
  expect(bench.boards.get("smoke-siren")?.window).toBe("closed");
  const page = new URL(bench.url.replace("ws://", "http://"));
  const answer = await fetch(new URL("/smoke/session", page));
  expect(answer.ok).toBe(true);
  await answer.arrayBuffer();
  expect(bench.boards.get("smoke-siren")?.window).toBe("pairing");
  expect(bench.boards.get("smoke-sensor")?.window).toBe("update");
});

test("a hold command line names the board and a length; anything else is not one", () => {
  expect(readCommand('{"cmd":"hold","board":"siren","ms":15000}')).toEqual({
    cmd: "hold",
    board: "siren",
    ms: 15_000,
  });
  expect(readCommand('{"cmd":"press","board":"siren"}')).toBeUndefined();
  expect(readCommand('{"cmd":"hold","board":"siren"}')).toBeUndefined();
  expect(readCommand('{"cmd":"hold","ms":5000}')).toBeUndefined();
  expect(readCommand('{"cmd":"hold","board":"siren","ms":-1}')).toBeUndefined();
});
