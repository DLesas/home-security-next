# `hub/src/shell/calendar/`: owner A5

M2, step 1 (docs/m2-design.md section 11). The `Calendar` dependency over the Temporal polyfill, with its tests. `unbuilt.ts` is step 0's stand-in (no entry is ever due): replace it, and pass yours wherever `UNBUILT_CALENDAR` is passed today.

The `Calendar` interface (`hub/src/core/model/calendar.ts`) is frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A5` (the checks of `bun run check`, failing only for your folders).
