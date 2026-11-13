// Lint probe: a core module may not import "../model/../sirens/state.ts".
// Expect: no-restricted-imports "[core-import]"
import "../model/../sirens/state.ts";
