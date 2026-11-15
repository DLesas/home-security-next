/**
 * `hsn open`'s page (m2-design.md section 5, "The console"; section 11, "Step 1, wave 2"): the
 * console's address never on a command line. On this computer, for real: the page written by a
 * shell as the user in a folder only theirs, readable by no one else, holding the address only in
 * its script; the browser (here `cat`, which reads it as a browser would) opened at the page's
 * path; the token in no process's arguments while it runs; the page deleted once read, or when
 * the token expires. With a scripted system: the user found and the commands run for root under
 * `sudo` on macOS and Linux and for an elevated prompt on Windows, and every refusal.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  mkdirSync,
  chmodSync,
  existsSync,
  lstatSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "neverthrow";
import {
  findPageUser,
  openCommand,
  openConsoleAddress,
  pageFolder,
  pageHtml,
  type PageSystem,
  realPageSystem,
  DELETE_SCRIPT,
  WRITE_SCRIPT,
} from "../../../cli/console-page.ts";
import type { PageStat } from "../../../cli/files.ts";

const SECRET = "Zq8vN3xK2pL7mR4tW9yB1c";
const URL = `http://127.0.0.1:8445/#console=${SECRET}`;
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const unix = process.platform === "darwin" || process.platform === "linux";
const notRoot = process.geteuid?.() !== 0;

describe("on this computer, as its own user", () => {
  test.skipIf(!unix || !notRoot)(
    "the page is the user's alone, the token in no process's arguments, deleted once read",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "hsn-a2-home-"));
      folders.push(home);
      const real = realPageSystem();
      const uid = process.geteuid?.() ?? -1;
      const user = process.env.USER ?? "";
      const argvs: string[][] = [];
      const seen: { mode: number; folderMode: number; uid: number; html: string; ps: string } = {
        mode: 0,
        folderMode: 0,
        uid: -1,
        html: "",
        ps: "",
      };
      const sys: PageSystem = {
        ...real,
        // A home of the test's own, so nothing is written in the real one.
        env: { ...real.env, XDG_RUNTIME_DIR: join(home, "no-runtime") },
        run: async (argv, stdin) => {
          argvs.push([...argv]);
          if (argv[0] === "dscl") {
            return { code: 0, stdout: `NFSHomeDirectory: ${home}\nUniqueID: ${uid}\n` };
          }
          if (argv[0] === "getent")
            return { code: 0, stdout: `${user}:x:${uid}:${uid}::${home}:/bin/sh\n` };
          if (argv[0] === "open" || argv[0] === "xdg-open") {
            const path = argv.at(-1) ?? "";
            const st = statSync(path);
            seen.mode = st.mode & 0o777;
            seen.uid = st.uid;
            seen.folderMode = statSync(join(path, "..")).mode & 0o777;
            seen.ps = (await real.run(["ps", "-A", "-ww", "-o", "args="])).stdout;
            // The "browser": it reads the page, as one does.
            seen.html = readFileSync(path, "utf8");
            return { code: 0, stdout: "" };
          }
          return real.run(argv, stdin);
        },
      };
      const done = await openConsoleAddress(URL, 10_000, sys);
      expect(done.isOk() ? done.value : done.error).toBe("read");
      expect(seen.mode).toBe(0o600);
      expect(seen.folderMode).toBe(0o700);
      expect(seen.uid).toBe(uid);
      expect(seen.html).toBe(pageHtml(URL));
      expect(seen.html).toContain(`location.replace("${URL}")`);
      expect(seen.ps.length).toBeGreaterThan(0);
      expect(seen.ps).not.toContain(SECRET);
      expect(argvs.flat().join(" ")).not.toContain(SECRET);
      const folder =
        process.platform === "darwin"
          ? join(home, "Library/Caches/HSN Hub")
          : join(home, ".cache/hsn-hub");
      expect(readdirSync(folder)).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a page nobody reads is deleted when the token expires",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "hsn-a2-home-"));
      folders.push(home);
      const real = realPageSystem();
      const uid = process.geteuid?.() ?? -1;
      const sys: PageSystem = {
        ...real,
        env: { ...real.env, XDG_RUNTIME_DIR: join(home, "no-runtime") },
        run: (argv, stdin) => {
          if (argv[0] === "dscl")
            return Promise.resolve({
              code: 0,
              stdout: `NFSHomeDirectory: ${home}\nUniqueID: ${uid}\n`,
            });
          if (argv[0] === "getent")
            return Promise.resolve({
              code: 0,
              stdout: `${process.env.USER ?? ""}:x:${uid}:${uid}::${home}:/bin/sh\n`,
            });
          if (argv[0] === "open" || argv[0] === "xdg-open")
            return Promise.resolve({ code: 0, stdout: "" });
          return real.run(argv, stdin);
        },
      };
      const started = Date.now();
      const done = await openConsoleAddress(URL, 600, sys);
      expect(done.isOk() ? done.value : done.error).toBe("unread");
      expect(Date.now() - started).toBeGreaterThanOrEqual(550);
      const folder =
        process.platform === "darwin"
          ? join(home, "Library/Caches/HSN Hub")
          : join(home, ".cache/hsn-hub");
      expect(readdirSync(folder)).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a page folder left open to others is made the user's alone again",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "hsn-a2-home-"));
      folders.push(home);
      const folder =
        process.platform === "darwin"
          ? join(home, "Library/Caches/HSN Hub")
          : join(home, ".cache/hsn-hub");
      mkdirSync(folder, { recursive: true });
      chmodSync(folder, 0o755);
      const real = realPageSystem();
      const uid = process.geteuid?.() ?? -1;
      const sys: PageSystem = {
        ...real,
        env: { ...real.env, XDG_RUNTIME_DIR: join(home, "no-runtime") },
        run: (argv, stdin) => {
          if (argv[0] === "dscl")
            return Promise.resolve({
              code: 0,
              stdout: `NFSHomeDirectory: ${home}\nUniqueID: ${uid}\n`,
            });
          if (argv[0] === "getent")
            return Promise.resolve({
              code: 0,
              stdout: `${process.env.USER ?? ""}:x:${uid}:${uid}::${home}:/bin/sh\n`,
            });
          if (argv[0] === "open" || argv[0] === "xdg-open") {
            readFileSync(argv.at(-1) ?? "");
            return Promise.resolve({ code: 0, stdout: "" });
          }
          return real.run(argv, stdin);
        },
      };
      const done = await openConsoleAddress(URL, 5000, sys);
      expect(done.isOk() ? done.value : done.error).toBe("read");
      expect(statSync(folder).mode & 0o777).toBe(0o700);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a folder that is a link is refused, and nothing is opened",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "hsn-a2-home-"));
      folders.push(home);
      const elsewhere = join(home, "elsewhere");
      mkdirSync(elsewhere, { mode: 0o700 });
      const parent =
        process.platform === "darwin" ? join(home, "Library/Caches") : join(home, ".cache");
      mkdirSync(parent, { recursive: true });
      symlinkSync(elsewhere, join(parent, process.platform === "darwin" ? "HSN Hub" : "hsn-hub"));
      const real = realPageSystem();
      const uid = process.geteuid?.() ?? -1;
      let opened = false;
      const sys: PageSystem = {
        ...real,
        env: { ...real.env, XDG_RUNTIME_DIR: join(home, "no-runtime") },
        run: (argv, stdin) => {
          if (argv[0] === "dscl")
            return Promise.resolve({
              code: 0,
              stdout: `NFSHomeDirectory: ${home}\nUniqueID: ${uid}\n`,
            });
          if (argv[0] === "getent")
            return Promise.resolve({
              code: 0,
              stdout: `${process.env.USER ?? ""}:x:${uid}:${uid}::${home}:/bin/sh\n`,
            });
          if (argv[0] === "open" || argv[0] === "xdg-open") {
            opened = true;
            return Promise.resolve({ code: 0, stdout: "" });
          }
          return real.run(argv, stdin);
        },
      };
      const done = await openConsoleAddress(URL, 1000, sys);
      expect(done.isErr() ? done.error : "").toContain("could not be written");
      expect(opened).toBe(false);
      expect(readdirSync(elsewhere)).toEqual([]);
    },
  );
});

// ----- A scripted computer -----

interface Scripted {
  readonly sys: PageSystem;
  readonly argvs: string[][];
  readonly stdins: string[];
  readonly files: Map<string, PageStat>;
}

function stat(over: Partial<PageStat>): PageStat {
  return {
    isFile: false,
    isDirectory: false,
    isLink: false,
    uid: 501,
    mode: 0o40700,
    size: 0,
    atimeMs: 1,
    mtimeMs: 1,
    ...over,
  };
}

/** A computer that answers the directory lookups and "writes" the page as the shell would. */
function scripted(
  platform: string,
  env: Record<string, string>,
  euid: number | undefined,
): Scripted {
  const argvs: string[][] = [];
  const stdins: string[] = [];
  const files = new Map<string, PageStat>();
  files.set("/dev/console", stat({ uid: 501 }));
  let now = 0;
  const sys: PageSystem = {
    platform,
    env,
    euid,
    random: () => "00ff",
    now: () => now,
    sleep: (ms) => {
      now += ms;
      // The browser reads the page a moment after it opens.
      for (const [path, st] of files)
        if (path.endsWith(".html")) files.set(path, { ...st, atimeMs: 2 });
      return Promise.resolve();
    },
    fs: {
      lstat: (path) => files.get(path),
      makeFolder: (path) => {
        files.set(path, stat({ isDirectory: true }));
        return ok(undefined);
      },
      writeNew: (path) => {
        files.set(path, stat({ isFile: true, mode: 0o100600, size: 10 }));
        return ok(undefined);
      },
      remove: (path) => {
        files.delete(path);
        return ok(undefined);
      },
    },
    run: (argv, stdin) => {
      argvs.push([...argv]);
      if (stdin !== undefined) stdins.push(stdin);
      const program = argv.find(
        (a) =>
          !["sudo", "-u", "--", "launchctl", "asuser"].includes(a) &&
          !/^\d+$/u.test(a) &&
          a !== env.SUDO_USER,
      );
      if (program === "dscl")
        return Promise.resolve({
          code: 0,
          stdout: "NFSHomeDirectory: /Users/anna\nUniqueID: 501\n",
        });
      if (program === "getent")
        return Promise.resolve({ code: 0, stdout: "anna:x:501:20::/home/anna:/bin/bash\n" });
      if (program === "whoami")
        return Promise.resolve({ code: 0, stdout: '"pc\\anna","S-1-5-21-1-2-3-1001"\n' });
      if (program === "/bin/sh" && argv.includes(WRITE_SCRIPT)) {
        const folder = argv.at(-2) ?? "";
        files.set(folder, stat({ isDirectory: true }));
        files.set(argv.at(-1) ?? "", stat({ isFile: true, mode: 0o100600, size: 10 }));
      }
      if (program === "/bin/sh" && argv.includes(DELETE_SCRIPT)) files.delete(argv.at(-1) ?? "");
      return Promise.resolve({ code: 0, stdout: "" });
    },
  };
  return { sys, argvs, stdins, files };
}

