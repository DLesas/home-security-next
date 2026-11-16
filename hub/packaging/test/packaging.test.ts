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
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
import { unbalanced } from "./powershell-balance.ts";

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

describe("Linux: the systemd units", () => {
  const unit = read("linux/hsn-hub.service");
  const sleep = read("linux/hsn-hub-inhibit.service");
  const line = (text: string, key: string) => new RegExp(`^${key}=(.*)$`, "mu").exec(text)?.[1];

  test("as the hub's user and group, dialout as a supplementary group only, restarted on failure after 5 s", () => {
    expect(line(unit, "User")).toBe(INSTALL.linux.user);
    expect(line(unit, "Group")).toBe(INSTALL.linux.group);
    expect(line(unit, "SupplementaryGroups")).toBe(INSTALL.linux.supplementaryGroup);
    expect(line(unit, "Restart")).toBe("on-failure");
    expect(line(unit, "RestartSec")).toBe(String(SERVICE.linux.restartSec));
    expect(line(unit, "WantedBy")).toBe("multi-user.target");
    expect(line(unit, "UMask")).toBe("0077");
    expect(line(unit, "WorkingDirectory")).toBe("/");
  });

  test("the launcher from the package's tree, with both trees and the data folder; never under systemd-inhibit", () => {
    expect(line(unit, "ExecStart")).toBe(
      `${INSTALL.linux.launcher} --package ${INSTALL.linux.packageTree} --program ${INSTALL.linux.programTree} --data ${INSTALL.linux.dataFolder}`,
    );
    expect(unit).not.toMatch(/^ExecStart=.*systemd-inhibit/mu);
    expect(line(unit, "Wants")).toContain(INSTALL.linux.sleepUnit);
  });

  test("sleep held by a root unit of its own, bound to the hub's, from /usr/bin only", () => {
    expect(line(sleep, "User")).toBeUndefined();
    expect(line(sleep, "BindsTo")).toBe(INSTALL.linux.unit);
    expect(line(sleep, "WantedBy")).toBe(INSTALL.linux.unit);
    expect(line(sleep, "ExecStart")).toMatch(
      /^\/usr\/bin\/systemd-inhibit --what=sleep:idle "--who=HSN Hub" .* \/usr\/bin\/sleep infinity$/u,
    );
    expect(sleep).not.toMatch(/EnvironmentFile|WorkingDirectory=\/var/u);
  });
});

