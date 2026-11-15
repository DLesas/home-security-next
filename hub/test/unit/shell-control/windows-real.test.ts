/**
 * The control socket's Windows steps against Windows itself (run by
 * `.github/workflows/windows-control-socket.yml` on a hosted runner; skipped elsewhere): real
 * access lists set with `icacls`, read back by the hub's own Win32 calls, and the real server
 * opened, closed by the hub, or refused. The same cases as `windows-steps.test.ts`, which gives
 * the lists as data, where Windows can make them: a locked folder; an ordinary one and one with
 * Users added, which the hub closes (and what was already inside with it); a deny entry; a
 * junction in the path or inside an open folder, refused with nothing set on either side; an old
 * socket; something else at the path. A FAT volume, a network drive and an owner the hub may not
 * be cannot be made on the runner; those stay shown as data only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { UnixControlServer } from "../../../src/shell/control/server.ts";
import { checkDescriptor, parseSid } from "../../../src/shell/control/windows-acl.ts";
import { type ControlWarning, windowsSocketSteps } from "../../../src/shell/control/windows.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import { RawClient } from "./support.ts";
import {
  icacls,
  isWindows,
  junction,
  lockFolder,
  ordinaryFolder,
  runProgram,
  system32,
} from "./windows-folders.ts";

const BASE = join(process.env.SystemDrive ?? "C:", "\\", `hsn-a11-${process.pid}`);
const STATUS = `${JSON.stringify({ id: 7, actor: "runner", command: { kind: "status" } })}\n`;
const servers: UnixControlServer[] = [];
const warnings: ControlWarning[] = [];
const warn = (warning: ControlWarning): void => {
  warnings.push(warning);
};

/** What the rule says of a path's real list now: "closed", or what it found. */
function listNow(path: string, asFolder: boolean): string {
  const hub = parseSid(WINDOWS_CALLS.processSid()._unsafeUnwrap(), 0)._unsafeUnwrap().sid;
  const bytes = WINDOWS_CALLS.securityDescriptor(path);
  if (bytes.isErr()) return bytes.error.message;
  const checked = checkDescriptor(bytes.value, { hub }, asFolder);
  return checked.isOk() ? "closed" : checked.error.join("; ");
}

/** A row of the job summary's table, when the workflow asks for one. */
function row(what: string, observed: string): void {
  const file = process.env.HSN_RESULTS;
  if (file !== undefined && file !== "")
    appendFileSync(
      file,
      `| ${what} | ${observed.replaceAll("|", "\\|").replaceAll("\n", " ")} |\n`,
    );
}

async function open(socketPath: string): Promise<{ server?: UnixControlServer; message: string }> {
  const opened = await UnixControlServer.open({
    socketPath,
    onWarning: warn,
    logQuery: () => ok([]),
    deviceIdOf: () => undefined,
    writerStatus: () => ({
      lastCommitMs: null,
      stagedItems: 0,
      databaseBytes: null,
      historyShortened: false,
    }),
  });
  if (opened.isErr()) return { message: opened.error.message };
  servers.push(opened.value);
  return { server: opened.value, message: "opened" };
}

async function answered(server: UnixControlServer, socket: string): Promise<boolean> {
  const events: unknown[] = [];
  server.listen((event) => events.push(event));
  const client = new RawClient(socket);
  client.write(STATUS);
  return client.until(() => events.length === 1);
}

afterAll(async () => {
  for (const s of servers.splice(0)) expect((await s.close()).isOk()).toBe(true);
  if (isWindows) {
    // Junctions first, by rmdir, which removes a link and never what it points at.
    for (const link of ["link", "linkdata", join("inside", "keys")]) {
      if (existsSync(join(BASE, link)))
        runProgram(system32("cmd.exe"), ["/d", "/c", "rmdir", join(BASE, link)]);
    }
    rmSync(BASE, { recursive: true, force: true });
  }
});

