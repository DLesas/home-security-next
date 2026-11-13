// Lint probe: ports may not import node modules.
// Expect: no-restricted-imports "[ports-import]"
import "node:fs";
