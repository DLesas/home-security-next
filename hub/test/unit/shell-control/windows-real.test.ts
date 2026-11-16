/**
 * The control socket's Windows steps against Windows itself (run by
 * `.github/workflows/windows-control-socket.yml` on a hosted runner; skipped elsewhere): real
 * access lists set with `icacls`, read back by the hub's own Win32 calls, and the real server
 * opened, its top folder closed, or refused. The runner's account is an elevated administrator,
 * so these are an administrator's runs of the hub (m2-design.md section 9, "The top folders"):
 * a folder of the installer's shape opens as it is; an open one has its shape set on the folder
 * alone, its contents left as they were (and a junction inside never followed); a deny entry
 * passes; a junction in the path is refused with nothing set on either side; the socket file is
 * owned by Administrators; an old socket is replaced. The service's runs are in
 * `windows-hub.test.ts`, as a stand-in account. A FAT volume and a network drive cannot be made
 * on the runner; those stay shown as data only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ok } from "neverthrow";
import { UnixControlServer } from "../../../src/shell/control/server.ts";
import {
  type ControlWarning,
  createTopFolderIfMissing,
  windowsSocketSteps,
} from "../../../src/shell/control/windows.ts";
import {
  ADMINISTRATORS_SID,
  HUB_SERVICE_SID,
  parseDescriptor,
} from "../../../src/shell/control/windows-acl.ts";
import { WINDOWS_CALLS } from "../../../src/shell/safe/control-socket-windows.ts";
import { RawClient } from "./support.ts";
import {
  isWindows,
  junction,
  listVerdict,
  lockFolderTo,
  ordinaryFolder,
  removeTree,
  made,
  shapeFolder,
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

/** The rule's verdict on a top folder, judged as the service would (the strict shape). */
const topNow = (path: string): string => listVerdict(path, { top: true, mode: "service" });
/** The rule's verdict on something inside. */
const insideNow = (path: string): string => listVerdict(path, { top: false });

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
    row("cleanup: the test's folders", removeTree(BASE));
  }
});

