// Lint probe: the CLI may not import "node:fs".
// Expect: no-restricted-imports "[cli-import]"
import "node:fs";
