# `hub/launcher/`: owner A8

M2, step 1 (docs/m2-design.md section 11). The launcher and its rollback (section 9): restarts on any exit but 0, the backoff of `LAUNCHER` in `hub/src/shell/m2-values.ts`.

The values are frozen there. It runs as the hub's account, from the package's root-owned tree: `hsn-launcher --package <tree> --program <the hub's program tree> --data <folder>` (no `--select`: section 9, "The privilege boundary"). It runs the newest packaged version not marked failed, a newer one on trial as after a switch; a version the hub staged runs only after the hub's own switch to it; its rollback puts back only a whole copy (`copies.ts`).

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A8` (the checks of `bun run check`, failing only for your folders).
