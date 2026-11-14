#!/usr/bin/env bun
/**
 * Spike W2 (docs/m2-design.md section 9): a command socket only the right accounts can reach.
 *
 *   bun w2.ts --out results/w2.jsonl
 *
 * Prints one JSON line per test and appends it to the results file. Never fails for an option
 * that does not work: the table is the product. Steps that need Windows (access lists, the second
 * account, named pipes) are reported as "skip" elsewhere, so the plumbing can be tried on a Mac.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  aclOf,
  arg,
  asOtherUser,
  asSelf,
  ensureOtherUser,
  folders,
  icacls,
  isWindows,
  lockFolder,
  newPassword,
  OTHER_USER,
  prepareShared,
  report,
  run,
  runAsync,
  SID,
  type Verdict,
} from "./lib.ts";
import { listen, newSecret } from "./server.ts";

const OUT = arg("--out", join(import.meta.dir, "results", "w2.jsonl"));
const line = (test: string, result: Verdict, observed: unknown, expected?: Verdict): void =>
  report(OUT, { spike: "W2", test, result, observed, ...(expected === undefined ? {} : { expected }) });

const f = folders();
rmSync(f.base, { recursive: true, force: true });
mkdirSync(f.base, { recursive: true });
const shared = prepareShared();

line("environment", "pass", {
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  user: userInfo().username,
  admin: isWindows ? run(["net", "session"]).code === 0 : process.getuid?.() === 0,
  sharedFolder: shared.log.map((r) => r.code),
});

// ----- The second local account, and whether a process can run as it -----
const password = newPassword();
let otherReady = false;
if (isWindows) {
  const made = ensureOtherUser(password);
  const who = made.code === 0 ? await asOtherUser(password, ["whoami", ""], "whoami") : undefined;
  otherReady = who?.outcome?.["user"] !== undefined;
  line("second account: created, and a process runs as it", otherReady ? "pass" : "inconclusive", {
    account: OTHER_USER,
    created: made.code === 0,
    sid: made.out.split(/\r?\n/u).at(-1),
    createError: made.code === 0 ? undefined : made.err.slice(0, 400),
    method: who?.method,
    ranAs: who?.outcome?.["user"],
    errors: who?.errors,
  });
} else line("second account: created, and a process runs as it", "skip", "not Windows");

/** The second account's attempt, as a result for the tests below. */
async function other(args: readonly string[], label: string) {
  if (!isWindows) return { skipped: "not Windows" } as const;
  if (!otherReady) return { skipped: "no process could run as the second account" } as const;
  return asOtherUser(password, args, label);
}

// ----- Option (a): a Unix-domain socket -----
lockFolder(f.locked);
mkdirSync(f.open, { recursive: true });
const programData = isWindows ? join(process.env["ProgramData"] ?? "C:\\ProgramData", "HSN Spike") : join(f.base, "programdata");
mkdirSync(programData, { recursive: true });
const where: Record<string, string> = {
  "the user's temp folder": join(process.env["TEMP"] ?? f.base, "hsn-w2"),
  "an ordinary folder (inherited access list)": f.open,
  "a folder locked to the user, Administrators and SYSTEM": f.locked,
  "ProgramData": programData,
};

