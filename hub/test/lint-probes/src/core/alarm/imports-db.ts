// Lint probe: a core module may not import "../../db/schema.ts".
// Expect: no-restricted-imports "[core-import]"
import "../../db/schema.ts";