const SUDO = { SUDO_USER: "anna", SUDO_UID: "501", SUDO_GID: "20", USER: "root" };

describe("as root under sudo, and elevated on Windows", () => {
  test("macOS: written as the user in ~/Library/Caches/HSN Hub, opened in the user's GUI session", async () => {
    const s = scripted("darwin", SUDO, 0);
    const done = await openConsoleAddress(URL, 120_000, s.sys);
    expect(done.isOk() ? done.value : done.error).toBe("read");
    const page = "/Users/anna/Library/Caches/HSN Hub/console-00ff.html";
    expect(s.argvs).toEqual([
      ["dscl", ".", "-read", "/Users/anna", "NFSHomeDirectory", "UniqueID"],
      [
        "sudo",
        "-u",
        "anna",
        "--",
        "/bin/sh",
        "-c",
        WRITE_SCRIPT,
        "sh",
        "/Users/anna/Library/Caches/HSN Hub",
        page,
      ],
      ["launchctl", "asuser", "501", "sudo", "-u", "anna", "--", "open", page],
      [
        "sudo",
        "-u",
        "anna",
        "--",
        "/bin/sh",
        "-c",
        DELETE_SCRIPT,
        "sh",
        "/Users/anna/Library/Caches/HSN Hub",
        page,
      ],
    ]);
    expect(s.stdins).toEqual([pageHtml(URL)]);
    expect(s.argvs.flat().join(" ")).not.toContain(SECRET);
    expect(s.files.has(page)).toBe(false);
  });

  test("Linux: in /run/user/<uid>/hsn-hub when it is the user's, opened in the user's session", async () => {
    const s = scripted("linux", { ...SUDO, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, 0);
    s.files.set("/run/user/501", stat({ isDirectory: true }));
    const done = await openConsoleAddress(URL, 120_000, s.sys);
    expect(done.isOk()).toBe(true);
    const page = "/run/user/501/hsn-hub/console-00ff.html";
    expect(s.argvs[2]).toEqual([
      "sudo",
      "-u",
      "anna",
      "--",
      "env",
      "XDG_RUNTIME_DIR=/run/user/501",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/501/bus",
      "DISPLAY=:0",
      "WAYLAND_DISPLAY=wayland-0",
      "xdg-open",
      page,
    ]);
    expect(s.argvs.flat().join(" ")).not.toContain(SECRET);
  });

  test("Linux without a runtime folder of the user's: ~/.cache/hsn-hub", async () => {
    const s = scripted("linux", SUDO, 0);
    s.files.set("/run/user/501", stat({ isDirectory: true, uid: 0 }));
    const user = await findPageUser(s.sys);
    expect(user.isOk() && pageFolder(s.sys, user.value)).toBe("/home/anna/.cache/hsn-hub");
  });

  test("Windows: %LOCALAPPDATA%\\HSN Hub, its access list the user's, SYSTEM's and Administrators', opened by explorer", async () => {
    const s = scripted(
      "win32",
      { USERNAME: "anna", LOCALAPPDATA: "C:\\Users\\anna\\AppData\\Local" },
      undefined,
    );
    s.files.set("C:\\Users\\anna\\AppData\\Local", stat({ isDirectory: true }));
    s.files.set("C:\\Users\\anna\\AppData\\Local\\HSN Hub", stat({ isDirectory: true }));
    const done = await openConsoleAddress(URL, 120_000, s.sys);
    expect(done.isOk()).toBe(true);
    const folder = "C:\\Users\\anna\\AppData\\Local\\HSN Hub";
    expect(s.argvs).toEqual([
      ["whoami", "/user", "/fo", "csv", "/nh"],
      [
        "icacls",
        folder,
        "/inheritance:r",
        "/grant:r",
        "*S-1-5-21-1-2-3-1001:(OI)(CI)F",
        "*S-1-5-18:(OI)(CI)F",
        "*S-1-5-32-544:(OI)(CI)F",
      ],
      ["explorer.exe", `${folder}\\console-00ff.html`],
    ]);
    expect(s.files.has(`${folder}\\console-00ff.html`)).toBe(false);
  });
});

describe("refusals, never a command line", () => {
  test("root without sudo's user, or sudo from root", async () => {
    for (const env of [{ USER: "root" }, { ...SUDO, SUDO_UID: "0" }, { ...SUDO, SUDO_UID: "x" }]) {
      const s = scripted("darwin", env, 0);
      const done = await openConsoleAddress(URL, 1000, s.sys);
      expect(done.isErr() ? done.error : "").toContain("sudo hsn open");
      expect(s.argvs).toEqual([]);
    }
  });

  test("macOS: a user who is not at the screen", async () => {
    const s = scripted("darwin", SUDO, 0);
    s.files.set("/dev/console", stat({ uid: 502 }));
    const done = await openConsoleAddress(URL, 1000, s.sys);
    expect(done.isErr() ? done.error : "").toContain("not the user at this computer's screen");
    expect(s.argvs.some((a) => a.includes("open"))).toBe(false);
  });

  test("a home folder the directory does not give for that uid", async () => {
    const s = scripted("linux", { ...SUDO, SUDO_UID: "777" }, 0);
    const done = await openConsoleAddress(URL, 1000, s.sys);
    expect(done.isErr() ? done.error : "").toContain("home folder");
  });

  test("a page or folder others can read, or not the user's, is deleted and nothing opened", async () => {
    const s = scripted("linux", SUDO, 0);
    const run = s.sys.run;
    const sys: PageSystem = {
      ...s.sys,
      run: async (argv, stdin) => {
        const ran = await run(argv, stdin);
        if (argv.includes("/bin/sh"))
          s.files.set(argv.at(-1) ?? "", stat({ isFile: true, mode: 0o100644 }));
        return ran;
      },
    };
    const done = await openConsoleAddress(URL, 1000, sys);
    expect(done.isErr()).toBe(true);
    expect(s.argvs.some((a) => a.includes("xdg-open"))).toBe(false);
    expect(s.argvs.at(-1)?.slice(-4)).toEqual([
      DELETE_SCRIPT,
      "sh",
      "/home/anna/.cache/hsn-hub",
      "/home/anna/.cache/hsn-hub/console-00ff.html",
    ]);
  });

  test("an opener that fails: the page deleted, refused", async () => {
    const s = scripted("darwin", SUDO, 0);
    const run = s.sys.run;
    const sys: PageSystem = {
      ...s.sys,
      run: (argv, stdin) =>
        argv.includes("open") ? Promise.resolve({ code: 1, stdout: "" }) : run(argv, stdin),
    };
    const done = await openConsoleAddress(URL, 1000, sys);
    expect(done.isErr() ? done.error : "").toContain("browser could not be opened");
    expect([...s.files.keys()].some((p) => p.endsWith(".html"))).toBe(false);
  });

  test("Windows without a user folder, or an access list that cannot be set", async () => {
    const none = scripted("win32", { USERNAME: "anna" }, undefined);
    expect((await openConsoleAddress(URL, 1000, none.sys)).isErr()).toBe(true);
    const s = scripted("win32", { USERNAME: "anna", LOCALAPPDATA: "C:\\L" }, undefined);
    s.files.set("C:\\L", stat({ isDirectory: true }));
    const run = s.sys.run;
    const sys: PageSystem = {
      ...s.sys,
      run: (argv, stdin) =>
        argv[0] === "icacls" ? Promise.resolve({ code: 5, stdout: "" }) : run(argv, stdin),
    };
    const done = await openConsoleAddress(URL, 1000, sys);
    expect(done.isErr() ? done.error : "").toContain("alone");
    expect(s.argvs.some((a) => a[0] === "explorer.exe")).toBe(false);
  });

  test("an unknown platform", async () => {
    const s = scripted("plan9", {}, 1000);
    expect((await openConsoleAddress(URL, 1000, s.sys)).isErr()).toBe(true);
  });

  test("the page puts the address in its own place, quoted, out of the history", () => {
    expect(pageHtml("http://x/#a</script>")).toContain(
      'location.replace("http://x/#a\\u003c/script>")',
    );
    expect(
      openCommand(
        { ...scripted("darwin", {}, 501).sys },
        { name: "anna", uid: 501, home: "/h", sid: undefined, asUser: [], elevated: false },
        "/p",
      ),
    ).toEqual(["open", "/p"]);
  });
});

describe("nothing through a link the user planted (hsn runs elevated)", () => {
  const NAME = "console-planted.html";

  /** A home of the test's own, the page's name fixed so something can be planted there. */
  function at(onOpen?: (path: string, folder: string, elsewhere: string) => void) {
    const home = mkdtempSync(join(tmpdir(), "hsn-a2-home-"));
    folders.push(home);
    const parent =
      process.platform === "darwin" ? join(home, "Library/Caches") : join(home, ".cache");
    const folder = join(parent, process.platform === "darwin" ? "HSN Hub" : "hsn-hub");
    const elsewhere = join(home, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(parent, { recursive: true });
    const real = realPageSystem();
    const uid = process.geteuid?.() ?? -1;
    const opened: string[] = [];
    const sys: PageSystem = {
      ...real,
      random: () => "planted",
      env: { ...real.env, XDG_RUNTIME_DIR: join(home, "no-runtime") },
      run: (argv, stdin) => {
        if (argv[0] === "dscl")
          return Promise.resolve({
            code: 0,
            stdout: `NFSHomeDirectory: ${home}\nUniqueID: ${uid}\n`,
          });
        if (argv[0] === "getent")
          return Promise.resolve({
            code: 0,
            stdout: `${process.env.USER ?? ""}:x:${uid}:${uid}::${home}:/bin/sh\n`,
          });
        if (argv[0] === "open" || argv[0] === "xdg-open") {
          const path = argv.at(-1) ?? "";
          opened.push(path);
          readFileSync(path);
          onOpen?.(path, folder, elsewhere);
          return Promise.resolve({ code: 0, stdout: "" });
        }
        return real.run(argv, stdin);
      },
    };
    return { sys, folder, elsewhere, opened, page: join(folder, NAME) };
  }

  test.skipIf(!unix || !notRoot)(
    "a file already at the page's path: refused, the file unchanged",
    async () => {
      const t = at();
      mkdirSync(t.folder, { mode: 0o700 });
      writeFileSync(t.page, "the user's own");
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr()).toBe(true);
      expect(readFileSync(t.page, "utf8")).toBe("the user's own");
      expect(t.opened).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a link at the page's path to a file elsewhere: refused, the file unchanged",
    async () => {
      const t = at();
      mkdirSync(t.folder, { mode: 0o700 });
      const target = join(t.elsewhere, "target");
      writeFileSync(target, "untouched");
      symlinkSync(target, t.page);
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("untouched");
      expect(lstatSync(t.page).isSymbolicLink()).toBe(true);
      expect(t.opened).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a link at the page's path to nothing yet: refused, nothing made there",
    async () => {
      const t = at();
      mkdirSync(t.folder, { mode: 0o700 });
      const target = join(t.elsewhere, "not-yet");
      symlinkSync(target, t.page);
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr()).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(t.opened).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a link at the page's path to a pipe: refused, nothing written into it",
    async () => {
      const t = at();
      mkdirSync(t.folder, { mode: 0o700 });
      const fifo = join(t.elsewhere, "fifo");
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      symlinkSync(fifo, t.page);
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr()).toBe(true);
      expect(t.opened).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "a link at the folder: refused, nothing made in or through it, its target's mode unchanged",
    async () => {
      const t = at();
      chmodSync(t.elsewhere, 0o755);
      symlinkSync(t.elsewhere, t.folder);
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr()).toBe(true);
      expect(readdirSync(t.elsewhere)).toEqual([]);
      expect(statSync(t.elsewhere).mode & 0o777).toBe(0o755);
      expect(t.opened).toEqual([]);
    },
  );

  test.skipIf(!unix || !notRoot)(
    "the delete removes a link put at the page's path, never what it points at",
    async () => {
      const t = at((path, _folder, elsewhere) => {
        const target = join(elsewhere, "target");
        writeFileSync(target, "untouched");
        rmSync(path);
        symlinkSync(target, path);
      });
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isOk() || done.error).toBeDefined();
      expect(existsSync(t.page)).toBe(false);
      expect(lstatSync(t.page, { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(join(t.elsewhere, "target"), "utf8")).toBe("untouched");
    },
  );

  test.skipIf(!unix || !notRoot)(
    "the delete never goes through a folder that became a link",
    async () => {
      const moved: { page: string } = { page: "" };
      const t = at((_path, folder, elsewhere) => {
        // The user swaps the folder for a link to another holding a file of the page's name.
        const aside = `${folder}-aside`;
        renameSync(folder, aside);
        moved.page = join(aside, NAME);
        const decoy = elsewhere;
        writeFileSync(join(decoy, NAME), "a file of the user's");
        symlinkSync(decoy, folder);
      });
      const done = await openConsoleAddress(URL, 2000, t.sys);
      expect(done.isErr() ? done.error : "").toContain("could not be deleted");
      expect(readFileSync(join(t.elsewhere, NAME), "utf8")).toBe("a file of the user's");
    },
  );
});

describe("Windows: nothing through a link or junction, elevated", () => {
  test.each([
    ["the user's folder", "C:\\L"],
    ["the page's folder", "C:\\L\\HSN Hub"],
  ])("%s a link: refused before the folder is made or its access list set", async (_what, link) => {
    const s = scripted("win32", { USERNAME: "anna", LOCALAPPDATA: "C:\\L" }, undefined);
    s.files.set("C:\\L", stat({ isDirectory: true }));
    s.files.set(link, stat({ isDirectory: false, isLink: true }));
    let made = false;
    const sys: PageSystem = {
      ...s.sys,
      fs: {
        ...s.sys.fs,
        makeFolder: (p) => {
          made = true;
          return s.sys.fs.makeFolder(p);
        },
      },
    };
    const done = await openConsoleAddress(URL, 1000, sys);
    expect(done.isErr() ? done.error : "").toContain("is a link");
    expect(made).toBe(false);
    expect(s.argvs.some((a) => a[0] === "icacls" || a[0] === "explorer.exe")).toBe(false);
  });
});

describe("the write's exclusive creation, on its own", () => {
  // The tests before the write refuse what is already there; `set -C` refuses what appears between
  // those tests and the write. Here the script runs without its tests, so only `set -C` stands.
  const exclusiveOnly = WRITE_SCRIPT.replace('[ ! -e "$2" ] && [ ! -L "$2" ] && ', "");

  test.skipIf(!unix)(
    "still refuses a file, or a link to a file or to nothing, at the page's path",
    () => {
      expect(exclusiveOnly).not.toBe(WRITE_SCRIPT);
      const dir = mkdtempSync(join(tmpdir(), "hsn-a2-excl-"));
      folders.push(dir);
      const folder = join(dir, "f");
      mkdirSync(folder, { mode: 0o700 });
      writeFileSync(join(dir, "target"), "untouched");
      writeFileSync(join(folder, "file"), "untouched");
      symlinkSync(join(dir, "target"), join(folder, "link"));
      symlinkSync(join(dir, "nothing"), join(folder, "dangling"));
      for (const name of ["file", "link", "dangling"]) {
        const ran = Bun.spawnSync(
          ["/bin/sh", "-c", exclusiveOnly, "sh", folder, join(folder, name)],
          {
            stdin: new TextEncoder().encode("secret page"),
            stderr: "ignore",
          },
        );
        expect(ran.exitCode).not.toBe(0);
      }
      expect(readFileSync(join(dir, "target"), "utf8")).toBe("untouched");
      expect(readFileSync(join(folder, "file"), "utf8")).toBe("untouched");
      expect(existsSync(join(dir, "nothing"))).toBe(false);
    },
  );
});