let unixWorks = false;
let lockedRefusesOther = false;
for (const api of ["unix-node", "unix-bun"] as const) {
  for (const [name, folder] of Object.entries(where)) {
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${api}.sock`);
    rmSync(path, { force: true });
    const test = `(a) AF_UNIX with ${api === "unix-node" ? "node:net" : "Bun.listen"} in ${name}`;
    let server;
    try {
      server = await listen(api, path);
    } catch (e) {
      line(`${test}: listen`, "fail", { path, error: String(e) });
      continue;
    }
    const file = existsSync(path);
    let kind = "missing";
    try {
      const s = statSync(path);
      kind = s.isSocket() ? "socket" : s.isFile() ? "file" : "other";
    } catch (e) {
      kind = `stat failed: ${String(e).slice(0, 120)}`;
    }
    const selfNode = await asSelf(["unix-node", path], `${api}-${Object.keys(where).indexOf(name)}-node`);
    const selfBun = await asSelf(["unix-bun", path], `${api}-${Object.keys(where).indexOf(name)}-bun`);
    const sameUser = selfNode?.["ok"] === true || selfBun?.["ok"] === true;
    // A real AF_UNIX socket leaves a file at the path; a path mapped to a named pipe does not.
    const isUnix = file;
    if (isUnix && sameUser) unixWorks = true;
    line(`${test}: listen, file, same-user connect`, isUnix && sameUser ? "pass" : "fail", {
      path,
      fileAtPath: file,
      kind,
      fileAcl: file ? aclOf(path) : undefined,
      selfNode,
      selfBun,
    });
    const otherTry = await other(["unix-node", path], `${api}-${Object.keys(where).indexOf(name)}-other`);
    const otherConnected = "outcome" in otherTry ? otherTry.outcome?.["ok"] === true : undefined;
    const locked = folder === f.locked;
    if (locked && otherConnected === false) lockedRefusesOther = true;
    line(
      `${test}: the second account`,
      otherConnected === undefined ? ("skipped" in otherTry ? "skip" : "inconclusive") : otherConnected ? "fail" : "pass",
      { connected: otherConnected, attempt: otherTry, folderAcl: aclOf(folder) },
      // In an ordinary folder the inherited access list lets every user in: refusal is not expected.
      locked ? "pass" : undefined,
    );
    // The socket file's own access list, without the folder's help (an installer could set it).
    if (!locked && file && isWindows && folder === f.open) {
      const set = icacls(path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`, `${SID.administrators}:F`, `${SID.system}:F`);
      const again = await other(["unix-node", path], `${api}-fileacl-other`);
      const againConnected = "outcome" in again ? again.outcome?.["ok"] === true : undefined;
      const self = await asSelf(["unix-node", path], `${api}-fileacl-self`);
      line(
        `${test}: the socket file's own access list set, the second account`,
        againConnected === undefined ? "inconclusive" : againConnected ? "fail" : "pass",
        { icacls: set.code, fileAcl: aclOf(path), otherConnected: againConnected, attempt: again, selfStillConnects: self?.["ok"] },
        "pass",
      );
    }
    await server.close();
  }
}

// ----- Option (b)'s cousin, and why it was refused: a named pipe made by node:net -----
if (isWindows) {
  const pipe = `\\\\.\\pipe\\hsn-spike-w2-${process.pid}`;
  for (const api of ["pipe-node", "unix-bun"] as const) {
    const test = `(b) named pipe made by ${api === "pipe-node" ? "node:net" : "Bun.listen"}`;
    let server;
    try {
      server = await listen(api, `${pipe}-${api}`);
    } catch (e) {
      line(`${test}: listen`, "fail", { pipe: `${pipe}-${api}`, error: String(e) });
      continue;
    }
    const self = await asSelf(["pipe-node", `${pipe}-${api}`], `${api}-pipe-self`);
    const otherTry = await other(["pipe-node", `${pipe}-${api}`], `${api}-pipe-other`);
    const otherConnected = "outcome" in otherTry ? otherTry.outcome?.["ok"] === true : undefined;
    line(
      `${test}: the second account`,
      otherConnected === undefined ? "inconclusive" : otherConnected ? "fail" : "pass",
      { selfConnected: self?.["ok"], otherConnected, attempt: otherTry },
      "fail",
    );
    await server.close();
  }
} else line("(b) named pipe made by node:net", "skip", "not Windows");

