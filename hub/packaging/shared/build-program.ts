#!/usr/bin/env bun
/**
 * `bun hub/packaging/shared/build-program.ts --target <bun target> --out <folder>`: one version's
 * program and the launcher, laid out as every package installs them (m2-design.md section 9):
 *
 * ```
 * <out>/versions/<version>/bin/hsn-hub[.exe]   the hub and `hsn` (`program.ts`), compiled by Bun
 * <out>/versions/<version>/drizzle/            the migrations
 * <out>/versions/<version>/web/                the web app's export (`bun run app:export`), with csp.json
 * <out>/launcher/hsn-launcher[.exe]            the launcher, compiled apart
 * <out>/version                                the version, for the package scripts
 * ```
 *
 * Run on a machine of the target's own system (each package's build says which): Bun compiles
 * for another system only by fetching that system's runtime, which these builds do not do here.
 * Prints the version on success; exits 1 with the reason otherwise.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, Result } from "neverthrow";
import { PUBLISHER_KEYS, releaseKeysProblem } from "../../src/shell/update/publisher-keys.ts";

const HUB = join(import.meta.dir, "..", "..");
const REPO = join(HUB, "..");

export const TARGETS = [
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-windows-x64",
] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(text: string): text is Target {
  return (TARGETS as readonly string[]).includes(text);
}

/** The hub's version, from its package (the folder name the launcher switches between). */
export function hubVersion(): string {
  const parsed = Result.fromThrowable(
    () => JSON.parse(readFileSync(join(HUB, "package.json"), "utf8")) as { version?: unknown },
    () => undefined,
  )();
  const version = parsed.isOk() ? parsed.value.version : undefined;
  return typeof version === "string" ? version : "0.0.0";
}

function exe(target: Target, name: string): string {
  return target === "bun-windows-x64" ? `${name}.exe` : name;
}

function compile(target: Target, entry: string, outfile: string): string | undefined {
  const built = Bun.spawnSync(
    [process.execPath, "build", "--compile", `--target=${target}`, entry, "--outfile", outfile],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" },
  );
  return built.exitCode === 0 ? undefined : built.stderr.toString() || built.stdout.toString();
}

/** Builds into `out`; the version, or why not. */
export function buildProgram(
  target: Target,
  out: string,
  web: string = join(REPO, "app", "dist"),
): Result<string, string> {
  const version = hubVersion();
  // The keys this program will trust for its updates: never the tests' key (section 9).
  const keys = releaseKeysProblem(PUBLISHER_KEYS);
  if (keys !== undefined) return err(`refused: ${keys}`);
  if (PUBLISHER_KEYS.length === 0)
    process.stderr.write(
      "build-program: no publisher key yet: this build will refuse every update\n",
    );
  const versionDir = join(out, "versions", version);
  if (!existsSync(join(web, "index.html")))
    return err(`no web build at ${web}: run \`bun run app:export\` first`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(versionDir, "bin"), { recursive: true });
  mkdirSync(join(out, "launcher"), { recursive: true });
  const hub = compile(
    target,
    join(HUB, "packaging", "shared", "program.ts"),
    join(versionDir, "bin", exe(target, "hsn-hub")),
  );
  if (hub !== undefined) return err(`the program did not compile: ${hub}`);
  const launcher = compile(
    target,
    join(HUB, "launcher", "src", "main.ts"),
    join(out, "launcher", exe(target, "hsn-launcher")),
  );
  if (launcher !== undefined) return err(`the launcher did not compile: ${launcher}`);
  const copied = Result.fromThrowable(
    () => {
      cpSync(join(HUB, "drizzle"), join(versionDir, "drizzle"), { recursive: true });
      cpSync(web, join(versionDir, "web"), { recursive: true });
      writeFileSync(join(out, "version"), `${version}\n`);
    },
    (thrown) => (thrown instanceof Error ? thrown.message : String(thrown)),
  )();
  return copied.map(() => version);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const target = args[args.indexOf("--target") + 1] ?? "";
  const out = args[args.indexOf("--out") + 1];
  if (!isTarget(target) || out === undefined) {
    process.stderr.write(
      `usage: build-program.ts --target <${TARGETS.join("|")}> --out <folder>\n`,
    );
    process.exit(2);
  }
  const built = buildProgram(target, out);
  if (built.isErr()) {
    process.stderr.write(`build-program: ${built.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${built.value}\n`);
}
