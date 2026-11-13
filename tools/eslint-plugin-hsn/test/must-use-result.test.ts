/**
 * `hsn/must-use-result` under typescript-eslint's rule tester, with the real neverthrow types
 * and the protocol package's `Result` (hub-design.md section 10): valid and invalid cases for
 * every form the rule flags or leaves alone.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuleTester } from "@typescript-eslint/rule-tester";
import { mustUseResult } from "../src/rules/must-use-result.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

describe("its documentation", () => {
  it("is a path inside this repository, to the section that specifies it", () => {
    const url = mustUseResult.meta.docs?.url;
    expect(url).toBe("docs/hub-design.md#the-rule-that-every-result-is-used");
    const design = readFileSync(
      join(import.meta.dir, "..", "..", "..", "docs", "hub-design.md"),
      "utf8",
    );
    expect(design).toContain("### The rule that every result is used");
  });
});

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: "./tsconfig.json",
      tsconfigRootDir: join(import.meta.dir, "fixtures"),
    },
  },
});

const imports = `
import { ok, err, Result as NeverthrowResult } from "neverthrow";
import { save, saveLater, saveAsync, maybeSave, decode, store, optionalStore, log } from "./results.ts";
import { notNeverthrow } from "./local.ts";
`;

/** A case's code, after the imports every case shares. */
const code = (body: string): string => `${imports}\n${body}\n`;
const invalid = (body: string, errors = 1) => ({
  code: code(body),
  filename: "file.ts",
  errors: Array.from({ length: errors }, () => ({ messageId: "unused" as const })),
});
const valid = (body: string) => ({ code: code(body), filename: "file.ts" });

ruleTester.run("must-use-result", mustUseResult, {
  valid: [
    // Returned, assigned, declared.
    valid("export function f() { return save(1); }"),
    valid("export const r = save(1);"),
    valid("let r = save(1); r = save(2); export { r };"),
    valid("export async function f() { const r = await saveAsync(1); return r; }"),
    // Passed as an argument, put in a literal.
    valid("export const all = NeverthrowResult.combine([save(1), save(2)]);"),
    valid("export const box = { first: save(1) };"),
    valid("export const list = [save(1)];"),
    valid("log(save(1).isOk() ? 1 : 0);"),
    // Used in a condition.
    valid("if (save(1).isOk()) log(1);"),
    valid("export const n = save(1).isErr() ? 0 : 1;"),
    // Consumed by a method call.
    valid("save(1).match((v) => log(v), () => log(0));"),
    valid("export const n = save(1).unwrapOr(0);"),
    valid("decode(new Uint8Array()).ok;"),
    // A concise arrow body whose context wants a value.
    valid("export const results = [1, 2].map((i) => save(i));"),
    valid("export const later = (): NeverthrowResult<number, string> => save(1);"),
    // Not results: other calls, a class of the same name from elsewhere.
    valid("log(1);"),
    valid("notNeverthrow();"),
    valid("void log(1);"),
    valid("[1, 2].forEach((i) => log(i));"),
    valid("export const n = (log(1), save(2));"),
    // Results made with ok and err and then used.
    valid("export const pair = [ok(1), err('no')] as const;"),
  ],
  invalid: [
    // An expression statement: a call, a method that returns a new Result, `await x;`.
    invalid("save(1);"),
    invalid("ok(1);"),
    invalid("err('no');"),
    invalid("save(1).map((v) => v + 1);"),
    invalid("saveLater(1);"),
    invalid("saveAsync(1);"),
    invalid("export async function f() { await saveAsync(1); }"),
    invalid("export async function f() { await saveLater(1); }"),
    invalid("store.nested.save(1);"),
    // The protocol package's Result.
    invalid("decode(new Uint8Array());"),
    // A union containing a Result.
    invalid("maybeSave(1);"),
    // An optional call statement.
    invalid("optionalStore.save?.(1);"),
    // The operand of void, wherever it is.
    invalid("void save(1);"),
    invalid("export const u = void saveAsync(1);"),
    // Any but the last operand of a comma expression.
    invalid("export const n = (save(1), log(2));"),
    invalid("log((save(1), save(2), 3));", 2),
    // A concise arrow body whose contextual return type is void.
    invalid("[1, 2].forEach((i) => save(i));"),
    invalid("export const run = (f: () => void) => f(); run(() => save(1));"),
    // Inside a block, as elsewhere.
    invalid("export function f() { if (log(1) > 0) { save(1); } }"),
    invalid("[1, 2].forEach((i) => { save(i); });"),
    invalid("export const r = log(1) > 0 ? save(1) : save(2); log(1) > 0 ? save(1) : save(2);"),
  ],
});
