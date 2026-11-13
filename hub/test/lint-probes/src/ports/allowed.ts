// Lint probe: ports may import core/model, their own files and neverthrow's types.
// Expect: clean
import "../core/model/index.ts";
import "./clock.ts";
export type { Result } from "neverthrow";
