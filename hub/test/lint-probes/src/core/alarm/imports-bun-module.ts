// Lint probe: a core module may not import "bun:sqlite".
// Expect: no-restricted-imports "[core-import]"
import "bun:sqlite";
