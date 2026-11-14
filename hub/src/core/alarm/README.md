# `hub/src/core/alarm/`: owner A4

M2, step 1 (docs/m2-design.md section 11). As built in M1a (HD 8); A4 adds the sirens of each trigger's groups and acts on `armSensors` and `disarmSensors`.

Its behaviour for M1a's commands must stay as the recorded sessions prove it.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A4` (the checks of `bun run check`, failing only for your folders).
