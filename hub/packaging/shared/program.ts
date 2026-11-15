#!/usr/bin/env bun
/**
 * The program of one version (m2-design.md section 9, "The program"): one Bun executable holding
 * the hub and `hsn`, compiled from this file (`build-program.ts`). `hsn-hub --data <folder> …` runs
 * the hub, as the launcher starts it; `hsn-hub cli <words>…` runs `hsn`, which the installed `hsn`
 * command (a small script naming the data folder) calls.
 */
import { runCli } from "../../cli/main.ts";
import { parseMainArgs, runHub } from "../../src/shell/main.ts";
import { parseInstallerPageArgs, writeInstallerPage } from "./installer-page.ts";

/** Which of the two a command line asks for. */
export function programRole(argv: readonly string[]): "cli" | "installerPage" | "hub" {
  if (argv[0] === "cli") return "cli";
  if (argv[0] === "installer-page") return "installerPage";
  return "hub";
}

/** The Windows installer's page (`installer-page.ts`): prints the page's path, no secret. */
async function installerPage(argv: readonly string[]): Promise<number> {
  const page = parseInstallerPageArgs(argv);
  if (typeof page === "string") {
    process.stderr.write(`installer-page: ${page}\n`);
    return 2;
  }
  const written = await writeInstallerPage(page);
  if (written.isErr()) {
    process.stderr.write(`installer-page: ${written.error}\n`);
    return 1;
  }
  process.stdout.write(`${written.value}\n`);
  return 0;
}

async function cli(argv: readonly string[]): Promise<number> {
  return runCli(argv, {
    out: (line) => {
      process.stdout.write(`${line}\n`);
    },
    err: (line) => {
      process.stderr.write(`${line}\n`);
    },
    env: process.env,
    stdin: () => Bun.stdin.text(),
    nowMs: () => Date.now(),
    onInterrupt: (end) => {
      process.once("SIGINT", end);
    },
    ask: (question) => {
      process.stdout.write(question);
      return new Promise((resolve) => {
        process.stdin.once("data", (data) => {
          process.stdin.pause();
          resolve(data.toString());
        });
      });
    },
  });
}

async function hub(argv: readonly string[]): Promise<number> {
  const options = parseMainArgs(argv, process.env);
  if (typeof options === "string") {
    process.stderr.write(`hub: ${options}\n`);
    return 2;
  }
  return runHub(options);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const role = programRole(argv);
  process.exit(
    role === "cli"
      ? await cli(argv.slice(1))
      : role === "installerPage"
        ? await installerPage(argv.slice(1))
        : await hub(argv),
  );
}
