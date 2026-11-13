// Lint probe: a core module may not import "../../ports/index.ts".
// Expect: no-restricted-imports "[core-import]"
import "../../ports/index.ts";
