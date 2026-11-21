#!/usr/bin/env bun
/**
 * `bun hub/packaging/shared/build-program.ts --target <bun target> --out <folder> [--version <v>]`: one version's
 * program and the two executables beside it, which every package puts in its root-owned tree
 * (m2-design.md section 9, "The privilege boundary"):
 *
 * ```
 * <out>/versions/<version>/bin/hsn-hub[.exe]   the hub (`program.ts`), compiled by Bun
 * <out>/versions/<version>/drizzle/            the migrations
 * <out>/versions/<version>/web/                the web app's export (`bun run app:export`), with csp.json
 * <out>/bin/hsn-launcher[.exe]                 the launcher, compiled apart
 * <out>/bin/hsn[.exe]                          `hsn` (`cli/hsn.ts`), compiled apart
 * <out>/version                                the version, for the package scripts
 * ```
 *
 * All three are compiled through `compileExecutable` (`compile.ts`, the step 0 owner's), with
 * Bun's automatic loading of `.env`, `bunfig.toml`, `tsconfig` and `package.json` turned off. The
 * hub's program embeds its worker entries (`hubWorkers`): staging an update's on every system,
 * and the serial port's on Windows.
 *
 * Run on a machine of the target's own system (each package's build says which): Bun compiles
 * for another system only by fetching that system's runtime, which these builds do not do here.
 * Prints the version on success; exits 1 with the reason otherwise.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, Result } from "neverthrow";
import { PUBLISHER_KEYS, releaseKeysProblem } from "../../src/shell/update/publisher-keys.ts";
import { compileExecutable } from "./compile.ts";

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

/**
 * The worker entries the hub's program embeds, below `HUB` (each started by its source path):
 * the file jobs' one entry on every system (`src/shell/worker/entry.ts`), and on Windows the
 * serial port's.
 */
export function hubWorkers(target: Target): readonly string[] {
  return [
    join(HUB, "src", "shell", "worker", "entry.ts"),
    ...(target === "bun-windows-x64"
      ? [join(HUB, "src", "shell", "safe", "worker-windows-serial.ts")]
      : []),
  ];
}

/** The Bun target of the computer this runs on, if the hub is built for it. */
export function hostTarget(): Target | undefined {
  const system = process.platform === "win32" ? "windows" : process.platform;
  const target = `bun-${system}-${process.arch}`;
  return isTarget(target) ? target : undefined;
}

function compile(target: Target, entry: string, outfile: string): string | undefined {
  const hub = entry === join(HUB, "packaging", "shared", "program.ts");
  return compileExecutable(
    target,
    entry,
    outfile,
    REPO,
    hub ? { root: HUB, entries: hubWorkers(target) } : undefined,
  );
}

/** Builds into `out`; the version, or why not. */
export function buildProgram(
  target: Target,
  out: string,
  web: string = join(REPO, "app", "dist"),
  version = hubVersion(),
): Result<string, string> {
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
  mkdirSync(join(out, "bin"), { recursive: true });
  const hub = compile(
    target,
    join(HUB, "packaging", "shared", "program.ts"),
    join(versionDir, "bin", exe(target, "hsn-hub")),
  );
  if (hub !== undefined) return err(`the program did not compile: ${hub}`);
  const launcher = compile(
    target,
    join(HUB, "launcher", "src", "main.ts"),
    join(out, "bin", exe(target, "hsn-launcher")),
  );
  if (launcher !== undefined) return err(`the launcher did not compile: ${launcher}`);
  const hsn = compile(target, join(HUB, "cli", "hsn.ts"), join(out, "bin", exe(target, "hsn")));
  if (hsn !== undefined) return err(`hsn did not compile: ${hsn}`);
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
  const versionAt = args.indexOf("--version");
  const version = versionAt === -1 ? undefined : (args[versionAt + 1] ?? "");
  if (version !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    process.stderr.write("build-program: --version needs a numeric major.minor.patch\n");
    process.exit(2);
  }
  if (!isTarget(target) || out === undefined) {
    process.stderr.write(
      `usage: build-program.ts --target <${TARGETS.join("|")}> --out <folder> [--version <v>]\n`,
    );
    process.exit(2);
  }
  const built = buildProgram(target, out, undefined, version);
  if (built.isErr()) {
    process.stderr.write(`build-program: ${built.error}\n`);
    process.exit(1);
  }
  process.stdout.write(`${built.value}\n`);
}
