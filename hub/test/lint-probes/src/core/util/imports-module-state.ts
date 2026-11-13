// Lint probe: core/util may not import a module's state.
// Expect: no-restricted-imports "[core-import]"
import "../alarm/state.ts";
