// Lint probe: a core module may not import "node:fs".
// Expect: no-restricted-imports "[core-import]"
import "node:fs";
