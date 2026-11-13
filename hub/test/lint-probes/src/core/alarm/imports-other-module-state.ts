// Lint probe: a core module may not import "../sirens/state.ts".
// Expect: no-restricted-imports "[core-import]"
import "../sirens/state.ts";
