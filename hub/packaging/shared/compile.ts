/**
 * Compiling one of the hub's executables (m2-design.md section 9, "The privilege boundary"): the
 * hub's program, `hsn` and the launcher, each its own executable, every one with Bun's automatic
 * loading of configuration from the folder it runs in turned off. `hsn` runs elevated from any
 * working folder, so a `.env` or a `bunfig.toml` there (a `preload` in it runs code) must never
 * be read; the hub and the launcher are built the same way, so none of the three differs.
 *
 * The flags, from Bun 1.4.2's own `bun build --help` (checked by the step 0 owner, not taken from
 * the design): `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig` (both loaded by
 * default), and `--no-compile-autoload-tsconfig` and `--no-compile-autoload-package-json` (off by
 * default, named here so a later default cannot turn them on). `compile.test.ts` plants both
 * files and shows a probe built this way reads neither, and one built without them reads both.
 *
 * Step 0 owner's; A8's `build-program.ts` compiles every executable through `compileExecutable`.
 */

/** Bun's automatic loading of configuration at run time, every kind of it off. */
export const NO_AUTOLOAD_FLAGS = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
] as const;

/** The command that compiles `entry` to `outfile` for `target`, with nothing loaded at run time. */
export function compileCommand(
  bun: string,
  target: string,
  entry: string,
  outfile: string,
  worker?: { readonly root: string; readonly entry: string },
): readonly string[] {
  return [
    bun,
    "build",
    "--compile",
    ...NO_AUTOLOAD_FLAGS,
    `--target=${target}`,
    entry,
    ...(worker === undefined ? [] : ["--root", worker.root, worker.entry]),
    "--outfile",
    outfile,
  ];
}

/** Compiles one executable; undefined when it compiled, or what Bun said. */
export function compileExecutable(
  target: string,
  entry: string,
  outfile: string,
  cwd: string,
  worker?: Parameters<typeof compileCommand>[4],
): string | undefined {
  const built = Bun.spawnSync(
    [...compileCommand(process.execPath, target, entry, outfile, worker)],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return built.exitCode === 0 ? undefined : built.stderr.toString() || built.stdout.toString();
}
