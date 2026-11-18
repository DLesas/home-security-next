/**
 * `node:util`'s `parseArgs` behind a result: an unknown option or a missing value is an error.
 */
import { parseArgs } from "node:util";
import { err, ok, type Result } from "neverthrow";
import type { PushError } from "../errors.ts";
import { errorFrom } from "./thrown.ts";

/** The push role's options: every one takes a value. */
export function parseOptions(
  args: readonly string[],
  names: readonly string[],
): Result<Readonly<Record<string, string | undefined>>, PushError> {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: Object.fromEntries(names.map((name) => [name, { type: "string" as const }])),
      strict: true,
      allowPositionals: false,
    });
    const out: Record<string, string | undefined> = {};
    for (const name of names) {
      const value: unknown = values[name];
      out[name] = typeof value === "string" ? value : undefined;
    }
    return ok(out);
  } catch (thrown) {
    // Only the code: the message quotes an unexpected argument, which could be a secret.
    return err(errorFrom("config", "push/safe/args", "read the command line", thrown, "codeOnly"));
  }
}
