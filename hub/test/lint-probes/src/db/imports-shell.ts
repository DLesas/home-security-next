// Lint probe: db/ may not import the shell.
// Expect: no-restricted-imports "[db-import]"
import "../shell/loop.ts";
