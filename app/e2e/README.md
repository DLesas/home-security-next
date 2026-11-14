# `app/e2e/`: owner A9

M2, step 1 (docs/m2-design.md section 11). The browser tests and the "done when" (section 10), on step 0's harness (`support/harness.ts`: a real hub on a temporary data folder, the web build under the design's content security policy, built from the build's `csp.json`, axe). Any refusal under the policy, of a style as of a script, fails a test (section 5); Chrome was checked in step 0, WebKit and Firefox not yet. Tests are `*.e2e.ts`: `bun test` would run any `*.spec.ts`. `bun run app:e2e` exports and runs them; `HSN_E2E_BROWSERS` and `HSN_E2E_CHANNEL` choose browsers.

The harness is yours to extend.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A9` (the checks of `bun run check`, failing only for your folders).