// ----- Option (c): loopback TCP with a secret file -----
{
  const secret = newSecret();
  const secretFile = join(f.locked, "control.secret");
  writeFileSync(secretFile, `${secret}\n`);
  const server = await listen("tcp-secret", "", secret);
  const port = String(server.port);
  const self = await asSelf(["tcp-secret", port, secretFile], "tcp-self");
  const wrong = await asSelf(["tcp-wrong", port], "tcp-wrong-self");
  line("(c) loopback TCP: the user with the secret file is answered", self?.["ok"] === true ? "pass" : "fail", {
    port,
    secretFileAcl: aclOf(secretFile),
    self,
  });
  line("(c) loopback TCP: a wrong secret is refused", wrong?.["ok"] === false && wrong["connected"] === true ? "pass" : "fail", { wrong });
  const otherRead = await other(["read-file", secretFile], "tcp-other-read");
  const otherCanRead = "outcome" in otherRead ? otherRead.outcome?.["ok"] === true : undefined;
  line(
    "(c) loopback TCP: the second account cannot read the secret file",
    otherCanRead === undefined ? ("skipped" in otherRead ? "skip" : "inconclusive") : otherCanRead ? "fail" : "pass",
    { attempt: otherRead },
  );
  const otherConnect = await other(["tcp-secret", port, secretFile], "tcp-other-connect");
  const otherAnswered = "outcome" in otherConnect ? otherConnect.outcome?.["ok"] === true : undefined;
  line(
    "(c) loopback TCP: the second account connects but is not answered",
    otherAnswered === undefined ? ("skipped" in otherConnect ? "skip" : "inconclusive") : otherAnswered ? "fail" : "pass",
    { attempt: otherConnect },
  );
  // What a web page can do: send an HTTP request to the port. It must get no "pong".
  const before = server.seen.length;
  let pageReply = "";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `${JSON.stringify({ id: 1, actor: "page", command: { kind: "disarm", sensors: "all" } })}\nping\n`,
      signal: AbortSignal.timeout(5000),
    });
    pageReply = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
  } catch (e) {
    pageReply = `request failed: ${String(e).slice(0, 200)}`;
  }
  line("(c) loopback TCP: a page's request (fetch, as a browser sends it) is refused", pageReply.includes("pong") ? "fail" : "pass", {
    reply: pageReply,
    firstLinesSeen: server.seen.slice(before, before + 3),
  });
  // A real browser, when there is one: headless Edge loading a page that posts to the port. The
  // page is served by a second local server, which it also tells when it has run, so a page that
  // never ran is told apart from a request the browser itself blocked.
  const edge = isWindows ? findEdge() : process.env["HSN_EDGE"];
  if (edge !== undefined && existsSync(edge)) {
    const ran: string[] = [];
    const pages = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/ran") {
          ran.push(url.searchParams.get("r") ?? "");
          return new Response("ok");
        }
        return new Response(
          `<!doctype html><title>start</title><script>
fetch("http://127.0.0.1:${port}/",{method:"POST",mode:"no-cors",headers:{"content-type":"text/plain"},body:"ping\\n"})
  .then(()=>"sent",(e)=>"failed: "+e)
  .then((r)=>{document.title=r;return fetch("/ran?r="+encodeURIComponent(r))});
</script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const seenBefore = server.seen.length;
    const profile = join(f.out, "edge-profile");
    const r = await runAsync(
      [edge, "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", `http://127.0.0.1:${pages.port}/`],
      {},
      45_000,
    );
    await Bun.sleep(500);
    void pages.stop(true);
    const seen = server.seen.slice(seenBefore);
    const pageRan = ran.length > 0 || r.out.includes("<title>sent") || r.out.includes("<title>failed");
    const answered = seen.length > 0 && seen[0] === secret;
    line(
      "(c) loopback TCP: a real browser page's request (headless Edge) is refused",
      !pageRan ? "inconclusive" : answered ? "fail" : "pass",
      {
        browser: edge,
        exit: r.code,
        pageRan,
        pageSays: ran,
        linesSeen: seen.slice(0, 4),
        meaning: !pageRan
          ? "the page never ran: nothing is shown either way"
          : seen.length === 0
            ? "the browser itself did not deliver the request (Private Network Access or the like)"
            : "the request reached the port and was refused: its first line is not the secret",
        stderr: pageRan ? undefined : r.err.slice(-600),
      },
    );
  } else line("(c) loopback TCP: a real browser page's request (headless Edge) is refused", "skip", isWindows ? "no Edge found" : "not Windows (HSN_EDGE names a Chromium to try it)");
  await server.close();
}

// ----- The verdict, by the design's recommendation -----
line(
  "verdict",
  unixWorks && lockedRefusesOther ? "pass" : "inconclusive",
  unixWorks && lockedRefusesOther
    ? "option (a): Bun reaches AF_UNIX and a locked folder keeps the second account out"
    : "option (a) not shown to work here: see the (a) lines; option (c) per its lines",
);

function findEdge(): string | undefined {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((c) => existsSync(c));
}
