/**
 * A stand-in for the hub, run by the launcher's tests as a real child process:
 * `bun fake-hub.ts <version> --data <folder>`. Each start appends `<version> <n>` to
 * `<data>/starts.log`, then does what `<data>/plan-<version>.json` says for its n-th start (the
 * last entry repeats):
 *
 * - `{"exit": c, "afterMs": t}`: exits with `c` after `t` ms;
 * - `{"hang": true, "ignoreTerm": b}`: runs until SIGTERM (exits 0, writing `<version> clean`),
 *   or with `ignoreTerm` until killed;
 * - `{"healthy": true}`: writes `healthy.json` in `$HSN_PROGRAM/state/`, then hangs as above;
 * - `{"switchTo": v}`: writes `switch.json` for `v`, then exits 70, as the hub's switch does;
 * - `{"migrate": n}` with any of the above: first copies `hub.db` to `hub.db.before-<n>`, then
 *   writes `migrated by <version>` into `hub.db` and a `hub.db-wal`, as a migration would.
 * - `{"leftover": true}` with any of the above: a start cut off while copying, leaving half a copy
 *   under its temporary name `hub.db.copying` (`shell/storage/migrations.ts`) and `hub.db` not
 *   migrated.
 */
import {
  appendFileSync,
  existsSync,
  unlinkSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

interface Plan {
  readonly exit?: number;
  readonly afterMs?: number;
  readonly hang?: boolean;
  readonly ignoreTerm?: boolean;
  readonly healthy?: boolean;
  readonly switchTo?: string;
  readonly migrate?: number;
  readonly leftover?: boolean;
}

const version = basename(dirname(dirname(process.execPath)));
const dataIndex = process.argv.indexOf("--data");
const data = process.argv[dataIndex + 1] ?? ".";
const prefix = process.env.HSN_PROGRAM ?? ".";
const log = join(data, "starts.log");
const starts = readFileSync(log, { encoding: "utf8", flag: "a+" })
  .split("\n")
  .filter((line) => line.startsWith(`${version} `) && !line.endsWith(" clean")).length;
appendFileSync(log, `${version} ${starts + 1}\n`);
const plans = JSON.parse(readFileSync(join(data, `plan-${version}.json`), "utf8")) as Plan[];
const plan: Plan = plans[Math.min(starts, plans.length - 1)] ?? { exit: 0 };

if (plan.migrate !== undefined) {
  copyFileSync(join(data, "hub.db"), join(data, `hub.db.before-${plan.migrate}`));
  writeFileSync(join(data, "hub.db"), `migrated by ${version}`);
  writeFileSync(join(data, "hub.db-wal"), "wal of the migrated database");
}

if (plan.leftover === true) writeFileSync(join(data, "hub.db.copying"), "half a cop");

function hang(): void {
  const stop = () => {
    if (plan.ignoreTerm === true) return;
    appendFileSync(log, `${version} clean\n`);
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  const marker = join(data, "service-stop");
  setInterval(() => {
    if (process.platform === "win32" && existsSync(marker)) {
      unlinkSync(marker);
      stop();
    }
  }, 20);
}

if (plan.switchTo !== undefined) {
  writeFileSync(join(prefix, "state", "switch.json"), JSON.stringify({ to: plan.switchTo }));
  process.exit(70);
} else if (plan.healthy === true) {
  writeFileSync(join(prefix, "state", "healthy.json"), JSON.stringify({ version }));
  hang();
} else if (plan.hang === true) {
  hang();
} else {
  setTimeout(() => process.exit(plan.exit ?? 0), plan.afterMs ?? 0);
}
