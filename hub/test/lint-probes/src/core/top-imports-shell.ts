// Lint probe: core/step.ts may not import the shell.
// Expect: no-restricted-imports "[core-import]"
import "../shell/loop.ts";
