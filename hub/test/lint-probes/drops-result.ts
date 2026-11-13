// Lint probe: a dropped Result.
// Expect: hsn/must-use-result "Result is dropped"
import { ok } from "neverthrow";

ok(1);
