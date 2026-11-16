/**
 * A rough reader of PowerShell's quoting and brackets, for the tests only (nothing on the
 * development Mac can parse PowerShell): strings ("…" with backtick escapes, "" and $( … ) inside;
 * '…' with ''), here-strings (@" … "@ and @' … '@ on lines of their own), comments (# to the end
 * of the line, <# … #>), and the brackets ( ) { } [ ] in code. It answers where a file is left
 * unbalanced, or undefined. It is no parser: it catches the slips a careful read would, such as a
 * string's missing closing quote, which turns the rest of the file inside out.
 */
type Mode = "code" | "dq" | "sq";

export function unbalanced(text: string): string | undefined {
  const stack: { readonly mode: Mode; readonly close: string; readonly line: number }[] = [];
  let mode: Mode = "code";
  const lines = text.split("\n");
  for (let n = 0; n < lines.length; n++) {
    let row = lines[n] ?? "";
    const line = n + 1;
    // A here-string's opening ends its line; its body runs to a line starting with its close.
    if (mode === "code") {
      const here = /@(["'])\s*$/u.exec(row.replace(/\s#.*$/u, ""));
      if (here !== null && !/^\s*#/u.test(row)) {
        const close = `${here[1] ?? ""}@`;
        let end = n + 1;
        while (end < lines.length && !(lines[end] ?? "").startsWith(close)) end++;
        if (end >= lines.length) return `line ${line}: a here-string is never closed`;
        row = `${row.slice(0, here.index)}''${(lines[end] ?? "").slice(close.length)}`;
        n = end;
      }
    }
    for (let i = 0; i < row.length; i++) {
      const c = row[i] ?? "";
      const next = row[i + 1] ?? "";
      if (mode === "code") {
        if (c === "#") break;
        if (c === "<" && next === "#") {
          // A block comment, maybe over lines.
          let rest = row.slice(i + 2);
          while (!rest.includes("#>")) {
            n++;
            if (n >= lines.length) return `line ${line}: a block comment is never closed`;
            rest = lines[n] ?? "";
          }
          row = rest.slice(rest.indexOf("#>") + 2);
          i = -1;
          continue;
        }
        if (c === "`") {
          i++;
          continue;
        }
        if (c === '"') {
          stack.push({ mode, close: '"', line });
          mode = "dq";
        } else if (c === "'") {
          stack.push({ mode, close: "'", line });
          mode = "sq";
        } else if (c === "(" || c === "{" || c === "[") {
          stack.push({ mode, close: c === "(" ? ")" : c === "{" ? "}" : "]", line });
        } else if (c === ")" || c === "}" || c === "]") {
          const top = stack.pop();
          if (top?.close !== c)
            return `line ${line}: "${c}" closes ${top === undefined ? "nothing" : `"${top.close}" from line ${top.line}`}`;
          mode = top.mode;
        }
      } else if (mode === "dq") {
        if (c === "`") i++;
        else if (c === '"' && next === '"') i++;
        else if (c === "$" && next === "(") {
          stack.push({ mode, close: ")", line });
          mode = "code";
          i++;
        } else if (c === "$" && /[A-Za-z_]/u.test(next)) {
          // `$name:` in a string is a scope-qualified variable: PowerShell refuses the file unless
          // the scope is one of its own (`$env:`, `$script:`, ...); `${name}:` is the way to write it.
          const name = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(row.slice(i + 1))?.[0] ?? "";
          const after = row[i + 1 + name.length] ?? "";
          const scope = /^(env|script|global|local|private|using|function|variable)$/iu.test(name);
          if (after === ":" && !scope && !/[A-Za-z0-9_]/u.test(row[i + 2 + name.length] ?? ""))
            return `line ${line}: "$${name}:" is not a variable; write "\${${name}}:"`;
          i += name.length;
        } else if (c === "$" && next === "{") {
          const end = row.indexOf("}", i);
          if (end < 0) return `line ${line}: \${ never closed`;
          i = end;
        } else if (c === '"') {
          const top = stack.pop();
          mode = top?.mode ?? "code";
        }
      } else if (c === "'" && next === "'") {
        i++;
      } else if (c === "'") {
        const top = stack.pop();
        mode = top?.mode ?? "code";
      }
    }
  }
  const open = stack.at(-1);
  if (open !== undefined) return `line ${open.line}: "${open.close}" is never closed`;
  return undefined;
}
