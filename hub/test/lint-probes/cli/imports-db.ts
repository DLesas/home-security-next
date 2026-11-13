// Lint probe: the CLI may not import "../src/db/schema.ts".
// Expect: no-restricted-imports "[cli-import]"
import "../src/db/schema.ts";
