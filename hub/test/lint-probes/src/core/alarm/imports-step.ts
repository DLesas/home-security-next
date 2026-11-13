// Lint probe: a core module may not import "../step.ts".
// Expect: no-restricted-imports "[core-import]"
import "../step.ts";
