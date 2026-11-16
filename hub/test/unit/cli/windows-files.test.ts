/**
 * `hsn.exe` elevated on Windows (m2-design.md section 9, "The privilege boundary"), with A11's
 * calls injected: elevated or unable to tell takes the strict path; a named file is read by its
 * handle and refused with its own message for each kind of refusal; an export is finished only
 * after `hsn`'s own hash check and abandoned on every other path; a folder the service account
 * could also write gets A11's warning, printed once, and the export completes (D124).
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { err, ok } from "neverthrow";
import type { Session } from "../../../cli/client.ts";
import { runFileCommand } from "../../../cli/files.ts";
import {
  isStrict,
  windowsElevatedEnv,
  windowsFiles,
  type WindowsFileCalls,
} from "../../../cli/windows-files.ts";
import { type CliIo, runCli } from "../../../cli/main.ts";
import { dataFolder, socketPath, WINDOWS_DATA_FOLDER } from "../../../cli/paths.ts";
import type { PeerRefusal, SocketPeer } from "../../../src/shell/safe/control-socket-peer.ts";
import type {
  ExportFile,
  NamedFileReader,
  NamedFileRefusal,
} from "../../../src/shell/safe/control-socket-hsn.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const KINDS: readonly NamedFileRefusal["kind"][] = [
  "reparsePoint",
  "insideHubTree",
  "notAFile",
  "failed",
];

function reader(bytes: Uint8Array): NamedFileReader & { closed: number } {
  let at = 0;
  return {
    closed: 0,
    finalPath: "C:\\Users\\anna\\r.hsnr",
    size: bytes.length,
    read(into) {
      const n = Math.min(into.length, bytes.length - at);
      into.set(bytes.subarray(at, at + n));
      at += n;
      return ok(n);
    },
    close() {
      this.closed += 1;
    },
  };
}

function exportFile(
  options: { failWrite?: boolean; failFinish?: boolean; warning?: string } = {},
): ExportFile & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    folder: "C:\\Users\\anna\\Documents",
    serviceMayWrite: options.warning === undefined ? [] : ["Users may create files"],
    warning: options.warning,
    write: (bytes) => {
      log.push(`write ${String(bytes.length)}`);
      return options.failWrite === true
        ? err({ kind: "internal", origin: "test", message: "disk full" })
        : ok(undefined);
    },
    finish: () => {
      log.push("finish");
      return options.failFinish === true
        ? err({ kind: "internal", origin: "test", message: "rename refused" })
        : ok(undefined);
    },
    abandon: () => {
      log.push("abandon");
    },
  };
}

const refusing = (kind: NamedFileRefusal["kind"]): WindowsFileCalls => ({
  open: () => err({ kind, message: "from Windows" }),
  begin: () => err({ kind, message: "from Windows" }),
});

describe("hsn.exe elevated on Windows (section 9)", () => {
  test("elevated, or Windows cannot tell: the strict path; not elevated: the ordinary one", () => {
    expect(isStrict({ kind: "elevated" })).toBe(true);
    expect(
      isStrict({ kind: "cannotTell", error: { kind: "internal", origin: "t", message: "x" } }),
    ).toBe(true);
    expect(isStrict({ kind: "notElevated" })).toBe(false);
    expect(windowsElevatedEnv({ USERNAME: "anna", HSN_DATA_DIR: "D:\\planted" })).toEqual({
      HSN_DATA_DIR: "C:\\ProgramData\\HSN Hub",
      USER: "anna",
    });
  });

  test("a file read by its handle, closed; the hub's trees passed for the check", async () => {
    const asked: (readonly string[])[] = [];
    const r = reader(new TextEncoder().encode("a release"));
    const files = windowsFiles({
      open: (_path, trees) => {
        asked.push(trees);
        return ok(r);
      },
      begin: () => err({ kind: "failed", message: "unused" }),
    });
    const read = await files.read("C:\\Users\\anna\\r.hsnr");
    expect(new TextDecoder().decode(read._unsafeUnwrap())).toBe("a release");
    expect(r.closed).toBe(1);
    expect(asked).toEqual([["C:\\ProgramData\\HSN Hub", "C:\\ProgramData\\HSN Hub Program"]]);
  });

  test("each refusal has its own message, saying what to do; the command refuses with it", async () => {
    const said = new Map<string, string>();
    for (const kind of KINDS) {
      const files = windowsFiles(refusing(kind));
      const failed = await runFileCommand(
        { kind: "updateInstall", path: "C:\\x\\r.hsnr" },
        {} as unknown as Session,
        "anna",
        { out: () => undefined, ask: () => Promise.resolve(""), nowMs: () => 0, files },
        1000,
        () => [],
      );
      const error = failed._unsafeUnwrapErr();
      expect([kind, error.kind]).toEqual([kind, "file"]);
      said.set(kind, error.kind === "file" ? error.message : "");
    }
    expect(said.get("reparsePoint")).toContain("name the file itself");
    expect(said.get("insideHubTree")).toContain("the hub's own folders");
    expect(said.get("notAFile")).toContain("not a file");
    expect(said.get("failed")).toContain("from Windows");
    for (const kind of ["reparsePoint", "insideHubTree", "notAFile"] as const) {
      const writing = await windowsFiles(refusing(kind)).write(
        "C:\\x\\b.hsnb",
        new Uint8Array(1),
        sha(new Uint8Array(1)),
      );
      expect(writing._unsafeUnwrapErr()).toBe(said.get(kind)?.replace("r.hsnr", "b.hsnb") ?? "");
    }
    expect(new Set(said.values()).size).toBe(KINDS.length);
  });

  test("a folder the service account could also write: warned once, through the guarded io, and exported", async () => {
    const bytes = new TextEncoder().encode("a backup");
    const shared = exportFile({
      warning: "the hub's service account can also write in C:\\Shared",
    });
    const files = windowsFiles({
      open: () => err({ kind: "failed", message: "unused" }),
      begin: () => ok(shared),
    });
    // The hub's side: the reply, then one chunk carrying the end mark (section 6).
    const session = {
      request: (
        _actor: string,
        _request: unknown,
        _upload: unknown,
        on: { onChunk: (chunk: unknown) => void },
      ) => {
        on.onChunk({
          n: 0,
          data: Buffer.from(bytes).toString("base64url"),
          end: { chunks: 1, sha256: sha(bytes) },
        });
        return Promise.resolve(
          ok({ reply: { ok: true, result: { kind: "op", body: { job: "j1" } } } }),
        );
      },
    } as unknown as Session;
    const lines: string[] = [];
    const exported = await runFileCommand(
      { kind: "backupExport", path: "C:\\Shared\\b.hsnb", history: false },
      session,
      "anna",
      { out: (line) => lines.push(line), ask: () => Promise.resolve(""), nowMs: () => 0, files },
      1000,
      () => [],
    );
    expect(exported._unsafeUnwrap()).toEqual([
      `exported ${String(bytes.length)} bytes to C:\\Shared\\b.hsnb`,
    ]);
    expect(lines).toEqual(["the hub's service account can also write in C:\\Shared"]);
    expect(shared.log.slice(-2)).toEqual([`write ${String(bytes.length)}`, "finish"]);
  });

  test("an export is finished only after the hash check, and abandoned on every other path", async () => {
    const bytes = new TextEncoder().encode("a backup");
    const good = exportFile();
    const files = (file: ExportFile) =>
      windowsFiles({
        open: () => err({ kind: "failed", message: "unused" }),
        begin: () => ok(file),
      });
    expect((await files(good).write("C:\\Users\\anna\\b.hsnb", bytes, sha(bytes))).isOk()).toBe(
      true,
    );
    expect(good.log).toEqual([`write ${String(bytes.length)}`, "finish"]);
    const wrongHash = exportFile();
    expect((await files(wrongHash).write("C:\\b.hsnb", bytes, "00".repeat(32))).isErr()).toBe(true);
    expect(wrongHash.log).toEqual([`write ${String(bytes.length)}`, "abandon"]);
    const failedWrite = exportFile({ failWrite: true });
    expect((await files(failedWrite).write("C:\\b.hsnb", bytes, sha(bytes))).isErr()).toBe(true);
    expect(failedWrite.log).toEqual([`write ${String(bytes.length)}`, "abandon"]);
    const failedFinish = exportFile({ failFinish: true });
    expect((await files(failedFinish).write("C:\\b.hsnb", bytes, sha(bytes))).isErr()).toBe(true);
    expect(failedFinish.log).toEqual([`write ${String(bytes.length)}`, "finish", "abandon"]);
  });

  test("elevated, or cannot tell: an explicit --data, else the fixed folder; HSN_DATA_DIR ignored", () => {
    const env = { HSN_DATA_DIR: "D:\\planted", USERPROFILE: "C:\\Users\\anna" };
    expect(dataFolder(undefined, env, { strict: true })).toBe("C:\\ProgramData\\HSN Hub");
    expect(dataFolder(undefined, {}, { strict: true })).toBe(WINDOWS_DATA_FOLDER);
    expect(dataFolder("D:\\tests", env, { strict: true })).toBe("D:\\tests");
  });

  test("not elevated: the flag or HSN_DATA_DIR when given, else the same fixed folder, never the person's", () => {
    const env = { USERPROFILE: "C:\\Users\\anna", HOME: "C:\\Users\\anna" };
    expect(dataFolder(undefined, env, { strict: false })).toBe(WINDOWS_DATA_FOLDER);
    expect(dataFolder("D:\\dev", env, { strict: false })).toBe("D:\\dev");
    expect(dataFolder(undefined, { ...env, HSN_DATA_DIR: "D:\\hub" }, { strict: false })).toBe(
      "D:\\hub",
    );
  });

  test("hsn status elevated on an installed hub asks at the fixed folder's socket", async () => {
    const asked: string[] = [];
    const run = (windowsStrict: boolean): CliIo => ({
      out: () => undefined,
      err: () => undefined,
      env: { HSN_DATA_DIR: "D:\\planted", USERPROFILE: "C:\\Users\\anna" },
      stdin: () => Promise.resolve(""),
      nowMs: () => 0,
      onInterrupt: () => undefined,
      ask: () => Promise.resolve(""),
      platform: "win32",
      hubAccount: "S-1-5-80-1111",
      windowsStrict,
      checkPeer: (path) => {
        asked.push(path);
        return err<SocketPeer, PeerRefusal>({
          kind: "cannotTell",
          error: { kind: "internal", origin: "test", message: "stop here" },
        });
      },
    });
    await runCli(["status"], run(true));
    await runCli(["status"], { ...run(false), env: { USERPROFILE: "C:\\Users\\anna" } });
    expect(asked).toEqual([socketPath(WINDOWS_DATA_FOLDER), socketPath(WINDOWS_DATA_FOLDER)]);
  });
});
