/**
 * Bundling a page's script for a browser with Bun's own bundler, behind a result (rule 3): the
 * smoke page and the desk page are TypeScript that imports the bench's client and the protocol
 * package, built once when the bench starts.
 */
import { fault, ok, type Outcome } from "../outcome.ts";

export async function bundleForBrowser(entry: string): Promise<Outcome<string, "buildFailed">> {
  try {
    const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: false });
    const output = built.outputs[0];
    if (!built.success || output === undefined) return fault("buildFailed");
    return ok(await output.text());
  } catch {
    return fault("buildFailed");
  }
}
