# `hub/cli/`: owner A2

M2, step 1 (docs/m2-design.md section 11). The `hsn` tool (HD 9). Step 0 added `hsn op <operation> [<json> | -]`, `hsn open` (which asks for the console token over the control socket), and the commands that carry a file, `hsn update install`, `hsn restore` and `hsn backup export` (`files.ts`, over one connection with `fileChunk` requests and lines, section 6); A2 makes `hsn open` open the browser. Until A2's upload store exists the shell answers every chunk `notBuilt` (`hub/src/shell/control/file-chunks.ts`).

The command and reply schemas are `hub/src/control-protocol/`'s, frozen.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A2` (the checks of `bun run check`, failing only for your folders).
