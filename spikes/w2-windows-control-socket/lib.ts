/**
 * What spikes W2 and W3 share: result lines, running commands, access lists, and running the
 * client as the second local account. Windows-only steps are skipped elsewhere, so the plumbing
 * can be tried on macOS or Linux first.
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export const isWindows = process.platform === "win32";

/** The second local account: an ordinary user, not an administrator. */
export const OTHER_USER = "hsnspike2";

/** Well-known SIDs, so the access lists do not depend on the system's language. */
export const SID = {
  administrators: "*S-1-5-32-544",
  users: "*S-1-5-32-545",
  system: "*S-1-5-18",
  everyone: "*S-1-1-0",
} as const;

export type Verdict = "pass" | "fail" | "skip" | "inconclusive";

export interface ResultLine {
  readonly spike: "W2" | "W3";
  readonly test: string;
  /** pass: the option meets the criterion; fail: it does not; skip: not run here; inconclusive: could not tell. */
  readonly result: Verdict;
  /** What the design expects, when a "fail" is the expected outcome (a named pipe open to everyone). */
  readonly expected?: Verdict;
  readonly observed: unknown;
}

/** One line of JSON on standard output and in the results file. */
export function report(file: string, line: ResultLine): void {
  const text = JSON.stringify(line);
  console.log(text);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${text}\n`);
}

export interface Ran {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

export function run(cmd: readonly string[], env: Record<string, string> = {}, timeoutMs = 60_000): Ran {
  try {
    const p = Bun.spawnSync([...cmd], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    });
    return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
  } catch (e) {
    return { code: null, out: "", err: String(e) };
  }
}

/**
 * The same, without blocking: a server in this process (the spike's own) must go on answering
 * while the client it is tested with runs.
 */
export async function runAsync(
  cmd: readonly string[],
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<Ran> {
  try {
    const p = Bun.spawn([...cmd], {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out: out.trim(), err: err.trim() };
  } catch (e) {
    return { code: null, out: "", err: String(e) };
  }
}

export function psAsync(script: string, env: Record<string, string> = {}, timeoutMs = 60_000): Promise<Ran> {
  return runAsync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env, timeoutMs);
}

/** A PowerShell script, values passed through the environment, never on the command line. */
export function ps(script: string, env: Record<string, string> = {}, timeoutMs = 60_000): Ran {
  return run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], env, timeoutMs);
}

export function icacls(path: string, ...args: string[]): Ran {
  return run(["icacls", path, ...args]);
}

/** The access list as icacls prints it, compacted to one line per entry. */
export function aclOf(path: string): string[] {
  if (!isWindows) return ["(not Windows)"];
  const r = icacls(path);
  return (r.out || r.err)
    .split(/\r?\n/u)
    .map((l) => l.replace(path, "").trim())
    .filter((l) => l !== "" && !l.startsWith("Successfully processed"));
}

/** The folder whose access list admits only the interactive user, Administrators and SYSTEM. */
export function lockFolder(path: string, extra: readonly string[] = []): Ran {
  mkdirSync(path, { recursive: true });
  if (!isWindows) return { code: 0, out: "(not Windows: chmod 700)", err: "" };
  const me = userInfo().username;
  return icacls(
    path,
    "/inheritance:r",
    "/grant:r",
    `${me}:(OI)(CI)F`,
    `${SID.administrators}:(OI)(CI)F`,
    `${SID.system}:(OI)(CI)F`,
    ...extra.map((account) => `${account}:(OI)(CI)F`),
  );
}

/** The spike's working folders: short paths (an AF_UNIX path is at most 108 bytes). */
export function folders() {
  const base = isWindows ? "C:\\hsn-spike" : join(tmpdir(), "hsn-spike");
  return {
    base,
    /** bun.exe and the client, readable and runnable by every local user. */
    bin: join(base, "bin"),
    /** Where the second account's client writes its result. */
    out: join(base, "out"),
    open: join(base, "open"),
    locked: join(base, "locked"),
  };
}

/** Copies bun and the client where the second account can run them. */
export function prepareShared(): { bun: string; client: string; log: Ran[] } {
  const f = folders();
  for (const d of [f.bin, f.out]) mkdirSync(d, { recursive: true });
  const bun = join(f.bin, isWindows ? "bun.exe" : "bun");
  if (!existsSync(bun)) copyFileSync(process.execPath, bun);
  const client = join(f.bin, "client.ts");
  copyFileSync(join(import.meta.dir, "client.ts"), client);
  const log: Ran[] = [];
  if (isWindows) {
    log.push(icacls(f.bin, "/grant", `${SID.users}:(OI)(CI)RX`));
    log.push(icacls(f.out, "/grant", `${SID.users}:(OI)(CI)M`));
  }
  return { bun, client, log };
}

/** A fresh password for the second account, made in the run and never printed. */
export function newPassword(): string {
  return `Hs1!${randomBytes(12).toString("base64url")}`;
}

/** Creates the second local account (or resets its password). Windows only. */
export function ensureOtherUser(password: string): Ran {
  return ps(
    `$ErrorActionPreference = 'Stop'
     $p = ConvertTo-SecureString $env:HSN_PW -AsPlainText -Force
     if (Get-LocalUser -Name $env:HSN_USER -ErrorAction SilentlyContinue) {
       Set-LocalUser -Name $env:HSN_USER -Password $p
     } else {
       New-LocalUser -Name $env:HSN_USER -Password $p -PasswordNeverExpires -AccountNeverExpires | Out-Null
       Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $env:HSN_USER
     }
     (Get-LocalUser -Name $env:HSN_USER).SID.Value`,
    { HSN_USER: OTHER_USER, HSN_PW: password },
  );
}

export interface AsOther {
  readonly method: "Start-Process" | "schtasks" | "none";
  readonly outcome: Record<string, unknown> | undefined;
  readonly errors: string[];
}

let workingMethod: AsOther["method"] | undefined;

/**
 * Runs the client as the second account and returns what it wrote. First `Start-Process
 * -Credential` (CreateProcessWithLogonW); if that cannot start a process from the runner's
 * session, a scheduled task run once as that account (a batch logon, for which the account is
 * put in Performance Log Users, which holds that right by default and nothing else of note).
 */
export async function asOtherUser(
  password: string,
  args: readonly string[],
  label: string,
): Promise<AsOther> {
  const f = folders();
  const { bun, client } = { bun: join(f.bin, "bun.exe"), client: join(f.bin, "client.ts") };
  const resultFile = join(f.out, `${label}.json`);
  rmSync(resultFile, { force: true });
  const errors: string[] = [];
  const read = (): Record<string, unknown> | undefined => {
    if (!existsSync(resultFile)) return undefined;
    try {
      return JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>;
    } catch (e) {
      errors.push(`result unreadable: ${String(e)}`);
      return undefined;
    }
  };
  const argList = [client, ...args, resultFile].map((a) => `"${a}"`).join(" ");
  const env = { HSN_USER: OTHER_USER, HSN_PW: password, HSN_BUN: bun, HSN_ARGS: argList, HSN_DIR: f.bin };

  if (workingMethod !== "schtasks") {
    const r = await psAsync(
      `$ErrorActionPreference = 'Stop'
       $p = ConvertTo-SecureString $env:HSN_PW -AsPlainText -Force
       $c = New-Object System.Management.Automation.PSCredential($env:HSN_USER, $p)
       $proc = Start-Process -FilePath $env:HSN_BUN -ArgumentList $env:HSN_ARGS -Credential $c -WorkingDirectory $env:HSN_DIR -Wait -PassThru -WindowStyle Hidden
       $proc.ExitCode`,
      env,
      60_000,
    );
    const got = read();
    if (got !== undefined) {
      workingMethod = "Start-Process";
      return { method: "Start-Process", outcome: got, errors };
    }
    errors.push(`Start-Process: code ${r.code}: ${(r.err || r.out).slice(0, 400)}`);
  }

  const task = `hsnspike-${label}`.slice(0, 200);
  // A task's command is at most 261 characters: it runs a script that holds the real one.
  const script = join(f.bin, `${label}.cmd`);
  writeFileSync(script, `@"${bun}" ${argList}\r\n`);
  ps(`Add-LocalGroupMember -SID 'S-1-5-32-559' -Member $env:HSN_USER -ErrorAction SilentlyContinue`, env);
  const create = run([
    "schtasks",
    "/Create",
    "/F",
    "/TN",
    task,
    "/SC",
    "ONCE",
    "/ST",
    "23:59",
    "/RU",
    OTHER_USER,
    "/RP",
    password,
    "/TR",
    script,
  ]);
  if (create.code !== 0) errors.push(`schtasks /Create: ${(create.err || create.out).slice(0, 400)}`);
  else {
    const start = await runAsync(["schtasks", "/Run", "/TN", task]);
    if (start.code !== 0) errors.push(`schtasks /Run: ${(start.err || start.out).slice(0, 400)}`);
    for (let i = 0; i < 100 && read() === undefined; i++) await Bun.sleep(200);
    run(["schtasks", "/Delete", "/F", "/TN", task]);
    const got = read();
    if (got !== undefined) {
      workingMethod = "schtasks";
      return { method: "schtasks", outcome: got, errors };
    }
    errors.push("schtasks: the task wrote no result within 20 s");
  }
  return { method: "none", outcome: undefined, errors };
}

/** The client as this process's own user, in a process of its own (as `hsn` would be). */
export async function asSelf(
  args: readonly string[],
  label: string,
): Promise<Record<string, unknown> | undefined> {
  const f = folders();
  const resultFile = join(f.out, `${label}.self.json`);
  rmSync(resultFile, { force: true });
  await runAsync([process.execPath, join(import.meta.dir, "client.ts"), ...args, resultFile]);
  try {
    return JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The value after `--name` on the command line, or the fallback. */
export function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}
