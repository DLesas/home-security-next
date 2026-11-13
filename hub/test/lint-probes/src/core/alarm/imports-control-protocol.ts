// Lint probe: a core module may not import "../../control-protocol/index.ts".
// Expect: no-restricted-imports "[core-import]"
import "../../control-protocol/index.ts";
