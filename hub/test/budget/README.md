# `hub/test/budget/`: owner A9

M2, step 1 (docs/m2-design.md section 11). Home C and M2's traffic in the write budget (section 10).

The budget's limits are HD 5's and m2-design section 3's.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A9` (the checks of `bun run check`, failing only for your folders).
