# `hub/src/core/upkeep/`: owner A8

M2, step 1 (docs/m2-design.md section 11). The core's side of backups, restore and updates (sections 2 and 9): backup settings, whether a backup is due and since when, the backup key and its epoch, a restore in progress, the update state; the operations `backup.*`, `restore.start` and `update.*` (`OP_OWNERS`); `fileJob` effects, its decisions, its rows.

Your slice and handler are yours; the module's place (19th, after `notify`, before `audit`), its timer keys, `backup_state`, `backup_key`, `update_state`, `HubRules.backups` and `HubRules.restore`, and its decisions (`restored`, `update_*`, `backup_overdue`, `backup_key_replaced`, `backup_folder_on_data_disk`) and hub events (`backup_written`, `backup_failed`) are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A8` (the checks of `bun run check`, failing only for your folders).
