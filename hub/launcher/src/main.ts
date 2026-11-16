#!/usr/bin/env bun
/**
 * `hsn-launcher --package <the package's tree> --program <the hub's program tree> --data <data
 * folder> [-- <more hub arguments>]`: what the service manager runs, as the hub's account
 * (m2-design.md section 9): launchd on macOS, systemd on Linux, WinSW on Windows. It exits 0 only
 * for a clean stop, so the service manager restarts it on anything else (launchd `KeepAlive` with
 * `SuccessfulExit` false, systemd `Restart=on-failure`, WinSW `<onfailure action="restart"/>`).
 * No installer runs it: which version runs is decided here, at the next start ("The privilege
 * boundary").
 */
import { Launcher } from "./launcher.ts";

export interface LauncherArgs {
  readonly packageRoot: string;
  readonly programRoot: string;
  readonly dataDir: string;
  readonly hubArgs: readonly string[];
}

export function parseLauncherArgs(argv: readonly string[]): LauncherArgs | string {
  let packageRoot: string | undefined;
  let programRoot: string | undefined;
  let dataDir: string | undefined;
  const hubArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--") {
      hubArgs.push(...argv.slice(i + 1));
      break;
    }
    const value = argv[i + 1];
    if (word === "--package" && value !== undefined) packageRoot = value;
    else if (word === "--program" && value !== undefined) programRoot = value;
    else if (word === "--data" && value !== undefined) dataDir = value;
    else return `unknown argument ${word ?? ""}`;
    i++;
  }
  if (packageRoot === undefined) return "--package needs the package's tree";
  if (programRoot === undefined) return "--program needs the hub's program tree";
  if (dataDir === undefined) return "--data needs the data folder";
  return { packageRoot, programRoot, dataDir, hubArgs };
}

if (import.meta.main) {
  const args = parseLauncherArgs(process.argv.slice(2));
  if (typeof args === "string") {
    process.stderr.write(`launcher: ${args}\n`);
    process.exit(2);
  }
  const launcher = new Launcher(args);
  const stop = (): void => {
    launcher.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.exit(await launcher.run());
}
