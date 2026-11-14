#!/usr/bin/env bun
/**
 * The spikes' table: reads the JSON lines of W2 and W3 and prints a Markdown table, for the
 * job summary and the READMEs' results sections.
 *
 *   bun summary.ts results/w2.jsonl results/w3.jsonl >> "$GITHUB_STEP_SUMMARY"
 */
import { existsSync, readFileSync } from "node:fs";

const MARK: Record<string, string> = { pass: "✅ pass", fail: "❌ fail", skip: "⏭ skip", inconclusive: "❔ inconclusive" };

function cell(value: unknown, max = 300): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const short = text.length > max ? `${text.slice(0, max)}…` : text;
  return short.replaceAll("|", "\\|").replaceAll("\n", " ");
}

const out: string[] = ["# Windows spikes W2 and W3", ""];
for (const file of process.argv.slice(2)) {
  out.push(`## ${file}`, "");
  if (!existsSync(file)) {
    out.push("_No results: the script did not run or wrote nothing._", "");
    continue;
  }
  out.push("| Test | Result | Expected | Observed |", "| --- | --- | --- | --- |");
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const line = JSON.parse(raw) as { test: string; result: string; expected?: string; observed: unknown };
      out.push(
        `| ${cell(line.test, 160)} | ${MARK[line.result] ?? line.result} | ${line.expected ?? ""} | ${cell(line.observed)} |`,
      );
    } catch {
      out.push(`| (not JSON) | | | ${cell(raw)} |`);
    }
  }
  out.push("");
}
out.push(
  "A **fail** with **expected fail** is the design's expectation (a named pipe made by `node:net` is open to every user). The full observations are in the job's artifact.",
);
console.log(out.join("\n"));