describe("macOS: the launchd daemon", () => {
  const plist = JSON.parse(
    run(["plutil", "-convert", "json", "-o", "-", join(HERE, "macos/com.hsn.hub.plist")]).out,
  ) as Record<string, unknown>;

  test("a valid property list", () => {
    expect(run(["plutil", "-lint", join(HERE, "macos/com.hsn.hub.plist")]).code).toBe(0);
  });

  test("run at load, kept alive unless it exits 0, as _hsnhub, the launcher with both trees", () => {
    expect(plist.RunAtLoad).toBe(true);
    expect(plist.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(plist.UserName).toBe(SERVICE.macos.user);
    expect(plist.ProgramArguments).toEqual([
      INSTALL.macos.launcher,
      "--package",
      INSTALL.macos.packageTree,
      "--program",
      INSTALL.macos.programTree,
      "--data",
      INSTALL.macos.dataFolder,
    ]);
    expect(plist.Umask).toBe(0o77);
    expect(plist.WorkingDirectory).toBe("/");
  });

  test("no log path: launchd would open it as root (the launcher writes to the system log)", () => {
    expect(plist.StandardOutPath).toBeUndefined();
    expect(plist.StandardErrorPath).toBeUndefined();
  });
});

describe("Windows: the service and the .msi", () => {
  const xml = read("windows/HSNHub.xml");
  const ps = read("windows/install-service.ps1");
  const wxs = read("windows/hsn-hub.wix.xml");

  test("WinSW: automatic start, the launcher restarted after 5 s on failure, with both trees", () => {
    expect(xml).toContain("<startmode>Automatic</startmode>");
    expect(xml).toContain(
      `<onfailure action="restart" delay="${SERVICE.windows.restartDelayS} sec"/>`,
    );
    expect(xml).toContain("<executable>%BASE%\\hsn-launcher.exe</executable>");
    expect(xml).toContain(
      '--package "%ProgramFiles%\\HSN Hub" --program "%ProgramData%\\HSN Hub Program" --data "%ProgramData%\\HSN Hub"',
    );
  });

  test("install-service.ps1: the virtual account; the package's tree read and run only; the hub's top folders alone", () => {
    expect(ps).toContain(`$Account = "${SERVICE.windows.account}"`);
    expect(ps).toContain('/grant "${Account}:(OI)(CI)RX"');
    expect(ps).not.toMatch(/\(OI\)\(CI\)M|\/reset|Set-Acl|-Recurse/u);
    expect(ps).toContain("Set-HubTopFolder $Data");
    expect(ps).toContain("Set-HubTopFolder $Program");
    // Fresh by the registry's marker, never by hub.db; a page only at the full interface.
    expect(ps).not.toContain("hub.db");
    expect(ps).toContain('$Marker = "HKLM:\\Software\\HSN Hub"');
    expect(ps).toContain("if ($UILevel -lt 5");
    // Never anything from a hub tree: the page through the package's own program.
    expect(ps).toContain('Join-Path $Package "packaged\\$Version\\bin\\hsn-hub.exe"');
    expect(ps).not.toMatch(/\| Out-Null\s*\n[^\n]*installer-page|installer-page[^\n]*\| Out-Null/u);
  });

  test("tree.ps1: the top folder's own handle, no reparse point followed, no propagation; removal that never enters a link", () => {
    const tree = read("windows/tree.ps1").replace(/^\s*#.*$/gmu, "");
    expect(tree).toContain("FILE_FLAG_OPEN_REPARSE_POINT");
    expect(tree).toContain("SetKernelObjectSecurity");
    expect(tree).not.toContain("SetNamedSecurityInfo");
    expect(tree).toContain("hub-folder.sddl");
    // The service SID in A11's list checked against Windows' own, before any list is set.
    expect(tree).toContain("sc.exe showsid HSNHub");
    expect(tree.indexOf("Assert-ServiceSid $sddl")).toBeLessThan(
      tree.indexOf("[HsnTree]::SetTop($Path, $sddl)"),
    );
    expect(tree).not.toMatch(/\bSetSecurityInfo\b/u);
    expect(tree).not.toMatch(/Remove-Item[^\n]*-Recurse/u);
    expect(read("windows/uninstall-service.ps1").replace(/^\s*#.*$/gmu, "")).not.toMatch(
      /Remove-Item[^\n]*-Recurse/u,
    );
  });

  test("the .msi: an upgrade keeps the version before; the folder's quote; the Start menu; silent means UILevel", () => {
    expect(wxs).toContain('Schedule="afterInstallInitialize"');
    expect(wxs).toContain('<Custom Action="PrepareUpgrade" Before="RemoveExistingProducts"');
    expect(wxs).toContain("-LocalAppData &quot;[LocalAppDataFolder].&quot;");
    expect(wxs).toContain("-UILevel [UILevel]");
    expect(wxs).toContain('Name="HSN Hub setup"');
    expect(wxs).toContain('Name="Remove HSN Hub and its data"');
    expect(wxs).toContain("-RemoveData &quot;[REMOVEDATA]&quot;");
    expect(wxs).toContain('Condition="NOT REMOVE=&quot;ALL&quot;"');
    expect(read("windows/remove-with-data.ps1")).toContain("REMOVEDATA=1");
    // No licence page in M2, and no placeholder licence.
    expect(wxs).not.toMatch(/WixUI_Minimal|WelcomeEulaDlg|LicenseAgreementDlg|WixUILicenseRtf/u);
    expect(wxs).toContain(
      '<Show Dialog="WelcomeDlg" Before="ProgressDlg" Condition="NOT Installed" />',
    );
  });

  test("build-msi.ps1: the pinned WinSW, its licence kept here, the work folder always removed", () => {
    const build = read("windows/build-msi.ps1");
    expect(build).toContain("winsw-pin.ts");
    expect(build).not.toContain('LICENSE.txt" -OutFile');
    expect(build).not.toMatch(/Invoke-WebRequest[^\n]*LICENSE/u);
    expect(build).toMatch(
      /finally \{\s*Remove-Item -Recurse -Force -ErrorAction SilentlyContinue \$work/u,
    );
    expect(read("windows/WinSW-LICENSE.txt")).toContain("MIT License");
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

describe("the PowerShell scripts, read as text (nothing here can parse PowerShell)", () => {
  const files = [
    "windows/build-msi.ps1",
    "windows/install-service.ps1",
    "windows/uninstall-service.ps1",
    "windows/prepare-upgrade.ps1",
    "windows/remove-with-data.ps1",
    "windows/tree.ps1",
    "hosted/check.ps1",
  ];

  test.each(files)("%s: every quote, here-string, comment and bracket closed", (file) => {
    expect(unbalanced(read(file))).toBeUndefined();
  });

  test("the reader finds the slip build-msi.ps1 had: a string's missing closing quote", () => {
    expect(
      unbalanced('foreach ($f in @("a.xml", "tree.ps1, "b.ps1")) {\n  Copy-Item $f\n}\n'),
    ).toBeDefined();
    expect(unbalanced('if ($x) {\n  "a $($y.Name) b" | Out-Null\n')).toContain("never closed");
    expect(
      unbalanced('$t = @"\nquote " and { brace\n"@\n$u = "${Account}:(OI)"\n'),
    ).toBeUndefined();
  });
});

describe("the installers' scripts", () => {
  const scripts = [
    "shared/prepare-hub-folder.sh",
    "shared/open-setup-page.sh",
    "shared/prune-packaged.sh",
    "linux/debian/preinst",
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
    "hosted/check.sh",
  ];
  const elevated = [
    "linux/debian/preinst",
    "linux/debian/postinst",
    "linux/debian/prerm",
    "linux/debian/postrm",
    "macos/scripts/preinstall",
    "macos/scripts/postinstall",
    "macos/uninstall.sh",
    "shared/prepare-hub-folder.sh",
    "shared/open-setup-page.sh",
    "shared/prune-packaged.sh",
  ];

  test.each(scripts)("%s parses and is executable", (script) => {
    expect(run(["/bin/sh", "-n", join(HERE, script)]).code).toBe(0);
    expect(statSync(join(HERE, script)).mode & 0o111).not.toBe(0);
  });

  test.each(elevated)(
    "%s: no recursion into a hub tree, no version chosen, no hub program run, no freshness from hub.db",
    (script) => {
      const text = read(script).replace(/^#.*$/gmu, "");
      expect(text).not.toMatch(
        /chown -R|chmod -R|chown -hR|--select|current\/bin|hub\.db|staged\//u,
      );
      expect(text).not.toMatch(/\$(DATA|PROGRAM)\/[^"\s]/u);
    },
  );

  test("postinst and postinstall: both hub trees' top folders, the marker, the setup page through hsn", () => {
    for (const script of ["linux/debian/postinst", "macos/scripts/postinstall"]) {
      const text = read(script);
      expect(text).toMatch(/prepare-hub-folder\.sh" "\$DATA"/u);
      expect(text).toMatch(/prepare-hub-folder\.sh" "\$PROGRAM"/u);
      expect(text).toContain('[ -e "$PKG/installed" ] && fresh=no');
      expect(text.indexOf('touch "$PKG/installed"')).toBeLessThan(
        text.indexOf('[ "$fresh" = yes ] || exit 0'),
      );
      expect(text).toMatch(/open-setup-page\.sh" \/usr(\/local)?\/bin\/hsn/u);
      expect(text).toContain("prune-packaged.sh");
    }
    expect(read("linux/debian/postinst")).toContain("DEBIAN_FRONTEND");
    expect(read("macos/scripts/postinstall")).toContain("COMMAND_LINE_INSTALL");
    expect(read("linux/debian/preinst")).toContain('cp -a "$PKG/packaged/$old" "$PKG/kept/$old"');
  });

  test("uninstalling keeps the hub's trees; purge and --remove-data wait for the hub's processes, then remove each whole", () => {
    const postrm = read("linux/debian/postrm");
    const remove = postrm.slice(postrm.indexOf("remove)"), postrm.indexOf("purge)"));
    expect(remove).not.toContain("/var/lib");
    expect(remove).toContain('rm -rf "$PKG"');
    const purge = postrm.slice(postrm.indexOf("purge)"));
    expect(purge.indexOf("pgrep -u hsn")).toBeLessThan(
      purge.indexOf("rm -rf /var/lib/hsn-hub /var/lib/hsn-hub-program"),
    );
    const mac = read("macos/uninstall.sh");
    expect(mac.indexOf('pgrep -u "$USER_NAME"')).toBeLessThan(
      mac.indexOf('rm -rf "$DATA" "$PROGRAM"'),
    );
    expect(mac).toContain('Type "remove" to go on');
    expect(read("macos/hsn")).toContain("exec /usr/local/hsn-hub/uninstall.sh");
  });

  test("hsn on the path runs the package's own hsn executable, from /, its data folder named", () => {
    expect(read("linux/hsn")).toContain("exec /usr/lib/hsn-hub/bin/hsn --data /var/lib/hsn-hub");
    expect(read("macos/hsn")).toContain(
      'exec /usr/local/hsn-hub/bin/hsn --data "/Library/Application Support/HSN Hub"',
    );
    for (const script of ["linux/hsn", "macos/hsn"]) expect(read(script)).toContain("cd /");
    for (const build of ["linux/build-deb.sh", "macos/build-pkg.sh"])
      expect(read(build)).toMatch(/program\/bin\/hsn" "\$pkg\/bin\/hsn"/u);
    expect(read("shared/build-program.ts")).toContain("compileExecutable");
  });
});

describe("prepare-hub-folder.sh: the top folder only", () => {
  const script = join(HERE, "shared/prepare-hub-folder.sh");
  const user = run(["id", "-un"]).out.trim();
  const group = run(["id", "-gn"]).out.trim();
  function parent(): string {
    const dir = join(scratch(), "parent");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    return dir;
  }

  test("a missing folder made 0700", () => {
    const folder = join(parent(), "data");
    expect(run([script, folder, user, group]).code).toBe(0);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test("an open folder closed, its contents left exactly as they were (no recursion)", () => {
    const folder = join(parent(), "data");
    mkdirSync(join(folder, "inside"), { recursive: true });
    writeFileSync(join(folder, "hub.db"), "db");
    chmodSync(folder, 0o777);
    chmodSync(join(folder, "hub.db"), 0o666);
    chmodSync(join(folder, "inside"), 0o777);
    expect(run([script, folder, user, group]).code).toBe(0);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, "hub.db")).mode & 0o777).toBe(0o666);
    expect(statSync(join(folder, "inside")).mode & 0o777).toBe(0o777);
  });

  test("a top folder that is a link, or a file, is refused and its target untouched", () => {
    const base = parent();
    const target = join(scratch(), "target");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, join(base, "data"));
    const linked = run([script, join(base, "data"), user, group]);
    expect(linked.code).not.toBe(0);
    expect(linked.out).toContain("it is a link");
    expect(statSync(target).mode & 0o777).toBe(0o755);
    writeFileSync(join(base, "file"), "x");
    expect(run([script, join(base, "file"), user, group]).out).toContain("it is not a folder");
  });

  test("a parent anyone or its group can write is refused: the folder could be replaced", () => {
    const base = parent();
    chmodSync(base, 0o777);
    expect(run([script, join(base, "data"), user, group]).out).toContain("writable by anyone");
    chmodSync(base, 0o775);
    expect(run([script, join(base, "data"), user, group]).out).toContain("writable by its group");
  });
});

describe("prune-packaged.sh and open-setup-page.sh", () => {
  test("the package's version and the newest other kept, every other removed", () => {
    const packaged = join(scratch(), "packaged");
    for (const v of ["1.2.0", "1.10.0", "1.9.3", "2.0.0"])
      mkdirSync(join(packaged, v), { recursive: true });
    expect(run([join(HERE, "shared/prune-packaged.sh"), packaged, "2.0.0"]).code).toBe(0);
    expect(readdirSync(packaged).toSorted()).toEqual(["1.10.0", "2.0.0"]);
  });

  test("the setup page through hsn: waits for the hub to answer, then hsn open for the person; its failure is said", () => {
    const dir = scratch();
    const log = join(dir, "log");
    const hsn = join(dir, "hsn");
    // A stand-in hsn: `status` fails once, then answers; `open` records who it is for.
    writeFileSync(
      hsn,
      `#!/bin/sh\nif [ "$1" = status ]; then [ -e "${dir}/up" ] && exit 0; touch "${dir}/up"; exit 1; fi\necho "$* for \${SUDO_USER:-nobody}" >> "${log}"\nexit 3\n`,
    );
    chmodSync(hsn, 0o755);
    const me = run(["id", "-un"]).out.trim();
    const opened = run([join(HERE, "shared/open-setup-page.sh"), hsn, me]);
    expect(opened.code).toBe(3);
    expect(readFileSync(log, "utf8")).toBe(`open for ${me}\n`);
    const none = run([join(HERE, "shared/open-setup-page.sh"), hsn]);
    expect(none.code).toBe(3);
    expect(readFileSync(log, "utf8")).toBe(`open for ${me}\nopen for nobody\n`);
  }, 15_000);
});

describe("macOS: a real .pkg, from a stand-in program", () => {
  test("pkgbuild makes it; its payload has the program, the launcher, hsn and the daemon; its scripts are there", () => {
    const work = scratch();
    const program = join(work, "program");
    const version = "9.8.7";
    mkdirSync(join(program, "versions", version, "bin"), { recursive: true });
    mkdirSync(join(program, "bin"), { recursive: true });
    writeFileSync(join(program, "versions", version, "bin", "hsn-hub"), "#!/bin/sh\n");
    writeFileSync(join(program, "bin", "hsn-launcher"), "#!/bin/sh\n");
    writeFileSync(join(program, "bin", "hsn"), "#!/bin/sh\n");
    writeFileSync(join(program, "version"), `${version}\n`);
    const built = run([join(HERE, "macos/build-pkg.sh"), join(work, "out"), program]);
    expect(built.code).toBe(0);
    const pkg = join(work, "out", `HSN-Hub-${version}.pkg`);
    const payload = run(["pkgutil", "--payload-files", pkg]).out;
    for (const path of [
      `./usr/local/hsn-hub/packaged/${version}/bin/hsn-hub`,
      "./usr/local/hsn-hub/bin/hsn-launcher",
      "./usr/local/hsn-hub/bin/hsn",
      "./usr/local/hsn-hub/uninstall.sh",
      "./usr/local/hsn-hub/version",
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
      "prepare-hub-folder.sh",
      "open-setup-page.sh",
      "prune-packaged.sh",
      "hsn-version",
    ])
      expect(scriptsOut).toContain(name);
    expect(readFileSync(join(expanded, "Scripts", "hsn-version"), "utf8").trim()).toBe(version);
  });
});
