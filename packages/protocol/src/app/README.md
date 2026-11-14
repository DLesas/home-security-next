# `packages/protocol/src/app/`: owner A1

M2, step 1 (docs/m2-design.md section 11). The app channel, version 1 (sections 5 and 6). The files step 0 wrote here are frozen: every type and schema in them. **A1 adds new files beside them**: `noise.ts` and `backup.ts`, which implement `noise-interface.ts` and `backup-interface.ts`, their tests, the vectors `packages/protocol/vectors/app-*.json` (whose formats `vector-formats.ts` freezes), and two export lines in `index.ts`; A1 changes no other frozen file (section 11, "The four readings of ownership").

Steps: the Noise state machine for both patterns against the published vectors, the static key's Diffie-Hellman as a function, the all-zero check; our vectors for every handshake (section 10); the backup format and its vectors; the browser's Web Crypto path as K1 decides. The interfaces they implement change only through the step 0 owner.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A1` (the checks of `bun run check`, failing only for your folders).
