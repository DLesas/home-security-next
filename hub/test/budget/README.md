# `hub/test/budget/`: owner A9

M2, step 1 (docs/m2-design.md section 11). Home C and M2's traffic in the write budget (section 10).

The budget's limits are HD 5's and m2-design section 3's.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A9` (the checks of `bun run check`, failing only for your folders).

**Files.** `budget.test.ts`: the days of homes A, B and C, with and without M2's household, against the limits (work only: commits, frames, rows; no wall time). `day.ts`: the day's script. `household.ts`: M2's household (4 people, 6 browsers, the console), its sessions, and two stand-ins `test/world/home.ts` lacks (the real calendar, the backup job), each reported as a FROZEN-CHANGE. `run.ts`: the measurement and the projection at D57's retention. `loop-limit.test.ts`: a real hub process taking door reports from a scripted gateway while it writes a backup and two exports, started over the control socket as `hsn` starts them; the order of its records shows the reports taken between the backup's pieces (the 50 ms wait asserted only with `HSN_TIMING=1`).

**The rollout day** (m3-updates-design.md section 4, "Durability") is `firmware/tests/system_roles/update_budget_test.cpp`: home C with the firmware's real roles through the lockstep hub, whose writer's figures the lockstep hub writes at its clean stop, since this folder's world has no device that takes an update.