describe.skipIf(!isWindows)("Windows itself, an administrator's run: real access lists", () => {
  test("a folder of the installer's shape, made from its SDDL by Windows: the rule reads it as the shape, it opens, answers, its socket owned by Administrators", async () => {
    const folder = join(BASE, "shaped");
    const shaped = made(shapeFolder(folder));
    row("Windows' SDDL converter makes the installer's shape", shaped);
    expect(shaped).toBe("made");
    const verdict = topNow(folder);
    row("the hub's rule on the icacls-made shape", verdict);
    expect(verdict).toBe("closed");
    const socket = join(folder, "control.sock");
    const steps = windowsSocketSteps(WINDOWS_CALLS, { warn });
    const t0 = performance.now();
    const prepared = await steps.prepare(socket);
    const prepareMs = performance.now() - t0;
    expect(prepared.isOk() ? "prepared" : prepared.error.message).toBe("prepared");
    warnings.splice(0);
    const { server, message } = await open(socket);
    expect(message).toBe("opened");
    expect(warnings).toEqual([]);
    const t1 = performance.now();
    const secured = steps.secure(socket);
    const secureMs = performance.now() - t1;
    expect(secured.isOk() ? "secured" : secured.error.message).toBe("secured");
    const owner = parseDescriptor(
      WINDOWS_CALLS.securityDescriptor(socket)._unsafeUnwrap(),
    )._unsafeUnwrap().owner;
    row("an administrator's run: the socket file's owner", owner ?? "(none)");
    expect(owner).toBe(ADMINISTRATORS_SID);
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
    row("cost at start: the folder's checks (before listening)", `${prepareMs.toFixed(2)} ms`);
    row("cost at start: the socket file's check (after listening)", `${secureMs.toFixed(2)} ms`);
    if (server !== undefined) servers.splice(servers.indexOf(server), 1);
    expect((await server?.close())?.isOk()).toBe(true);
    expect(existsSync(socket)).toBe(false);
  });

  test("a folder for Administrators and SYSTEM alone (no service yet): opens as it is", async () => {
    const folder = join(BASE, "admins");
    expect(lockFolderTo(folder, [ADMINISTRATORS_SID, "S-1-5-18"]).code).toBe(0);
    warnings.splice(0);
    const { message } = await open(join(folder, "control.sock"));
    row("Administrators and SYSTEM alone, by hand", message);
    expect(message).toBe("opened");
    expect(warnings).toEqual([]);
  });

  test("an ordinary folder: its shape set on the folder alone, data_folder_was_open; a file inside left as it was", async () => {
    const folder = join(BASE, "open", "data");
    ordinaryFolder(folder);
    writeFileSync(join(folder, "hub.db"), "made before the hub closed the folder");
    const before = [topNow(folder), insideNow(join(folder, "hub.db"))];
    row("ordinary folder before: the folder, a file inside", before.join(" / "));
    expect(before[0]).toContain("inheritance is on");
    expect(before[1]).not.toBe("closed");
    warnings.splice(0);
    const socket = join(folder, "control.sock");
    const { server, message } = await open(socket);
    row("ordinary folder: an administrator's run", message);
    row("ordinary folder: the warning", warnings.map((w) => `${w.code}: ${w.message}`).join(" / "));
    const after = [topNow(folder), insideNow(join(folder, "hub.db"))];
    row(
      "ordinary folder after: the folder, the file inside (left for the service)",
      after.join(" / "),
    );
    expect(message).toBe("opened");
    expect(warnings.map((w) => [w.code, w.detail.closed])).toEqual([
      ["data_folder_was_open", true],
    ]);
    expect(after[0]).toBe("closed");
    // SetKernelObjectSecurity sets the folder alone: what was inside is not touched.
    expect(after[1]).toBe(before[1]);
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
  });

  test("the shape with Users added: closed by the run, Users gone", async () => {
    const folder = join(BASE, "users");
    expect(made(shapeFolder(folder, HUB_SERVICE_SID, ["(A;OICI;0x1200a9;;;BU)"]))).toBe("made");
    expect(topNow(folder)).toContain("it lets in Users (S-1-5-32-545)");
    warnings.splice(0);
    const { message } = await open(join(folder, "control.sock"));
    row("the shape plus Users: an administrator's run", message);
    expect(message).toBe("opened");
    expect(warnings[0]?.message).toContain("it lets in Users (S-1-5-32-545)");
    expect(topNow(folder)).toBe("closed");
  });

  test("the shape with a deny entry: opens as it is", async () => {
    const folder = join(BASE, "deny");
    // A deny entry for Guests: accepted by the rule, and it denies the runner nothing.
    expect(made(shapeFolder(folder, HUB_SERVICE_SID, ["(D;OICI;FA;;;BG)"]))).toBe("made");
    warnings.splice(0);
    const { message } = await open(join(folder, "control.sock"));
    row("the shape plus a deny entry for Guests", message);
    expect(message).toBe("opened");
    expect(warnings).toEqual([]);
  });

  test("a junction inside an open folder: the folder closed, the junction's target never changed", async () => {
    const folder = join(BASE, "inside");
    const target = join(BASE, "target");
    ordinaryFolder(folder);
    ordinaryFolder(target);
    expect(junction(join(folder, "keys"), target).code).toBe(0);
    const targetBefore = topNow(target);
    const { message } = await open(join(folder, "control.sock"));
    row("junction inside an open folder: an administrator's run", message);
    expect(message).toBe("opened");
    expect(topNow(folder)).toBe("closed");
    expect(topNow(target)).toBe(targetBefore);
  });

  test("a junction above the top folder, or as it: refused, never followed, nothing set", async () => {
    const real = join(BASE, "real");
    ordinaryFolder(join(real, "data"));
    ordinaryFolder(join(real, "data2"));
    const before = [topNow(join(real, "data")), topNow(join(real, "data2"))];
    warnings.splice(0);
    expect(junction(join(BASE, "link"), real).code).toBe(0);
    expect(junction(join(BASE, "linkdata"), join(real, "data2")).code).toBe(0);
    const above = await open(join(BASE, "link", "data", "control.sock"));
    row("junction above the top folder: refused with", above.message);
    expect(above.message).toContain(", is a link");
    const itself = await open(join(BASE, "linkdata", "control.sock"));
    row("junction as the top folder: refused with", itself.message);
    expect(itself.message).toContain("is a link (a reparse point");
    expect([topNow(join(real, "data")), topNow(join(real, "data2"))]).toEqual(before);
    expect(warnings).toEqual([]);
  });

  test("a top folder the run makes itself has the shape from its first moment, and what is made inside inherits it", () => {
    const folder = join(BASE, "made-by-hand");
    const made = createTopFolderIfMissing(folder, WINDOWS_CALLS);
    row("a folder made by an administrator's run", made.isOk() ? made.value : made.error.message);
    expect(made.isOk() ? made.value : made.error.message).toBe("made");
    expect(topNow(folder)).toBe("closed");
    writeFileSync(join(folder, "hub.db"), "made after");
    const inside = insideNow(join(folder, "hub.db"));
    row("a file made inside it afterwards, by the rule", inside);
    expect(inside).toBe("closed");
    const again = createTopFolderIfMissing(folder, WINDOWS_CALLS);
    expect(again.isOk() ? again.value : again.error.message).toBe("there");
  });

  test("an old socket file left by a killed process is removed and replaced", async () => {
    const folder = join(BASE, "stale");
    expect(made(shapeFolder(folder))).toBe("made");
    const socket = join(folder, "control.sock");
    const script = `require("net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`;
    spawnSync(process.execPath, ["-e", script]);
    row("a killed process leaves its socket file", existsSync(socket) ? "yes" : "no");
    const { server, message } = await open(socket);
    expect(message).toBe("opened");
    expect(server === undefined ? false : await answered(server, socket)).toBe(true);
  });

  test("a running hub's socket is not taken over; a file at the path is refused and left", async () => {
    const folder = join(BASE, "running");
    expect(made(shapeFolder(folder))).toBe("made");
    const socket = join(folder, "control.sock");
    expect((await open(socket)).message).toBe("opened");
    const second = await windowsSocketSteps(WINDOWS_CALLS, { warn }).prepare(socket);
    expect(second.isErr() ? second.error.message : "taken").toBe(
      "another hub is running on this socket",
    );
    const other = join(BASE, "file");
    expect(made(shapeFolder(other))).toBe("made");
    writeFileSync(join(other, "control.sock"), "not a socket");
    const refused = await open(join(other, "control.sock"));
    expect(refused.message).toBe("something that is not a socket is at the socket's path");
    expect(existsSync(join(other, "control.sock"))).toBe(true);
  });
});
