# `app/`: owner A7

M2, step 1 (docs/m2-design.md section 11). The app (section 8): the channel client (`src/hub/`), the store (`src/state/`), the screens (`src/app/`, stubbed), components (`src/ui/`), per-platform code (`src/platform/`), every text in `locales/en/`. Not `e2e/`, which is A9's.

Expo 58.0.25 is pinned with its matching packages; `@hsn/protocol/app` is frozen. NativeWind is not set up yet: its version and configuration are yours. Every text goes through `t("key")`; the lint rule `hsn/no-literal-text` refuses text in components, and `test/i18n.test.ts` that a key lacks English text. `bun run app:export` builds the web app; its last step, `scripts/csp.ts`, writes the hashes of `index.html`'s inline styles and scripts to `dist/csp.json`, from which the hub's listeners and the browser tests build the content security policy (`contentSecurityPolicy` in `@hsn/protocol/app`, section 5). An inline style or script added to the page is covered by the next build's hashes; one inserted at run time with content is refused, and fails the browser tests.

**Frozen for you** (m2-design.md section 11: changed only through the step 0 owner): `hub/src/core/model/` (events, effects, messages, decisions, rows, store operations, rules, the module order, `Calendar`, `OP_OWNERS`), `hub/src/core/step.ts`, `hub/src/db/schema.ts` and `hub/drizzle/`, `hub/src/control-protocol/`, the ports in `hub/src/ports/`, and the types and schemas of `packages/protocol/src/app/`. Ask for a change there; do not make it.

Check your work with `bun run check:own A7` (the checks of `bun run check`, failing only for your folders).
