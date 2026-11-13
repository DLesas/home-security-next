// Lint probe: ports may not import the shell.
// Expect: no-restricted-imports "[ports-import]"
import "../shell/loop.ts";
