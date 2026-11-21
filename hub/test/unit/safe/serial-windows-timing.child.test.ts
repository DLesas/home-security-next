/**
 * The Windows COM adapter's timed wakes, run only as `serial-windows.test.ts`'s child process
 * (`HSN_SERIAL_TIMING_CHILD=1`), which holds nothing but them: in the whole test run's process its
 * own collections would pause the thread across a 2 to 3 ms timed close. Skipped in a test run.
 */
import { describe, expect, test } from "bun:test";
import { DRAINED, READS, GATE } from "./serial-windows-mock-worker.ts";
import { expectClosed, fakePort, until, wakeBudgetMs } from "./serial-windows-doubles.ts";

describe.skipIf(process.env.HSN_SERIAL_TIMING_CHILD !== "1")(
  "the Windows COM adapter, timed",
  () => {
    test("close twice during a pending read releases once and consumes no further bytes", async () => {
      const { port, shared, received, operations } = fakePort("waiting");
      const reading = await until(() => Atomics.load(shared, READS) === 1);
      const started = performance.now();
      port.close();
      port.close();
      await expectClosed(shared, port.closed);
      const elapsed = performance.now() - started;
      console.log(`COM double: pending read to released handle ${elapsed.toFixed(3)} ms`);
      expect(reading).toBe(true);
      expect(elapsed).toBeLessThan(wakeBudgetMs);
      expect(Atomics.load(shared, READS)).toBe(1);
      expect(Atomics.load(shared, DRAINED)).toBe(2);
      expect(received).toEqual([]);
      expect(operations.filter((name) => name === "CloseHandle")).toHaveLength(1);
    });

    test.each([
      ["waiting", READS],
      ["before-read", GATE],
      ["after-read", GATE],
      ["busy-read", READS],
    ] as const)("a write wakes the worker %s", async (mode, phase) => {
      const { port, shared } = fakePort(mode);
      const reached = await until(() => Atomics.load(shared, phase) > 0);
      const started = performance.now();
      const sent = await Promise.race([
        port.write(Uint8Array.of(1, 2, 3)),
        Bun.sleep(500).then(() => undefined),
      ]);
      const elapsed = performance.now() - started;
      port.close();
      await port.closed;
      console.log(`COM double: ${mode} write through completion ${elapsed.toFixed(3)} ms`);
      expect(reached && sent?.isOk()).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(wakeBudgetMs);
    });

    test("a second write wakes the same pending read without waiting for its timeout", async () => {
      const { port, shared } = fakePort("waiting");
      const reading = await until(() => Atomics.load(shared, READS) > 0);
      const delays: number[] = [];
      const outcomes = [];
      for (let index = 0; index < 2; index++) {
        const asked = performance.now();
        outcomes.push((await port.write(Uint8Array.of(index, 1, 2))).isOk());
        delays.push(performance.now() - asked);
      }
      port.close();
      await port.closed;
      console.log(
        `COM double: back-to-back write through completion ${delays.map((ms) => ms.toFixed(3)).join(", ")} ms`,
      );
      expect(reading && outcomes.every(Boolean)).toBe(true);
      expect(Atomics.load(shared, READS)).toBe(1);
      for (const ms of delays) {
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(wakeBudgetMs);
      }
    });
  },
);
