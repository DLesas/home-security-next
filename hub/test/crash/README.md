# `hub/test/crash/`: owner A9

M2, step 1 (docs/m2-design.md section 11). M2's crash points (section 10).

The crash harness is as built.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A9` (the checks of `bun run check`, failing only for your folders).

**Files.** `crash.test.ts` and `harness.ts`: M1a's points over a day of home A. `kill.test.ts`: a real hub killed with `kill -9`. `m2.test.ts`: M2's points (an app request, a schedule run, a link, a client's removal, a settings change with its backup at every point of section 4's table; a backup and a staging cut off at every piece; restore's switch cut off between its steps, a `test.failing` until the FAULT-A8 it shows is fixed).

**Firmware updates and the key change** (m3-updates-design.md sections 6 to 8): `firmware.test.ts`, on the whole hub of `test/scenarios/sensors/whole/support.ts`: a cut at each point around the grant, the go-ahead, a siren's and a gateway's key change commits (a sensor's are in `cuts.test.ts` there), the restore's marking (cut at every piece), and staging (a stored file whose row was lost).
