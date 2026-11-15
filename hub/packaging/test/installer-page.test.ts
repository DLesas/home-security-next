/**
 * The Windows installer's first opening (`shared/installer-page.ts`), against a stand-in control
 * socket: an installer's console token asked for, the folder closed before the page is written
 * (on Windows by `icacls` for the user's SID, SYSTEM and Administrators; elsewhere 0700), the page
 * A2's, holding the address, and the token on no command line: the arguments hold only the
 * folder and the SID.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pageHtml } from "../../cli/console-page.ts";
import {
  parseInstallerPageArgs,
  SETUP_PAGE,
  writeInstallerPage,
} from "../shared/installer-page.ts";

const URL = "http://127.0.0.1:8445/#console=c2VjcmV0LXRva2Vu";
const folders: string[] = [];
const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

/** A control socket that answers one console token, and keeps what it was asked. */
async function hub(): Promise<{ data: string; asked: unknown[] }> {
  const data = mkdtempSync(join(tmpdir(), "hsn-ip-"));
  folders.push(data);
  const asked: unknown[] = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (line: string) => {
      asked.push(JSON.parse(line.trim()));
      socket.write(
        `${JSON.stringify({ id: 1, reply: { ok: true, result: { kind: "consoleToken", url: URL, expiresInMs: 600_000, token: 5 } } })}\n`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(join(data, "control.sock"), resolve));
  return { data, asked };
}

describe("the installer's page", () => {
  test("an installer's token, the folder closed first, A2's page with the address", async () => {
    const { data, asked } = await hub();
    const folder = join(data, "user", "HSN Hub");
    const written = await writeInstallerPage({ dataDir: data, sid: "S-1-5-21-1-2-3-1001", folder });
    expect(written.isOk() ? written.value : written.error).toBe(join(folder, SETUP_PAGE));
    expect(asked).toEqual([
      { id: 1, actor: "installer", command: { kind: "consoleToken", for: "installer" } },
    ]);
    expect(readFileSync(join(folder, SETUP_PAGE), "utf8")).toBe(pageHtml(URL));
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, SETUP_PAGE)).mode & 0o077).toBe(0);
  });

  test("on Windows the access list is set for the user, SYSTEM and Administrators before the page", async () => {
    const { data } = await hub();
    const folder = join(data, "win", "HSN Hub");
    const ran: string[][] = [];
    const written = await writeInstallerPage({
      dataDir: data,
      sid: "S-1-5-21-1-2-3-1001",
      folder,
      platform: "win32",
      run: (argv) => {
        ran.push([...argv]);
        return 0;
      },
    });
    expect(written.isOk()).toBe(true);
    expect(ran).toEqual([
      [
        "icacls",
        folder,
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
    ]);
    expect(ran.flat().join(" ")).not.toContain("console=");
    const refused = await writeInstallerPage({
      dataDir: data,
      sid: "S-1-5-21-9",
      folder: join(data, "w2"),
      platform: "win32",
      run: () => 5,
    });
    expect(refused.isErr()).toBe(true);
  });

  test("its arguments: the folder and a user's SID only", () => {
    expect(parseInstallerPageArgs(["--data", "D", "--sid", "S-1-5-21-1", "--folder", "F"])).toEqual(
      { dataDir: "D", sid: "S-1-5-21-1", folder: "F" },
    );
    expect(parseInstallerPageArgs(["--data", "D", "--sid", "Everyone", "--folder", "F"])).toBe(
      "not a user's SID: Everyone",
    );
  });

  test("no hub answering: refused, nothing written", async () => {
    const data = mkdtempSync(join(tmpdir(), "hsn-ip-"));
    folders.push(data);
    expect(
      (
        await writeInstallerPage({ dataDir: data, sid: "S-1-5-21-1", folder: join(data, "f") })
      ).isErr(),
    ).toBe(true);
  });
});
