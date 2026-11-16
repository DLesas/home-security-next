/**
 * What `hsn` run as root does before it talks to the hub (m2-design.md section 9, "The privilege
 * boundary"): which helper it starts as the person, and that it drops. Every command drops to the
 * hub's account; the only step of the system that keeps root, the purge (`--remove-data`), is
 * the installers', not a command of `hsn`. A command is not exempt by being left out of a list:
 * `keepsRoot` is false whatever the words, and a test runs every command of the table through it.
 */
import { parseArgs } from "./args.ts";

/** The helper a command needs, started as the person before the drop. */
export type HelperNeed =
  | { readonly kind: "none" }
  | { readonly kind: "file"; readonly mode: "read" | "write"; readonly path: string }
  | { readonly kind: "page" };

export interface RootPlan {
  readonly helper: HelperNeed;
  /** Always false: no command of `hsn` keeps root (section 9). */
  readonly keepsRoot: false;
}

/** The plan for these words, read the way `runCli` will read them. */
export function rootPlan(argv: readonly string[], nowMs: number): RootPlan {
  const parsed = parseArgs(argv, nowMs);
  if (parsed.isOk() && parsed.value.kind === "file") {
    const file = parsed.value.file;
    return {
      helper: {
        kind: "file",
        mode: file.kind === "backupExport" ? "write" : "read",
        path: file.path,
      },
      keepsRoot: false,
    };
  }
  if (
    parsed.isOk() &&
    parsed.value.kind === "command" &&
    parsed.value.command.kind === "consoleToken"
  )
    return { helper: { kind: "page" }, keepsRoot: false };
  return { helper: { kind: "none" }, keepsRoot: false };
}
