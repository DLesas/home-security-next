// Lint probe: a core module may not import "../../shell/loop.ts".
// Expect: no-restricted-imports "[core-import]"
import "../../shell/loop.ts";
