# `hub/src/core/layout/`: owner A4

M2, step 1 (docs/m2-design.md section 11). Groups and modes, the fixed modes (made by migration 2) and the current mode; requests resolved to sensors (`armSensors`, `disarmSensors`); confirmations; `arm --all` and `disarm --all` as mode switches.

Your slice, handler and view are yours; your tables (`mode_state`, your single row, among them), `HubRules.layout` and the messages are frozen. The recorded lockstep sessions change by `mode_switched` only, regenerated with A10.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A4` (the checks of `bun run check`, failing only for your folders).
