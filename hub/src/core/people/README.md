# `hub/src/core/people/`: owner A3

M2, step 1 (docs/m2-design.md section 11). People, clients and their public keys, permissions, the user-management switch, link tokens (128-bit and typed), invites, expiry, removal with what a client made and linked; the console token for `hsn open`.

Your slice (`state.ts`), handler, view and timers (`tokenExpiry`) are yours to fill in. Step 0's stub answers every operation `OP_OWNERS` gives you with `notBuilt`: replace it, one operation at a time. Your tables (`people_settings`, your single row, among them), rows and rules (`HubRules.people`) are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A3` (the checks of `bun run check`, failing only for your folders).