describe.skipIf(!isWindows)("Windows itself: the hub's socket and real access lists", () => {
  test("a folder locked to the hub's account, Administrators and SYSTEM: opens, answers, is removed at close", async () => {
    const folder = join(BASE, "locked");
    expect(lockFolder(folder).code).toBe(0);
    const socket = join(folder, "control.sock");
    const steps = windowsSocketSteps(WINDOWS_CALLS, warn);
    const t0 = performance.now();
    const prepared = await steps.prepare(socket);
    const prepareMs = performance.now() - t0;
    expect(prepared.isOk() ? "prepared" : prepared.error.message).toBe("prepared");
    const { server, message } = await open(socket);
    expect(message).toBe("opened");
    const t1 = performance.now();
    const secured = steps.secure(socket);
    const secureMs = performance.now() - t1;
    expect(secured.isOk() ? "secured" : secured.error.message).toBe("secured");
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
    row("locked folder: the socket opens and answers", "yes");
    row("cost at start: the folder's checks (before listening)", `${prepareMs.toFixed(2)} ms`);
    row("cost at start: the socket file's check (after listening)", `${secureMs.toFixed(2)} ms`);
    if (server !== undefined) servers.splice(servers.indexOf(server), 1);
    expect((await server?.close())?.isOk()).toBe(true);
    expect(existsSync(socket)).toBe(false);
  });

  test("an ordinary folder, its list inherited: closed by the hub with what it held, warned, opens", async () => {
    const folder = join(BASE, "open", "data");
    ordinaryFolder(folder);
    writeFileSync(join(folder, "hub.db"), "made before the hub closed the folder");
    expect(listNow(folder, true)).toContain("inheritance is on");
    expect(listNow(join(folder, "hub.db"), false)).not.toBe("closed");
    warnings.splice(0);
    const socket = join(folder, "control.sock");
    const { server, message } = await open(socket);
    row("ordinary folder: the hub", message);
    row("ordinary folder: the warning", warnings.map((w) => w.message).join(" / "));
    expect(message).toBe("opened");
    expect(warnings.map((w) => [w.code, w.detail.closed])).toEqual([
      ["data_folder_was_open", true],
    ]);
    expect(listNow(folder, true)).toBe("closed");
    const inside = listNow(join(folder, "hub.db"), false);
    row("ordinary folder: a file made inside before, its list after", inside);
    expect(inside).toBe("closed");
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
  });

  test("a locked folder that also grants Users: closed by the hub, warned, opens", async () => {
    const folder = join(BASE, "users");
    expect(lockFolder(folder, ["S-1-5-32-545"]).code).toBe(0);
    warnings.splice(0);
    const { message } = await open(join(folder, "control.sock"));
    row("locked folder plus Users: the hub", message);
    expect(message).toBe("opened");
    expect(warnings[0]?.message).toContain("it lets in Users (S-1-5-32-545)");
    expect(listNow(folder, true)).toBe("closed");
  });

  test("a junction inside an open folder: refused, and neither the folder nor the junction's target is changed", async () => {
    const folder = join(BASE, "inside");
    const target = join(BASE, "target");
    ordinaryFolder(folder);
    ordinaryFolder(target);
    expect(junction(join(folder, "keys"), target).code).toBe(0);
    const folderBefore = listNow(folder, true);
    const targetBefore = listNow(target, true);
    warnings.splice(0);
    const { message } = await open(join(folder, "control.sock"));
    row("junction inside an open folder: refused with", message);
    expect(message).toContain("inside the data folder, is a link");
    expect(warnings[0]?.detail.closed).toBe(false);
    expect(listNow(folder, true)).toBe(folderBefore);
    expect(listNow(target, true)).toBe(targetBefore);
  });

  test("a locked folder with a deny entry: opens", async () => {
    const folder = join(BASE, "deny");
    expect(lockFolder(folder).code).toBe(0);
    expect(icacls(folder, "/deny", "*S-1-5-32-545:(OI)(CI)(W)").code).toBe(0);
    const { message } = await open(join(folder, "control.sock"));
    row("locked folder plus a deny entry for Users", message);
    expect(message).toBe("opened");
  });

  test("a junction above the data folder, or as it: refused, never followed, nothing set", async () => {
    const real = join(BASE, "real");
    // Open targets: were a link followed, the hub would close them.
    ordinaryFolder(join(real, "data"));
    ordinaryFolder(join(real, "data2"));
    const before = [listNow(join(real, "data"), true), listNow(join(real, "data2"), true)];
    warnings.splice(0);
    expect(junction(join(BASE, "link"), real).code).toBe(0);
    expect(junction(join(BASE, "linkdata"), join(real, "data2")).code).toBe(0);
    const above = await open(join(BASE, "link", "data", "control.sock"));
    row("junction above the data folder: refused with", above.message);
    expect(above.message).toContain("above the data folder, is a link");
    const itself = await open(join(BASE, "linkdata", "control.sock"));
    row("junction as the data folder: refused with", itself.message);
    expect(itself.message).toContain("the data folder is a link");
    expect([listNow(join(real, "data"), true), listNow(join(real, "data2"), true)]).toEqual(before);
    expect(warnings).toEqual([]);
  });

  test("an old socket file left by a killed process is removed and replaced", async () => {
    const folder = join(BASE, "stale");
    expect(lockFolder(folder).code).toBe(0);
    const socket = join(folder, "control.sock");
    const script = `require("net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`;
    spawnSync(process.execPath, ["-e", script]);
    const left = existsSync(socket);
    row("a killed process leaves its socket file", left ? "yes" : "no");
    const { server, message } = await open(socket);
    expect(message).toBe("opened");
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
    row("an old socket file: the next hub opens and answers", "yes");
  });

  test("a running hub's socket is not taken over; a file at the path is refused and left", async () => {
    const folder = join(BASE, "running");
    expect(lockFolder(folder).code).toBe(0);
    const socket = join(folder, "control.sock");
    expect((await open(socket)).message).toBe("opened");
    const second = await windowsSocketSteps(WINDOWS_CALLS, warn).prepare(socket);
    expect(second.isErr() ? second.error.message : "taken").toBe(
      "another hub is running on this socket",
    );
    const other = join(BASE, "file");
    expect(lockFolder(other).code).toBe(0);
    writeFileSync(join(other, "control.sock"), "not a socket");
    const refused = await open(join(other, "control.sock"));
    expect(refused.message).toBe("something that is not a socket is at the socket's path");
    expect(existsSync(join(other, "control.sock"))).toBe(true);
  });
});
