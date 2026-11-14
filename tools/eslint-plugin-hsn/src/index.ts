/** The repository's own ESLint rules, registered as `hsn/<rule>` (hub-design.md section 10). */
import type { TSESLint } from "@typescript-eslint/utils";
import { mustUseResult } from "./rules/must-use-result.ts";
import { noLiteralText } from "./rules/no-literal-text.ts";

const plugin = {
  meta: { name: "eslint-plugin-hsn", version: "0.1.0" },
  rules: { "must-use-result": mustUseResult, "no-literal-text": noLiteralText },
} satisfies TSESLint.FlatConfig.Plugin;

export default plugin;
