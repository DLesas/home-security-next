// Lint probe: the CLI may not import "../src/shell/loop.ts".
// Expect: no-restricted-imports "[cli-import]"
import "../src/shell/loop.ts";
