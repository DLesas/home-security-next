// Lint probe: a core module may not import "zod".
// Expect: no-restricted-imports "[core-import]"
import "zod";
