#!/usr/bin/env bun
/**
 * Spike W3 (docs/m2-design.md section 9): hosting the hub as a Windows service, as far as a
 * hosted runner allows (it cannot reboot itself, so "started at boot" is the start type plus a
 * stop and a start by the Service Control Manager).
 *
 *   WINSW=<path to WinSW-x64.exe> bun w3.ts --out results/w3.jsonl --repo <checkout>
 *
 * The services, each wrapped by WinSW (the design's option (a)):
 * - HSNExit70 and HSNExit0: a stand-in exiting 70 (must be restarted) and 0 (must not).
 * - HSNHub: the hub's own entry point (`hub/src/shell/main.ts`) under the virtual account
 *   `NT SERVICE\HSNHub`, its data folder `%ProgramData%\HSN Hub` locked to that account,
 *   Administrators and SYSTEM; stopped by the manager, the hub's clean-stop mark must be written.
 * - HSNProbeUnix and HSNProbeTcp: W2's stand-in control socket under their own virtual accounts,
 *   its folder admitting the service, the installing user and Administrators: the interactive
 *   user must be answered, the second account refused.
 *
 * One JSON line per test; never fails the job for an option that does not work. On macOS or Linux
 * it writes the WinSW configurations and runs the stand-in once, and skips the rest.
 */
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  aclOf,
  arg,
  asOtherUser,
  asSelf,
  ensureOtherUser,
  folders,
  icacls,
  isWindows,
  newPassword,
  prepareShared,
  report,
  run,
  runAsync,
  SID,
  type Verdict,
} from "../w2-windows-control-socket/lib.ts";

const OUT = arg("--out", join(import.meta.dir, "results", "w3.jsonl"));
const REPO = arg("--repo", join(import.meta.dir, "..", ".."));
const line = (test: string, result: Verdict, observed: unknown, expected?: Verdict): void =>
  report(OUT, { spike: "W3", test, result, observed, ...(expected === undefined ? {} : { expected }) });

const f = folders();
const W3 = join(f.base, "w3");
rmSync(W3, { recursive: true, force: true });
mkdirSync(W3, { recursive: true });
const shared = prepareShared();
const bun = shared.bun;
const programData = process.env["ProgramData"] ?? join(f.base, "ProgramData");
const me = userInfo().username;

// ----- WinSW, pinned by the hash the workflow checks -----
const winsw = process.env["WINSW"] ?? "";
let winswHash = "";
if (winsw !== "" && existsSync(winsw)) {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(winsw));
  winswHash = hasher.digest("hex");
}
const pinned = process.env["WINSW_SHA256"] ?? "";
line("environment", "pass", {
  platform: process.platform,
  bun: Bun.version,
  user: me,
  repo: REPO,
  winsw: winsw === "" ? "(not given)" : winsw,
  winswSha256: winswHash || undefined,
  winswPinned: pinned === "" ? "no pin set: review this hash and set WINSW_SHA256 in the workflow" : pinned === winswHash ? "matches" : "DIFFERS",
});

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

interface Service {
  readonly id: string;
  readonly folder: string;
  readonly exe: string;
}

/** A WinSW service: its folder holds `<id>.exe` (WinSW) and `<id>.xml`, the configuration. */
function define(id: string, args: readonly string[], options: { restart: boolean; workdir: string }): Service {
  const folder = join(W3, id);
  mkdirSync(join(folder, "logs"), { recursive: true });
  const config = [
    "<service>",
    `  <id>${id}</id>`,
    `  <name>${id} (HSN spike W3)</name>`,
    "  <description>A spike service, removed at the end of the run.</description>",
    `  <executable>${xml(bun)}</executable>`,
    `  <arguments>${xml(args.map((a) => `"${a}"`).join(" "))}</arguments>`,
    `  <workingdirectory>${xml(options.workdir)}</workingdirectory>`,
    "  <startmode>Automatic</startmode>",
    "  <stoptimeout>20 sec</stoptimeout>",
    options.restart ? '  <onfailure action="restart" delay="1 sec"/>' : "",
    "  <resetfailure>1 hour</resetfailure>",
    `  <logpath>${xml(join(folder, "logs"))}</logpath>`,
    '  <log mode="reset"/>',
    "</service>",
  ]
    .filter((l) => l !== "")
    .join("\n");
  writeFileSync(join(folder, `${id}.xml`), `${config}\n`);
  const exe = join(folder, `${id}.exe`);
  if (winsw !== "" && existsSync(winsw)) copyFileSync(winsw, exe);
  return { id, folder, exe };
}

function sc(...args: string[]) {
  return run(["sc.exe", ...args]);
}

/** The service's state as `sc query` names it (RUNNING, STOPPED…). */
function state(id: string): string {
  const r = sc("query", id);
  return /STATE\s*:\s*\d+\s+(\w+)/u.exec(r.out)?.[1] ?? `unknown (${(r.out || r.err).slice(0, 120)})`;
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await Bun.sleep(250);
  return condition();
}

