/**
 * What `hsn` makes of a connect that fails (hub-design.md section 9; m2-design.md section 9,
 * Windows): on Windows an account the data folder's access list keeps out is told a code that
 * otherwise means "no hub is listening", so there the data folder is listed: refused (EACCES or
 * EPERM) is "this account may not use the hub", exit 77, run from an administrator prompt; listed,
 * missing or another error stays "not running", exit 69. macOS and Linux are as before. Every
 * not-running code is crossed with every listing, on Windows and off it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectFailure, exchange, folderOf, Session } from "../../../cli/client.ts";
import { type FolderListing, listFolder, listingOf } from "../../../cli/files.ts";
import { type CliIo, runCli } from "../../../cli/main.ts";
import { ExitCode } from "../../../cli/exit-codes.ts";

const NOT_RUNNING = ["ENOENT", "ECONNREFUSED", "ENOTSOCK", "ENOTDIR"] as const;
const LISTINGS: readonly FolderListing[] = ["listed", "refused", "missing", "other"];
const SOCKET = "C:\\ProgramData\\HSN Hub\\control.sock";
const folders: string[] = [];

afterEach(() => {
  const all = folders.splice(0);
  for (const folder of all) chmodSync(folder, 0o700);
  for (const folder of all.reverse()) rmSync(folder, { recursive: true, force: true });
});

describe("the decision, every not-running code crossed with every listing", () => {
  const rows = ["win32", "darwin", "linux"].flatMap((platform) =>
    NOT_RUNNING.flatMap((code) => LISTINGS.map((listing) => [platform, code, listing] as const)),
  );
  test.each(rows)("%s, %s, folder %s", (platform, code, listing) => {
    const asked: string[] = [];
    const failure = connectFailure(code, SOCKET, {
      platform,
      listFolder: (path) => {
        asked.push(path);
        return listing;
      },
    });
    const refused = platform === "win32" && listing === "refused";
    expect(failure.kind).toBe(refused ? "permission" : "notRunning");
    // The folder is looked at only on Windows, and it is the socket's own.
    expect(asked).toEqual(platform === "win32" ? ["C:\\ProgramData\\HSN Hub"] : []);
  });

  test.each(["win32", "darwin", "linux"])(
    "%s: a permission code is a refusal, without listing",
    (platform) => {
      for (const code of ["EACCES", "EPERM"]) {
        expect(connectFailure(code, SOCKET, { platform, listFolder: () => "listed" }).kind).toBe(
          "permission",
        );
      }
    },
  );

  test.each(["win32", "darwin"])("%s: another code is neither", (platform) => {
    expect(
      connectFailure("ETIMEDOUT", SOCKET, { platform, listFolder: () => "refused" }).kind,
    ).toBe("closed");
  });

  test("the socket's folder, on either kind of path", () => {
    expect(folderOf("C:\\ProgramData\\HSN Hub\\control.sock")).toBe("C:\\ProgramData\\HSN Hub");
    expect(folderOf("/var/lib/hsn-hub/control.sock")).toBe("/var/lib/hsn-hub");
  });
});

describe("what a listing's error says", () => {
  test.each([
    ["EACCES", { code: "EACCES" }, "refused"],
    ["EPERM, as Windows reports access denied", { code: "EPERM" }, "refused"],
    ["ENOENT", { code: "ENOENT" }, "missing"],
    ["another code", { code: "EIO" }, "other"],
    ["no code", new Error("x"), "other"],
    ["a code that is not text", { code: 13 }, "other"],
    ["a thrown value that is not an object", "EPERM", "other"],
    ["null", null, "other"],
  ] as const)("%s", (_what, thrown, listing) => {
    expect(listingOf(thrown)).toBe(listing);
  });
});

describe("listing a folder, on this computer", () => {
  test("listed, missing, and refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hsn-a2-list-"));
    folders.push(dir);
    expect(listFolder(dir)).toBe("listed");
    expect(listFolder(join(dir, "none"))).toBe("missing");
    const shut = join(dir, "shut");
    mkdirSync(shut);
    chmodSync(shut, 0o000);
    folders.push(shut);
    if (process.geteuid?.() !== 0) expect(listFolder(shut)).toBe("refused");
  });
});

describe("hsn's answer", () => {
  function io(platform: NodeJS.Platform) {
    const err: string[] = [];
    const value: CliIo = {
      out: () => undefined,
      err: (line) => err.push(line),
      env: { USER: "anna" },
      stdin: () => Promise.resolve(""),
      nowMs: () => 0,
      onInterrupt: () => undefined,
      ask: () => Promise.resolve("n"),
      platform,
    };
    return { value, err };
  }

  test("a connection with nothing at the socket, the folder refused, on Windows: 77, an administrator prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hsn-a2-sock-"));
    folders.push(dir);
    const path = join(dir, "control.sock");
    const context = { platform: "win32", listFolder: () => "refused" as const };
    const viaExchange = await exchange(
      path,
      { id: 1, actor: "a", command: { kind: "status" } },
      2000,
      undefined,
      undefined,
      context,
    );
    expect(viaExchange.isErr() ? viaExchange.error.kind : "").toBe("permission");
    const viaSession = await Session.open(path, context);
    expect(viaSession.isErr() ? viaSession.error.kind : "").toBe("permission");
    const viaListed = await Session.open(path, { platform: "win32", listFolder: () => "listed" });
    expect(viaListed.isErr() ? viaListed.error.kind : "").toBe("notRunning");
  });

  test("off Windows, the same failure is 69, as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hsn-a2-sock-"));
    folders.push(dir);
    const run = io("darwin");
    const code = await runCli(["--socket", join(dir, "control.sock"), "status"], run.value);
    expect(code).toBe(ExitCode.HubNotRunning);
  });

  test("the words for 77 on Windows", async () => {
    const { clientFailure } = await import("../../../cli/main.ts");
    const run = io("win32");
    const code = clientFailure(
      { kind: "permission", message: `this account may not use the hub at ${SOCKET}` },
      run.value,
    );
    expect(code).toBe(ExitCode.NoPermission);
    expect(run.err[0]).toBe(
      `hsn: this account may not use the hub at ${SOCKET}: run hsn from an administrator prompt (Run as administrator).`,
    );
    expect(run.err[0]).toContain("administrator prompt");
  });
});
