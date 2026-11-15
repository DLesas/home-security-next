#!/usr/bin/env bun
/**
 * `hsn-launcher --prefix <install folder> --data <data folder> [-- <more hub arguments>]`: what the
 * service manager runs (m2-design.md section 9): launchd on macOS, systemd on Linux, WinSW on
 * Windows. It exits 0 only for a clean stop, so the service manager restarts it on anything else
 * (launchd `KeepAlive` with `SuccessfulExit` false, systemd `Restart=on-failure`, WinSW
 * `<onfailure action="restart"/>`).
 */
import { Launcher } from "./launcher.ts";
import { selectVersion } from "./select.ts";

export interface LauncherArgs {
  readonly prefix: string;
  readonly dataDir: string;
  readonly hubArgs: readonly string[];
}

export interface SelectArgs {
  readonly prefix: string;
  readonly select: string;
}

export function parseLauncherArgs(argv: readonly string[]): LauncherArgs | SelectArgs | string {
  let prefix: string | undefined;
  let dataDir: string | undefined;
  let select: string | undefined;
  const hubArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--") {
      hubArgs.push(...argv.slice(i + 1));
      break;
    }
    const value = argv[i + 1];
    if (word === "--prefix" && value !== undefined) prefix = value;
    else if (word === "--data" && value !== undefined) dataDir = value;
    else if (word === "--select" && value !== undefined) select = value;
    else return `unknown option ${word ?? ""}`;
    i++;
  }
  if (prefix === undefined) return "--prefix needs the install folder";
  if (select !== undefined) return { prefix, select };
  if (dataDir === undefined) return "--data needs the data folder";
  return { prefix, dataDir, hubArgs };
}

if (import.meta.main) {
  const args = parseLauncherArgs(process.argv.slice(2));
  if (typeof args === "string") {
    process.stderr.write(`launcher: ${args}\n`);
    process.exit(2);
  }
  if ("select" in args) {
    const selected = selectVersion(args.prefix, args.select);
    process.stderr.write(
      selected.isOk()
        ? `launcher: ${args.select} is current\n`
        : `launcher: cannot select ${args.select}: ${selected.error}\n`,
    );
    process.exit(selected.isOk() ? 0 : 1);
  }
  const launcher = new Launcher(args);
  const stop = (): void => {
    launcher.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.exit(await launcher.run());
}
