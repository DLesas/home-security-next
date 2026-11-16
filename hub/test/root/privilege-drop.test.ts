/**
 * `hsn`'s drop of root, proved and not assumed (m2-design.md section 9, "Dropping privileges in
 * Bun"): run only as root, on macOS and Linux, in the hosted job (`sudo`), with an unprivileged
 * account named by `HSN_TEST_ACCOUNT` (the job makes one). After the drop the real, effective and
 * saved user and group ids are all the account's, root's group is gone, and `setuid(0)` fails;
 * the helper that opens a person's file starts with that person's ids, never follows a link, and
 * writes 0600 files owned by them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lookupAccount } from "../../cli/elevated.ts";
import { HELPER_ARGUMENT } from "../../cli/file-helper.ts";

const ROOT = process.geteuid?.() === 0 && process.platform !== "win32";
const NAME = process.env.HSN_TEST_ACCOUNT ?? "";
const HSN = join(import.meta.dir, "..", "..", "cli", "hsn.ts");
const CHILD = join(import.meta.dir, "drop-child.ts");
const work = mkdtempSync("/tmp/hsn-root-");
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!ROOT || NAME === "")("hsn gives up root for good (root only)", () => {
  // Looked up only where the tests run: a skipped describe still runs its body.
  const found = ROOT && NAME !== "" ? lookupAccount(NAME) : undefined;
  const account = found?.isOk() === true ? found.value : { name: NAME, uid: -1, gid: -1 };

  test("groups, group, user: every id the account's, and setuid(0) refused", () => {
    // The account's own groups, read before the drop: the drop must leave exactly these.
    const own = Bun.spawnSync(["/usr/bin/id", "-G", NAME], { env: {}, cwd: "/" })
      .stdout.toString()
      .trim()
      .split(/\s+/u)
      .map(Number);
    const sorted = (groups: readonly number[]) => [...new Set(groups)].sort((a, b) => a - b);
    const ran = Bun.spawnSync([process.execPath, CHILD, NAME], { stdout: "pipe", stderr: "pipe" });
    const said = JSON.parse(ran.stdout.toString()) as {
      dropped: string;
      ids: {
        ruid: number;
        euid: number;
        suid: number;
        rgid: number;
        egid: number;
        sgid: number;
        groups: number[];
      };
      regained: string;
      idsAfter: { ruid: number; euid: number; suid: number };
    };
    expect(said.dropped).toBe("ok");
    expect([said.ids.ruid, said.ids.euid, said.ids.suid]).toEqual([
      account.uid,
      account.uid,
      account.uid,
    ]);
    expect([said.ids.rgid, said.ids.egid, said.ids.sgid]).toEqual([
      account.gid,
      account.gid,
      account.gid,
    ]);
    expect(said.ids.groups).not.toContain(0);
    expect(sorted(said.ids.groups)).toEqual(sorted(own));
    expect(said.regained).toStartWith("refused");
    expect([said.idsAfter.ruid, said.idsAfter.euid, said.idsAfter.suid]).toEqual([
      account.uid,
      account.uid,
      account.uid,
    ]);
  });

  /** The helper, as `hsn` starts it under sudo, for the test account. */
  function helper(mode: "read" | "write", path: string, input?: string) {
    return Bun.spawnSync([process.execPath, HSN, HELPER_ARGUMENT, mode, path], {
      env: { SUDO_UID: String(account.uid), SUDO_GID: String(account.gid), SUDO_USER: NAME },
      cwd: "/",
      stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("the helper reads as the person: their file yes, root's 0600 file no, a link no", () => {
    const theirs = join(work, "theirs.hsnr");
    writeFileSync(theirs, "the person's release");
    chownSync(theirs, account.uid, account.gid);
    chmodSync(theirs, 0o600);
    const rootOnly = join(work, "root-only.hsnr");
    writeFileSync(rootOnly, "root's");
    chmodSync(rootOnly, 0o600);
    chmodSync(work, 0o755);
    expect(helper("read", theirs).stdout.toString()).toBe("the person's release");
    const refused = helper("read", rootOnly);
    expect(refused.exitCode).not.toBe(0);
    const link = join(work, "link.hsnr");
    symlinkSync(theirs, link);
    expect(helper("read", link).exitCode).not.toBe(0);
  });

  test("the helper writes as the person: a 0600 file of theirs, only when the hash matches", () => {
    const folder = join(work, "out");
    mkdirSync(folder);
    chownSync(folder, account.uid, account.gid);
    const target = join(folder, "backup.hsnb");
    const data = Buffer.from("a backup");
    const sha = createHash("sha256").update(data).digest("hex");
    const lines = `${JSON.stringify({ data: data.toString("base64") })}\n${JSON.stringify({ end: sha })}\n`;
    expect(helper("write", target, lines).exitCode).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("a backup");
    expect(statSync(target).uid).toBe(account.uid);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    // Into root's own folder the person cannot write: refused.
    const denied = helper("write", join(work, "denied.hsnb"), lines);
    expect(denied.exitCode).not.toBe(0);
  });
});

describe("the root-only tests, where they cannot run", () => {
  test("say why they were skipped", () => {
    if (!ROOT)
      process.stdout.write(
        "privilege-drop: skipped, not root (the hosted job runs it under sudo)\n",
      );
    else if (NAME === "")
      process.stdout.write("privilege-drop: skipped, HSN_TEST_ACCOUNT not set\n");
    expect(true).toBe(true);
  });
});
