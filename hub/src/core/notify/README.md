# `hub/src/core/notify/`: owner A6

M2, step 1 (docs/m2-design.md section 11). The notification table, recipients, categories, delivery to sessions, unread and delayed.

M3 and M4 (docs/m3-m4-plan.md, step 1) add: `relay_unreachable` (`hub`, to manage system and the console, never pushed: the relay module's `NEVER_PUSHED`); `firmware_store_damaged` (`hub`, critical, as `restore_waiting`); `presence_offer_away` and `presence_offer_disarm` (`armDisarm`, optional, to exactly the people their detail names, pushed by `relay` with their one action); `update_offered`, `firmware_release_offered`, `firmware_refused`, `firmware_rolled_back`, `firmware_reminder` and `rollout_paused` (`updates`, optional, to manage system whatever device they name; a pause only when the hub made it and no refusal, rollback or damaged-store notice of its own tells it, `table.ts`'s `pauseTold`); `group_sirens_gone` (D144) raises nothing: it is a history record only; and version 2's `happenedAtMs` (D102), given beside version 1's object, never in it: on `notificationRaised`, and for the snapshot and `notifications.list` through `view.ts`'s `asVersion2` and `happenedAtFor`, which `app` uses on a version 2 session only.

Your slice and handler are yours; `notifications`, `notification_reads`, the categories (`@hsn/protocol/app`) and `HubRules.notify` are frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A6` (the checks of `bun run check`, failing only for your folders).
