// Lint probe: the shell may import anything.
// Expect: clean
import "node:fs";
import "bun:sqlite";
import "zod";
import "../core/alarm/state.ts";
export const now = (): number => Date.now();
