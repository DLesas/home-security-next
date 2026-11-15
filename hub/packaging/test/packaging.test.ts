/**
 * What can be checked of the three packages on the development Mac (m2-design.md section 9): the
 * service definitions say what section 9's table and the frozen `SERVICE` values say, the scripts
 * parse, the data folder is closed by the installers' own script, the pinned WinSW is checked, the
 * program's two roles, and a real `.pkg` built by the system's `pkgbuild` around a stand-in
 * program, its payload and scripts read back. Installing needs root and a clean machine of each
 * system: the hosted runners (packaging/README.md).
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE } from "../../src/shell/m2-values.ts";
import { programRole } from "../shared/program.ts";
import { INSTALL } from "../shared/layout.ts";
import { matchesPin, parsePin, PIN_FILE } from "../windows/winsw-pin.ts";
import { isTarget } from "../shared/build-program.ts";

const HERE = join(import.meta.dir, "..");
const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "hsn-packaging-"));
  folders.push(dir);
  return dir;
}
function read(path: string): string {
  return readFileSync(join(HERE, path), "utf8");
}
function run(command: readonly string[]): { code: number; out: string } {
  const ran = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
  return { code: ran.exitCode, out: ran.stdout.toString() + ran.stderr.toString() };
}

describe("the program", () => {
  test("one executable, two roles: the hub, and hsn after `cli`", () => {
    expect(programRole(["--data", "/d"])).toBe("hub");
    expect(programRole(["cli", "status"])).toBe("cli");
    expect(isTarget("bun-windows-x64")).toBe(true);
    expect(isTarget("bun-windows-arm64")).toBe(false);
  });
});

describe("Linux: the systemd unit", () => {
  const unit = read("linux/hsn-hub.service");
  const line = (key: string) => new RegExp(`^${key}=(.*)$`, "mu").exec(unit)?.[1];

  test("as the hub's user in dialout, restarted on failure after 5 s, wanted at boot", () => {
    expect(line("User")).toBe(SERVICE.linux.user);
    expect(line("SupplementaryGroups")).toBe(SERVICE.linux.group);
    expect(line("Restart")).toBe("on-failure");
    expect(line("RestartSec")).toBe(String(SERVICE.linux.restartSec));
    expect(line("WantedBy")).toBe("multi-user.target");
    expect(line("UMask")).toBe("0077");
  });

  test("the launcher under systemd-inhibit, with the install's prefix and data folder", () => {
    const start = line("ExecStart") ?? "";
    expect(start.startsWith(`/usr/bin/${SERVICE.linux.sleep[0]} ${SERVICE.linux.sleep[1]}`)).toBe(
      true,
    );
    expect(start).toContain(
      `${INSTALL.linux.launcher} --prefix ${INSTALL.linux.prefix} --data ${INSTALL.linux.dataFolder}`,
    );
  });

  test("postinst closes the data folder at every configure, and selects the version", () => {
    const postinst = read("linux/debian/postinst");
    const secure = postinst.indexOf("secure-data-folder.sh");
    expect(secure).toBeGreaterThan(0);
    // Before the fresh-install test that ends the script on an upgrade.
    expect(secure).toBeLessThan(postinst.indexOf('[ "$fresh" = yes ] || exit 0'));
    expect(postinst).toContain('--select "$VERSION"');
    expect(read("linux/hsn")).toContain(INSTALL.linux.dataFolder);
  });
});

describe("macOS: the launchd daemon", () => {
  const plist = JSON.parse(
    run(["plutil", "-convert", "json", "-o", "-", join(HERE, "macos/com.hsn.hub.plist")]).out,
  ) as Record<string, unknown>;

  test("a valid property list", () => {
    expect(run(["plutil", "-lint", join(HERE, "macos/com.hsn.hub.plist")]).code).toBe(0);
  });

  test("run at load, kept alive unless it exits 0, as _hsnhub, the launcher with the install's paths", () => {
    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(plist.UserName).toBe(SERVICE.macos.user);
    expect(plist.ProgramArguments).toEqual([
      INSTALL.macos.launcher,
      "--prefix",
      INSTALL.macos.prefix,
      "--data",
      INSTALL.macos.dataFolder,
    ]);
    expect(plist.Umask).toBe(0o77);
  });

  test("postinstall closes the data folder at every install, before the fresh-install part", () => {
    const post = read("macos/scripts/postinstall");
    expect(post.indexOf("secure-data-folder.sh")).toBeLessThan(
      post.indexOf('[ "$fresh" = yes ] || exit 0'),
    );
    expect(post).toContain("open-setup-page.sh");
  });
});

describe("Windows: the service and the .msi", () => {
  const xml = read("windows/HSNHub.xml");

  test("WinSW: automatic start, the launcher restarted after 5 s on failure", () => {
    expect(xml).toContain("<startmode>Automatic</startmode>");
    expect(xml).toContain(
      `<onfailure action="restart" delay="${SERVICE.windows.restartDelayS} sec"/>`,
    );
    expect(xml).toContain("<executable>%BASE%\\hsn-launcher.exe</executable>");
    expect(xml).toContain('--data "%ProgramData%\\HSN Hub"');
  });

  test("install-service.ps1: the virtual account, and the protected list of three, at every install", () => {
    const ps = read("windows/install-service.ps1");
    expect(ps).toContain(`$Account = "${SERVICE.windows.account.replace("\\", "\\")}"`);
    expect(ps).toContain("SetAccessRuleProtection($true, $false)");
    expect(ps).toContain('"S-1-5-32-544"');
    expect(ps).toContain('"S-1-5-18"');
    // Set before the fresh-install test that ends the script on an upgrade.
    expect(ps.indexOf("Set-Acl")).toBeLessThan(ps.indexOf("if (-not $fresh"));
    // No user's SID is granted anything: the user's name runs one task and is not kept.
    expect(ps).not.toMatch(/icacls[^\n]*\$User/u);
  });

  test("the .msi runs the install script at install and upgrade, elevated, and the pinned WinSW", () => {
    const wxs = read("windows/hsn-hub.wix.xml");
    expect(wxs).toContain('Id="InstallService"');
    expect(wxs).toContain('Impersonate="no"');
    expect(wxs).toContain('Condition="NOT REMOVE=&quot;ALL&quot;"');
    expect(read("windows/build-msi.ps1")).toContain("winsw-pin.ts");
  });

  test("the WinSW pin: the file W3 proved, and nothing else", () => {
    const pin = readFileSync(PIN_FILE, "utf8");
    expect(parsePin(pin)).toEqual({
      sha256: "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da",
      file: "WinSW-x64.exe",
    });
    const bytes = new TextEncoder().encode("not WinSW");
    expect(matchesPin(bytes, pin)).toBe(false);
    const own = `${createHash("sha256").update(bytes).digest("hex")}  WinSW-x64.exe\n`;
    expect(matchesPin(bytes, own)).toBe(true);
    expect(matchesPin(bytes, "garbage")).toBe(false);
  });
});

describe("the installers' scripts", () => {
  const scripts = [
    "shared/secure-data-folder.sh",
    "shared/open-setup-page.sh",
    "linux/debian/postinst",
    "linux/debian/prerm",
    "linux/debian/postrm",
    "linux/build-deb.sh",
    "linux/hsn",
    "macos/scripts/preinstall",
    "macos/scripts/postinstall",
    "macos/build-pkg.sh",
    "macos/hsn",
    "macos/uninstall.sh",
  ];

  test.each(scripts)("%s parses and is executable", (script) => {
    expect(run(["/bin/sh", "-n", join(HERE, script)]).code).toBe(0);
    expect(statSync(join(HERE, script)).mode & 0o111).not.toBe(0);
  });

  test("secure-data-folder.sh closes a folder that was made open, inside too", () => {
    const folder = join(scratch(), "data");
    mkdirSync(join(folder, "uploads"), { recursive: true });
    writeFileSync(join(folder, "hub.db"), "db");
    chmodSync(folder, 0o777);
    chmodSync(join(folder, "hub.db"), 0o666);
    chmodSync(join(folder, "uploads"), 0o777);
    const user = run(["id", "-un"]).out.trim();
    const group = run(["id", "-gn"]).out.trim();
    expect(run([join(HERE, "shared/secure-data-folder.sh"), folder, user, group]).code).toBe(0);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "hub.db")).mode & 0o077).toBe(0);
    expect(statSync(join(folder, "uploads")).mode & 0o077).toBe(0);
  });
});

describe("macOS: a real .pkg, from a stand-in program", () => {
  test("pkgbuild makes it; its payload has the program, the launcher, hsn and the daemon; its scripts are there", () => {
    const work = scratch();
    const program = join(work, "program");
    const version = "9.8.7";
    mkdirSync(join(program, "versions", version, "bin"), { recursive: true });
    mkdirSync(join(program, "launcher"), { recursive: true });
    writeFileSync(join(program, "versions", version, "bin", "hsn-hub"), "#!/bin/sh\n");
    writeFileSync(join(program, "launcher", "hsn-launcher"), "#!/bin/sh\n");
    writeFileSync(join(program, "version"), `${version}\n`);
    const built = run([join(HERE, "macos/build-pkg.sh"), join(work, "out"), program]);
    expect(built.code).toBe(0);
    const pkg = join(work, "out", `HSN-Hub-${version}.pkg`);
    const payload = run(["pkgutil", "--payload-files", pkg]).out;
    for (const path of [
      `./usr/local/hsn-hub/versions/${version}/bin/hsn-hub`,
      "./usr/local/libexec/hsn-hub/hsn-launcher",
      "./usr/local/bin/hsn",
      "./Library/LaunchDaemons/com.hsn.hub.plist",
    ])
      expect(payload).toContain(path);
    const expanded = join(work, "expanded");
    expect(run(["pkgutil", "--expand", pkg, expanded]).code).toBe(0);
    const scriptsOut = run(["ls", join(expanded, "Scripts")]).out;
    for (const name of [
      "preinstall",
      "postinstall",
      "secure-data-folder.sh",
      "open-setup-page.sh",
      "hsn-version",
    ])
      expect(scriptsOut).toContain(name);
    expect(readFileSync(join(expanded, "Scripts", "hsn-version"), "utf8").trim()).toBe(version);
  });
});
