# `app/e2e/`: owner A9

M2's browser tests and the "done when" (docs/m2-design.md section 10, "The app"), against a real hub (`hub/src/shell/main.ts`) on a temporary data folder that serves the exported web build itself on its console listener (`http://127.0.0.1:<port>`, the channel at `ws://…/app`) and its apps' listener (HTTPS, the hub's own certificate). Tests are `*.e2e.ts`: `bun test` would run any `*.spec.ts`.

- `done-when.e2e.ts`: the whole flow, one serial test per step: the console's first link, setup (name, the gateway added on its own when plugged in, the survey, the rate, the Wi-Fi, the countdown, the sensor and the siren over USB), a group and a mode, Away with a disarm in the countdown, the mode with the alarm and the siren sounding, the history, a schedule entry, a second browser linked by a typed code and removed, the hub's records and a clean stop; no refusal under the content security policy; axe on every screen it passed through.
- `routes.e2e.ts`: every route loads from the hub, with axe.
- `harness.e2e.ts`: step 0's checks of the harness.
- `support/harness.ts`: the hub on free ports, its control socket (`consoleToken`, `log`), the clean stop; with boards, `support/bench.ts`.
- `support/bench.ts` (Bun): the scripted gateway, sensor and siren of `hub/test/world/` on pseudo-terminals, plugged in by making their `--serial` path appear, and a real-time air between them.
- A fault found in someone else's code is a `test.fail` naming the file: it passes while the fault is there and fails once it is fixed, to be removed then.

Run: `bun run app:export`, then `cd app && HSN_E2E_CHANNEL=chrome node node_modules/@playwright/test/cli.js test --config e2e/playwright.config.ts` (`bun run app:e2e` does both, in Playwright's own Chromium). `HSN_E2E_BROWSERS` lists other browsers; `HSN_E2E_HUB_LOG=1` shows the hub's standard error. `HSN_E2E_BREAK=<name>[,<name>]` breaks one thing at run time to show a test fails: `siren-deaf`, `gateway-no-forward`, `noise-flat` (the bench), `csp-style`, `axe-image` (the browser).

With boards the hub watches USB ports as it does in use: besides the bench's folder it opens any Espressif board on this computer's `/dev`, so unplug real boards first.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A9`.
