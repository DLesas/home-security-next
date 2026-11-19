/**
 * The source half of "the release bundle holds no bridge" (m3-design.md section 9; the bridge's
 * client, `bridge/client.ts`, says why and how). A release bundle folds `__DEV__` to `false`
 * before Metro collects modules, so a module required only inside `if (__DEV__) { … }` is never
 * collected; a module imported any other way always is. So every mention of the bench under
 * `app/src` must be a `require(…)` whose nearest enclosing block is an `if (__DEV__ …)`'s.
 * Refused: a static `import`/`export … from`, a dynamic `import(…)` (Metro still collects it), a
 * `require` outside such a block, or under a negated or otherwise different condition.
 *
 * `app/e2e-native/release-check.ts` is the bundle half: it builds the release bundles and looks
 * for the wire's version in them.
 */

/** Where in a file a mention of the bench breaks the rule, and why. */
export interface GuardProblem {
  readonly line: number;
  readonly why: string;
}

const MENTION = /ble-bench/gu;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The index of the `{` of the innermost block open at `index`, or -1. */
function enclosingBrace(text: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

/**
 * The file with its comments blanked (to spaces, lines kept), so a comment that names the bench
 * is not a mention. Strings and template literals are kept as they are.
 */
export function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
        } else {
          out += text[i] ?? "";
          i += 1;
        }
      }
      if (i < text.length) {
        out += ch;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Every way `source` (one file) breaks the rule; empty when it keeps it. */
export function guardProblems(source: string): readonly GuardProblem[] {
  const text = withoutComments(source);
  const problems: GuardProblem[] = [];
  for (const match of text.matchAll(MENTION)) {
    const at = match.index;
    const line = lineOf(text, at);
    const start = text.lastIndexOf("\n", at) + 1;
    const before = text.slice(Math.max(0, at - 200), at);
    const statement = text.slice(start, at);
    if (/\bimport\s*\(\s*["'`][^"'`]*$/u.test(before)) {
      problems.push({ line, why: "a dynamic import is still collected into the bundle" });
      continue;
    }
    if (
      /\b(?:import|export)\b[^;]*\bfrom\s*["'`][^"'`]*$/u.test(before) ||
      /^\s*import\s*["'`]/u.test(statement)
    ) {
      problems.push({
        line,
        why: "a static import is always collected: require it inside if (__DEV__)",
      });
      continue;
    }
    if (!/\brequire\s*\(\s*["'`][^"'`]*$/u.test(before)) {
      problems.push({ line, why: "only a require of it may name the bench" });
      continue;
    }
    const brace = enclosingBrace(text, at);
    const head = brace < 0 ? "" : text.slice(Math.max(0, brace - 200), brace);
    if (!/\bif\s*\(\s*__DEV__\b[^()]*\)\s*$/u.test(head)) {
      problems.push({ line, why: "the require must sit directly in an if (__DEV__ …) block" });
    }
  }
  return problems;
}
