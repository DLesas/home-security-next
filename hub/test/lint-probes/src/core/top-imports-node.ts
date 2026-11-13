// Lint probe: core/step.ts may not import node modules.
// Expect: no-restricted-imports "[core-import]"
import "node:fs";
