/**
 * Staging an update in a compiled executable: the probe (`staging-probe.ts`) compiled exactly as
 * the hub's program is, `build-program.ts`'s flags and its embedded workers (`hubWorkers`), for
 * the computer the test runs on, stages a release through the staging worker. That the worker is
 * embedded and found in the executable (Bun finds it by its source path below the compile root)
 * is what the source runs cannot show. The installed program's own check is the installers'.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPaths } from "../../launcher/src/layout.ts";
import { programName } from "../../src/shell/update/program-name.ts";
import { platformOf } from "../../src/shell/update/release.ts";
import { compileExecutable } from "../shared/compile.ts";
import { hostTarget, hubWorkers } from "../shared/build-program.ts";
import { releaseOfFiles } from "../shared/make-release.ts";

const HUB = join(import.meta.dir, "..", "..");
const REPO = join(HUB, "..");
const target = hostTarget();
const platform = platformOf(process.platform, process.arch);
const SEED = new Uint8Array(32).fill(7);
const root = mkdtempSync(join(tmpdir(), "hsn-compiled-staging-"));
let probe = "";

// Compiling takes seconds, and a whole suite running beside it more.
setDefaultTimeout(120_000);

beforeAll(() => {
  if (target === undefined) return;
  probe = join(root, process.platform === "win32" ? "probe.exe" : "probe");
  const failed = compileExecutable(target, join(import.meta.dir, "staging-probe.ts"), probe, REPO, {
    root: HUB,
    entries: hubWorkers(target),
  });
  expect(failed).toBeUndefined();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The program tree the launcher would have made, running 0.1.0. */
function programTree(name: string): string {
  const prefix = join(root, name);
  mkdirSync(join(prefix, "staged", "0.1.0", "bin"), { recursive: true });
  mkdirSync(join(prefix, "state"), { recursive: true });
  writeFileSync(
    installPaths(prefix).launcherFile,
    JSON.stringify({ current: "0.1.0", previous: null, trial: null, rolledBack: null }),
  );
  return prefix;
}

const text = (s: string) => new TextEncoder().encode(s);

/** A release for this computer, signed with the tests' key; `spoil` changes its last byte. */
function release(spoil = false): {
  readonly path: string;
  readonly files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>([
    [`bin/${programName(platform ?? "linux-x64")}`, text("a program\n".repeat(50_000))],
    ["drizzle/0000.sql", text("CREATE TABLE x (a);")],
    ...Array.from(
      { length: 40 },
      (_, i) => [`web/f${i}.js`, text(`export const x${i} = 1;\n`)] as const,
    ),
  ]);
  const entries = [...files]
    .map(([path, data]) => ({ path, data, executable: path.startsWith("bin/") }))
    .toSorted((a, b) => (a.path < b.path ? -1 : 1));
  const bytes = releaseOfFiles(entries, "9.0.0", platform ?? "linux-x64", SEED, 0)._unsafeUnwrap();
  if (spoil) bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  const path = join(root, spoil ? "spoilt.hsnr" : "release.hsnr");
  writeFileSync(path, bytes);
  return { path, files };
}

/** Runs the compiled probe: what it printed. */
async function staged(upload: string, prefix: string) {
  const run = Bun.spawn([probe, upload, prefix], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);
  expect(err).toBe("");
  expect(code).toBe(0);
  return JSON.parse(out) as { readonly main: string; readonly outcome: unknown };
}

describe.skipIf(target === undefined || platform === undefined)(
  "staging in the compiled program, through its embedded worker",
  () => {
    test("staged byte for byte, from inside the executable", async () => {
      const { path, files } = release();
      const prefix = programTree("good");
      const { main, outcome } = await staged(path, prefix);
      // The executable's own file system: the embedded worker's path was taken, not the source's.
      expect(main).toMatch(/(?:^|[\\/])(?:~BUN|\$bunfs)[\\/]/u);
      expect(outcome).toEqual({ kind: "updateStaged", version: "9.0.0" });
      for (const [file, data] of files)
        expect(Buffer.from(readFileSync(join(prefix, "staged", "9.0.0", file))).equals(data)).toBe(
          true,
        );
      expect(readdirSync(join(prefix, "staged")).toSorted()).toEqual(["0.1.0", "9.0.0"]);
    });

    test("a release refused by the worker: badFile, nothing left behind", async () => {
      const { path } = release(true);
      const prefix = programTree("spoilt");
      const { outcome } = await staged(path, prefix);
      expect(outcome).toMatchObject({ kind: "failed", reason: "badFile" });
      expect(readdirSync(join(prefix, "staged"))).toEqual(["0.1.0"]);
      expect(existsSync(join(prefix, "staged", ".staging-9.0.0"))).toBe(false);
    });
  },
);
