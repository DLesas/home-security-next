# `hub/src/core/notify/`: owner A6

M2, step 1 (docs/m2-design.md section 11). The notification table, recipients, categories, delivery to sessions, unread and delayed.

Your slice and handler are yours; `notifications`, `notification_reads`, the categories (`@hsn/protocol/app`) and `HubRules.notify` are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A6` (the checks of `bun run check`, failing only for your folders).
