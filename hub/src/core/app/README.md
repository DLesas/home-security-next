# `hub/src/core/app/`: owner A3

M2, step 1 (docs/m2-design.md section 11). App sessions, subscriptions, the live revision; request routing to the owners (`OP_OWNERS`, `opRequest`, `opAnswer`), permission checks, `seq` with stored replies; snapshot, events checked when made, `forget`.

`history.query` is yours too: you check the person and compute what they may see, then give the shell a `historyRead` effect with the query and that `HistoryFilter` (section 6). M1a's modules are reached with their own request messages, numbered from `APP_REQUEST_BASE` (2⁴⁰, section 2); `fileChunk` is the shell's.

Your slice and handler are yours; the messages they exchange are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A3` (the checks of `bun run check`, failing only for your folders).
