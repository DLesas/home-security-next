# `hub/src/shell/backup/`: owner A8

M2, step 1 (docs/m2-design.md section 11). Backup and export, restore (section 9).

The `fileJob` effect, `FileWork` with `UploadRef`, `fileReady` and `FileOutcome`, `restoreOpened` and `restoreKey`, `backup_state` and `backup_key`, and the backup format's interface are frozen. In the core, backups, restore and updates are `upkeep`'s (`hub/src/core/upkeep/`, yours too); the shell performs its file jobs.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A8` (the checks of `bun run check`, failing only for your folders).