function logTail(s: Service, chars = 600): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const name of readdirSync(join(s.folder, "logs"))) {
      const text = readFileSync(join(s.folder, "logs", name), "utf8");
      out[name] = text.slice(-chars);
    }
  } catch (e) {
    out["error"] = String(e);
  }
  return out;
}

function uninstall(s: Service): void {
  run([s.exe, "stop"]);
  run([s.exe, "uninstall"]);
}

const canRun = isWindows && winswHash !== "";
if (!canRun) {
  // The plumbing only: the configurations, and the stand-in once.
  const counter = join(W3, "exit-code.txt");
  const ran = run([process.execPath, join(import.meta.dir, "exit-code.ts"), "70", counter]);
  const s = define("HSNExample", [join(import.meta.dir, "exit-code.ts"), "70", counter], { restart: true, workdir: W3 });
  line("plumbing: a WinSW configuration and the stand-in", ran.code === 70 && existsSync(counter) ? "pass" : "fail", {
    exitCode: ran.code,
    counterLines: existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0,
    config: readFileSync(join(s.folder, `${s.id}.xml`), "utf8"),
  });
  line("every service test", "skip", isWindows ? "WinSW not given (WINSW)" : "not Windows");
  process.exit(0);
}

// ----- Restart after exit code 70, and not after 0 -----
for (const code of [70, 0] as const) {
  const counter = join(W3, `exit-${code}.txt`);
  const s = define(`HSNExit${code}`, [join(import.meta.dir, "exit-code.ts"), String(code), counter], {
    restart: true,
    workdir: W3,
  });
  const installed = run([s.exe, "install"]);
  const started = run([s.exe, "start"]);
  await Bun.sleep(12_000);
  const starts = existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
  const ok = code === 70 ? starts >= 3 : starts === 1;
  line(
    code === 70 ? "exit code 70: restarted by the service manager" : "exit code 0: not restarted",
    ok ? "pass" : "fail",
    { installed: installed.code, started: started.code, startsIn12s: starts, state: state(s.id), log: logTail(s, 300) },
  );
  uninstall(s);
}

// ----- The hub as a service, under its virtual account -----
const dataDir = join(programData, "HSN Hub");
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
const hubService = define(
  "HSNHub",
  [join(REPO, "hub", "src", "shell", "main.ts"), "--data", dataDir, "--port", "0", "--no-usb-watch"],
  { restart: true, workdir: REPO },
);
const account = "NT SERVICE\\HSNHub";
{
  const installed = run([hubService.exe, "install"]);
  const config = sc("config", "HSNHub", "obj=", account);
  // What the service account must read and write; the virtual account exists once its service does.
  const grants = [
    icacls(REPO, "/grant", `${account}:(OI)(CI)RX`, "/Q"),
    icacls(f.bin, "/grant", `${account}:(OI)(CI)RX`),
    icacls(hubService.folder, "/grant", `${account}:(OI)(CI)M`),
    icacls(dataDir, "/inheritance:r", "/grant:r", `${account}:(OI)(CI)F`, `${SID.administrators}:(OI)(CI)F`, `${SID.system}:(OI)(CI)F`),
  ];
  const qc = sc("qc", "HSNHub");
  line("the hub installed as a service under NT SERVICE\\HSNHub, start type automatic", installed.code === 0 && config.code === 0 && /AUTO_START/u.test(qc.out) && qc.out.includes(account) ? "pass" : "fail", {
    install: installed.code,
    installOut: (installed.out || installed.err).slice(0, 300),
    config: config.code,
    configOut: (config.out || config.err).slice(0, 300),
    grants: grants.map((g) => g.code),
    qc: qc.out.split(/\r?\n/u).map((l) => l.trim()).filter((l) => /START_TYPE|SERVICE_START_NAME|BINARY_PATH_NAME/u.test(l)),
  });
}

const db = join(dataDir, "hub.db");
function boots(): { id: number; previousExit: string; cleanStopMs: number | null }[] {
  try {
    const d = new Database(db, { readonly: true });
    const rows = d
      .query<{ id: number; previous_exit: string; clean_stop_ms: number | null }, []>(
        "SELECT id, previous_exit, clean_stop_ms FROM boots ORDER BY id",
      )
      .all();
    d.close();
    return rows.map((r) => ({ id: r.id, previousExit: r.previous_exit, cleanStopMs: r.clean_stop_ms }));
  } catch {
    return [];
  }
}

async function startHub(label: string, bootsBefore: number): Promise<boolean> {
  const started = sc("start", "HSNHub");
  const up = await waitFor(() => state("HSNHub") === "RUNNING" && boots().length > bootsBefore, 90_000);
  const owner = await runAsync([
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name = 'bun.exe'\" | Where-Object { $_.CommandLine -like '*main.ts*' } | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; \"$($o.Domain)\\$($o.User)\" }",
  ]);
  line(`${label}: the service starts and the hub writes its boot`, up ? "pass" : "fail", {
    start: started.code,
    startOut: (started.out || started.err).slice(0, 300),
    state: state("HSNHub"),
    boots: boots(),
    processOwner: owner.out || owner.err,
    dataFolder: existsSync(dataDir) ? readdirSync(dataDir) : "missing",
    log: up ? undefined : logTail(hubService),
  });
  return up;
}

