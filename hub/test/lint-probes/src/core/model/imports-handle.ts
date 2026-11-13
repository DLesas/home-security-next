// Lint probe: core/model may not import a module's handler.
// Expect: no-restricted-imports "[core-import]"
import "../alarm/handle.ts";
