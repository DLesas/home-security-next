// Lint probe: ports may not import a core module.
// Expect: no-restricted-imports "[ports-import]"
import "../core/alarm/state.ts";