async function stopHub(label: string): Promise<void> {
  const before = boots();
  const stopped = sc("stop", "HSNHub");
  const down = await waitFor(() => state("HSNHub") === "STOPPED", 60_000);
  const after = boots();
  const last = after.at(-1);
  line(`${label}: stopped by the service manager, the hub's clean-stop mark written`, down && last?.cleanStopMs !== null && last !== undefined ? "pass" : "fail", {
    stop: stopped.code,
    stopped: down,
    lastBoot: last,
    bootsBefore: before.length,
    log: logTail(hubService),
  });
}

if (await startHub("first start", 0)) {
  // The data folder's access list, and the second account kept out of it.
  const password = newPassword();
  const made = ensureOtherUser(password);
  const list = made.code === 0 ? await asOtherUser(password, ["list-dir", dataDir], "w3-list") : undefined;
  const read = made.code === 0 ? await asOtherUser(password, ["read-file", db], "w3-read") : undefined;
  const refused = list?.outcome?.["ok"] === false && read?.outcome?.["ok"] === false;
  line("the data folder: limited to the service account, Administrators and SYSTEM", list?.outcome === undefined ? "inconclusive" : refused ? "pass" : "fail", {
    acl: aclOf(dataDir),
    dbAcl: aclOf(db),
    secondAccountList: list,
    secondAccountRead: read,
  });
  await stopHub("first stop");
  // "Started at boot", as far as a runner can: the manager starts it again; the hub reads the
  // last run as a clean stop.
  if (await startHub("second start", boots().length)) {
    const last = boots().at(-1);
    line("second start: the hub reads the run before as a clean stop", last?.previousExit === "clean" ? "pass" : "fail", { lastBoot: last });
    await stopHub("second stop");
  }
}
uninstall(hubService);

// ----- The command socket, served by a service, reached by the right accounts only -----
{
  const password = newPassword();
  const made = ensureOtherUser(password);
  for (const kind of ["unix-node", "tcp-secret"] as const) {
    const id = kind === "unix-node" ? "HSNProbeUnix" : "HSNProbeTcp";
    const probeAccount = `NT SERVICE\\${id}`;
    const folder = join(programData, `HSN ${id}`);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const socket = join(folder, "control.sock");
    const ready = join(folder, "ready.json");
    const secretFile = join(folder, "control.secret");
    const s = define(
      id,
      [join(REPO, "spikes", "w2-windows-control-socket", "server.ts"), kind, socket, ready, ...(kind === "tcp-secret" ? [secretFile] : [])],
      { restart: false, workdir: folder },
    );
    run([s.exe, "install"]);
    const config = sc("config", id, "obj=", probeAccount);
    const grants = [
      icacls(REPO, "/grant", `${probeAccount}:(OI)(CI)RX`, "/Q"),
      icacls(f.bin, "/grant", `${probeAccount}:(OI)(CI)RX`),
      icacls(s.folder, "/grant", `${probeAccount}:(OI)(CI)M`),
      icacls(folder, "/inheritance:r", "/grant:r", `${probeAccount}:(OI)(CI)F`, `${me}:(OI)(CI)F`, `${SID.administrators}:(OI)(CI)F`, `${SID.system}:(OI)(CI)F`),
    ];
    const started = sc("start", id);
    const up = await waitFor(() => existsSync(ready), 60_000);
    const info = up ? (JSON.parse(readFileSync(ready, "utf8")) as { ok: boolean; port?: number; error?: string }) : undefined;
    const target = kind === "tcp-secret" ? String(info?.port ?? 0) : socket;
    const selfArgs = kind === "tcp-secret" ? ["tcp-secret", target, secretFile] : ["unix-node", target];
    const self = up && info?.ok === true ? await asSelf(selfArgs, `${id}-self`) : undefined;
    const other = up && info?.ok === true && made.code === 0 ? await asOtherUser(password, selfArgs, `${id}-other`) : undefined;
    const otherOk = other?.outcome?.["ok"];
    line(
      `the command socket (${kind === "unix-node" ? "AF_UNIX" : "loopback TCP and secret"}) served by a service: the installing user answered, the second account refused`,
      self?.["ok"] === true && otherOk === false ? "pass" : other?.outcome === undefined && self?.["ok"] === true ? "inconclusive" : "fail",
      {
        config: config.code,
        grants: grants.map((g) => g.code),
        start: started.code,
        ready: info,
        socketFile: kind === "unix-node" ? existsSync(socket) && statSync(socket).size >= 0 : undefined,
        folderAcl: aclOf(folder),
        self,
        other,
        log: self?.["ok"] === true ? undefined : logTail(s),
      },
    );
    uninstall(s);
  }
}
