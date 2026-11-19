# `hub/src/core/layout/`: owner A4

M2, step 1 (docs/m2-design.md section 11). Groups and modes, the fixed modes (made by migration 2) and the current mode; requests resolved to sensors (`armSensors`, `disarmSensors`); confirmations; `arm --all` and `disarm --all` as mode switches.

D144 (`gone.ts`, added by A6 at the coordinator's request): a siren removed or reset by its owner that leaves groups which chose sirens with none of their own in use is recorded, `group_sirens_gone`, once per occurrence as it arises in a step (the slice's memory-only `sirensGone`), with the client that asked: a history record only, which nobody is notified of (the person who causes it is told by the app's dialog). A start rebuilds `sirensGone` and records nothing.

Your slice, handler and view are yours; your tables (`mode_state`, your single row, among them), `HubRules.layout` and the messages are frozen. The recorded lockstep sessions change by `mode_switched` only, regenerated with A10.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A4` (the checks of `bun run check`, failing only for your folders).
