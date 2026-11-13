// Lint probe: db/ may not import the core.
// Expect: no-restricted-imports "[db-import]"
import "../core/model/index.ts";
