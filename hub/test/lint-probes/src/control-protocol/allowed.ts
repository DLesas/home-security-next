// Lint probe: control-protocol/ may import zod.
// Expect: clean
import "zod";
import "./values.ts";
