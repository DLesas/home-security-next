/**
 * Every `try` of the bench lives in this folder (docs/m3-m4-plan.md, rule 3): `JSON.parse`, which
 * throws on text that is not JSON, behind a result.
 */
import { fault, ok, type Outcome } from "../outcome.ts";

export function parseJson(text: string): Outcome<unknown, "notJson"> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch {
    return fault("notJson");
  }
}
