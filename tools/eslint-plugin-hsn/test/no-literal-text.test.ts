/**
 * `hsn/no-literal-text` under typescript-eslint's rule tester (m2-design.md section 8): text in
 * JSX and in the props people read is refused; keys, whitespace and other props are not.
 */
import { afterAll, describe, it } from "bun:test";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { noLiteralText } from "../src/rules/no-literal-text.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
// No `RuleTester.itOnly`: reading `it.only` throws under `CI` (Bun), and no case is `only`.

const ruleTester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
});

const t = "declare function t(key: string): string;\nconst Text = (p: object) => p;\n";
const valid = (body: string) => ({ code: `${t}${body}`, filename: "screen.tsx" });
const invalid = (body: string, errors = 1) => ({
  code: `${t}${body}`,
  filename: "screen.tsx",
  errors: Array.from({ length: errors }, () => ({ messageId: "literal" as const })),
});

ruleTester.run("no-literal-text", noLiteralText, {
  valid: [
    valid('export const a = <Text>{t("home.title")}</Text>;'),
    valid('export const a = <Text> {t("x")} </Text>;'),
    valid('export const a = <Text>{" — "}</Text>;'),
    valid('export const a = <Text testID="home-title" role="heading">{t("x")}</Text>;'),
    valid('export const a = <Text accessibilityLabel={t("x")}>{t("y")}</Text>;'),
    valid("export const a = <Text>{42}</Text>;"),
  ],
  invalid: [
    invalid("export const a = <Text>Armed</Text>;"),
    invalid('export const a = <Text>{"Armed"}</Text>;'),
    invalid("export const a = <Text>{`Armed ${1}`}</Text>;"),
    invalid('export const a = <Text title="Away">{t("x")}</Text>;'),
    invalid('export const a = <Text accessibilityLabel={"Disarm"}>{t("x")}</Text>;'),
    invalid('export const a = <Text placeholder="Name">Wohnzimmer</Text>;', 2),
  ],
});
