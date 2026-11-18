/**
 * The Windows peer check at `hsn`'s call sites (m2-design.md section 9, "The Windows peer check,
 * and what protects the socket"): before anything is sent, the socket must be served by the hub's
 * account (`CliIo.hubAccount`); another account is refused with exit 77, naming it and its
 * process, escaped; "cannot tell" is refused too; off Windows the check is never asked.
 */
import { describe, expect, test } from "bun:test";
import { err, ok } from "neverthrow";
import { type CliIo, runCli } from "../../../cli/main.ts";
import { ExitCode } from "../../../cli/exit-codes.ts";
import type { PeerRefusal, SocketPeer } from "../../../src/shell/safe/control-socket-peer.ts";

const HUB = "S-1-5-80-1111";
const OTHER = "S-1-5-21-2222\u001b[31m";

function io(
  platform: NodeJS.Platform,
  answer: (path: string, expected: string) => ReturnType<NonNullable<CliIo["checkPeer"]>>,
): { readonly io: CliIo; readonly err: string[]; readonly asked: string[] } {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    err: said,
    asked,
    io: {
      out: () => undefined,
      err: (line) => said.push(line),
      env: {},
      stdin: () => Promise.resolve(""),
      nowMs: () => 0,
      onInterrupt: () => undefined,
      ask: () => Promise.resolve(""),
      platform,
      hubAccount: HUB,
      checkPeer: (path, expected) => {
        asked.push(path);
        return answer(path, expected);
      },
    },
  };
}

const SOCKET = ["--socket", "/tmp/hsn-peer-test-none.sock", "status"];
const served = (sid: string) => (): ReturnType<NonNullable<CliIo["checkPeer"]>> =>
  sid === HUB
    ? ok<SocketPeer, PeerRefusal>({ pid: 4242, sid })
    : err<SocketPeer, PeerRefusal>({ kind: "notTheHub", peer: { pid: 4242, sid }, expected: HUB });

describe("hsn checks who serves the socket on Windows (section 9)", () => {
  test("served by the hub's account: it goes on (here to a socket that is not there)", async () => {
    const t = io("win32", served(HUB));
    expect(await runCli(SOCKET, t.io)).toBe(ExitCode.HubNotRunning);
    expect(t.asked).toEqual(["/tmp/hsn-peer-test-none.sock"]);
  });

  test("served by another account: 77, the account and its process named, escaped; nothing sent", async () => {
    const t = io("win32", served(OTHER));
    expect(await runCli(SOCKET, t.io)).toBe(ExitCode.NoPermission);
    const said = t.err.join("\n");
    expect(said).toContain("process 4242");
    expect(said).toContain("S-1-5-21-2222");
    expect(said).toContain(HUB);
    // The account's text came from the system: no control character reaches the terminal.
    expect(said.includes("\u001b")).toBe(false);
  });

  test("cannot tell: refused", async () => {
    const t = io("win32", () =>
      err<SocketPeer, PeerRefusal>({
        kind: "cannotTell",
        error: { kind: "link", origin: "test", message: "WSAIoctl failed" },
      }),
    );
    expect(await runCli(SOCKET, t.io)).toBe(ExitCode.NoPermission);
    expect(t.err.join("\n")).toContain("cannot tell who serves the hub's socket");
  });

  test("off Windows the check is never asked", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      const t = io(platform, served(OTHER));
      expect(await runCli(SOCKET, t.io)).toBe(ExitCode.HubNotRunning);
      expect(t.asked).toEqual([]);
    }
  });

  test("the file commands are checked too, before their own connection", async () => {
    const t = io("win32", served(OTHER));
    const code = await runCli(
      ["--socket", "/tmp/hsn-peer-test-none.sock", "backup", "export", "/tmp/hsn-peer-x.hsnb"],
      t.io,
    );
    expect(code).toBe(ExitCode.NoPermission);
    expect(t.asked).toHaveLength(1);
  });

  test("nothing serving it: answered as a hub that is not running, 69", async () => {
    const t = io("win32", () =>
      err<SocketPeer, PeerRefusal>({
        kind: "notRunning",
        error: { kind: "internal", origin: "test", message: "10061" },
      }),
    );
    expect(await runCli(SOCKET, t.io)).toBe(ExitCode.HubNotRunning);
    expect(t.err).toEqual([
      "hsn: the hub is not running: no hub is listening on /tmp/hsn-peer-test-none.sock.",
      "Start the hub, or pass --data <folder> if it runs with another data folder.",
    ]);
  });

  test("this account kept out: answered as a kept-out account, 77, with the administrator prompt", async () => {
    const t = io("win32", () =>
      err<SocketPeer, PeerRefusal>({
        kind: "notAllowed",
        error: { kind: "internal", origin: "test", message: "10013" },
      }),
    );
    expect(await runCli(SOCKET, t.io)).toBe(ExitCode.NoPermission);
    expect(t.err).toEqual([
      "hsn: this account may not use the hub: run hsn from an administrator prompt (Run as administrator).",
    ]);
  });
});
