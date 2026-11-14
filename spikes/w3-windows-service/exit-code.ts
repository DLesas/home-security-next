#!/usr/bin/env bun
/**
 * Spike W3's stand-in for a hub that asks to be restarted: appends one line (its start time and
 * process id) to a counter file, waits a moment, and exits with the code it is given. Run as a
 * Windows service with "restart on failure", exit code 70 (HD 10: "restart me") must bring it
 * back again and again; exit code 0 must not.
 *
 *   bun exit-code.ts <code> <counterFile>
 */
import { appendFileSync } from "node:fs";

const [code = "70", counter = "exit-code.txt"] = process.argv.slice(2);
appendFileSync(counter, `${JSON.stringify({ at: Date.now(), pid: process.pid, code: Number(code) })}\n`);
await Bun.sleep(1000);
process.exit(Number(code));
