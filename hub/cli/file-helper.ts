/**
 * The helper that opens a person's file as that person (m2-design.md section 9, "Files a person
 * names to `hsn`"), on macOS and Linux under `sudo`: `hsn`, still root, re-runs itself with an
 * internal argument; the helper first becomes the invoking user (their groups, group and user,
 * from `SUDO_GID` and `SUDO_USER`, as `elevated.ts`'s drop does), then opens the one file
 * (`named-files.ts`: never following a link in its last part) and streams it through a pipe:
 *
 * - `read`: the file's bytes on its standard output, then it exits 0; a refusal on standard error
 *   and exit 1.
 * - `write`: JSON lines on its standard input, `{"data":"<base64>"}` then `{"end":"<sha256>"}`;
 *   the file is written exclusively beside the target and renamed only once the hash matches.
 * - `page`: `hsn open`'s console page (`console-page.ts`), as the person: one JSON line on its
 *   standard input, `{"url": …, "expiresInMs": …}`, once `hsn` (dropped) has the token; the page
 *   written in the person's own folder, their browser opened in their session, the page deleted
 *   once read or expired; `{"outcome":"read"|"unread"}` on its standard output.
 *
 * Meanwhile `hsn` drops to the hub's account and holds only the pipe; the person's own rights
 * decide what can be read or written, so a path into a hub tree fails, and a link the hub planted
 * is never followed.
 */
import { err, ok, Result } from "neverthrow";
import { openConsoleAddress, type PageOutcome, realPageSystem } from "./console-page.ts";
import { type Account, dropTo, unixPlatform } from "./elevated.ts";
import { type NamedFiles, readNoFollow, writeExclusively } from "./named-files.ts";

/** The internal argument that makes `hsn` the helper. */
export const HELPER_ARGUMENT = "--hsn-file-helper";

/** The command that re-runs this `hsn`: the compiled executable alone, or Bun and the script. */
export function selfCommand(): readonly string[] {
  const main = Bun.main;
  return main.startsWith("/$bunfs/") || main === process.execPath
    ? [process.execPath]
    : [process.execPath, main];
}

/** The helper's own run: becomes the person, then reads or writes the one file. */
export async function runHelper(argv: readonly string[]): Promise<number> {
  const [mode, path] = argv;
  const platform = unixPlatform(process.platform);
  const uid = Number(process.env.SUDO_UID ?? "");
  const gid = Number(process.env.SUDO_GID ?? "");
  const name = process.env.SUDO_USER ?? "";
  const fail = (why: string): number => {
    process.stderr.write(`${why}\n`);
    return 1;
  };
  const page = mode === "page";
  if ((path === undefined && !page) || (mode !== "read" && mode !== "write" && !page))
    return fail("hsn: bad helper call");
  if (platform === undefined) return fail("hsn: the helper runs on macOS and Linux only");
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || name === "" || uid === 0)
    return fail("hsn: the helper needs the person sudo names");
  const became = dropTo({ name, uid, gid }, platform);
  if (became.isErr()) return fail(`hsn: ${became.error}`);
  if (page) return pageAsThePerson(fail);
  if (path === undefined) return fail("hsn: bad helper call");
  if (mode === "read") {
    const read = readNoFollow(path);
    if (read.isErr()) return fail(read.error);
    await Bun.write(Bun.stdout, read.value);
    return 0;
  }
  const lines = (await Bun.stdin.text()).split("\n").filter((line) => line !== "");
  const parts: Uint8Array[] = [];
  let sha: string | undefined;
  const parse = Result.fromThrowable(
    (line: string): unknown => JSON.parse(line),
    () => "not JSON",
  );
  for (const line of lines) {
    const parsed = parse(line);
    const value = parsed.isOk() ? parsed.value : undefined;
    if (typeof value !== "object" || value === null) return fail("hsn: a bad line on the pipe");
    if ("data" in value && typeof value.data === "string")
      parts.push(new Uint8Array(Buffer.from(value.data, "base64")));
    else if ("end" in value && typeof value.end === "string") sha = value.end;
  }
  if (sha === undefined) return fail("hsn: the export stopped: nothing was saved");
  const written = writeExclusively(path, new Uint8Array(Buffer.concat(parts)), sha);
  return written.isErr() ? fail(written.error) : 0;
}

/** `hsn open`'s page, as the person the helper has become (the module's comment, `page`). */
async function pageAsThePerson(fail: (why: string) => number): Promise<number> {
  const line = (await Bun.stdin.text()).split("\n")[0] ?? "";
  const parsed = Result.fromThrowable(
    (text: string): unknown => JSON.parse(text),
    () => "not JSON",
  )(line);
  const value = parsed.isOk() ? parsed.value : undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    !("url" in value) ||
    typeof value.url !== "string" ||
    !("expiresInMs" in value) ||
    typeof value.expiresInMs !== "number"
  )
    return fail("hsn: no console address came on the pipe");
  // Now an ordinary account: `console-page.ts` writes and opens as itself, with no `sudo`.
  const opened = await openConsoleAddress(value.url, value.expiresInMs, realPageSystem());
  if (opened.isErr()) return fail(opened.error);
  process.stdout.write(`${JSON.stringify({ outcome: opened.value })}\n`);
  return 0;
}

/**
 * `hsn open`'s page through a helper started now, while `hsn` is root, as `person`, in that
 * person's session (their runtime folder and bus on Linux; `DISPLAY`s as `sudo` kept them); used
 * only after `hsn` has dropped, by the pipe alone.
 */
export function pageHelper(
  person: Account,
  env: Readonly<Record<string, string | undefined>>,
  command: readonly string[] = selfCommand(),
): (url: string, expiresInMs: number) => Promise<Result<PageOutcome, string>> {
  const runtime = `/run/user/${String(person.uid)}`;
  const display = Object.fromEntries(
    ["DISPLAY", "WAYLAND_DISPLAY"].flatMap((name) => {
      const value = env[name];
      return value === undefined || !/^[A-Za-z0-9:._-]+$/u.test(value) ? [] : [[name, value]];
    }),
  );
  const helper = Bun.spawn([...command, HELPER_ARGUMENT, "page"], {
    cwd: "/",
    env: {
      SUDO_UID: String(person.uid),
      SUDO_GID: String(person.gid),
      SUDO_USER: person.name,
      USER: person.name,
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus`,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      ...display,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return async (url, expiresInMs) => {
    await helper.stdin.write(`${JSON.stringify({ url, expiresInMs })}\n`);
    await helper.stdin.end();
    const [out, errText, code] = await Promise.all([
      new Response(helper.stdout).text(),
      new Response(helper.stderr).text(),
      helper.exited,
    ]);
    if (code !== 0)
      return err(
        errText.trim() === "" ? `the page helper stopped (${String(code)})` : errText.trim(),
      );
    return out.includes('"outcome":"read"') ? ok("read") : ok("unread");
  };
}

/**
 * `NamedFiles` for one file, through a helper started now, while `hsn` is root, as `person`; to
 * be used only after `hsn` has dropped, by the pipe alone.
 */
export function helperFiles(
  person: Account,
  mode: "read" | "write",
  path: string,
  command: readonly string[] = selfCommand(),
): NamedFiles {
  const helper = Bun.spawn([...command, HELPER_ARGUMENT, mode, path], {
    cwd: "/",
    env: { SUDO_UID: String(person.uid), SUDO_GID: String(person.gid), SUDO_USER: person.name },
    stdin: mode === "write" ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = async (): Promise<Result<Uint8Array, string>> => {
    const [out, errText, code] = await Promise.all([
      new Response(helper.stdout).arrayBuffer(),
      new Response(helper.stderr).text(),
      helper.exited,
    ]);
    return code === 0
      ? ok(new Uint8Array(out))
      : err(errText.trim() === "" ? `the file helper stopped (${String(code)})` : errText.trim());
  };
  return {
    read: async (named) => {
      if (mode !== "read" || named !== path) return err(`hsn opened ${path}, not ${named}`);
      return finished();
    },
    write: async (named, bytes, sha256) => {
      const stdin = helper.stdin;
      if (mode !== "write" || named !== path || stdin === undefined)
        return err(`hsn opened ${path} to write, not ${named}`);
      const chunk = 48_000;
      for (let at = 0; at < bytes.length; at += chunk) {
        const data = Buffer.from(bytes.subarray(at, at + chunk)).toString("base64");
        await stdin.write(`${JSON.stringify({ data })}\n`);
      }
      await stdin.write(`${JSON.stringify({ end: sha256 })}\n`);
      await stdin.end();
      return (await finished()).map(() => undefined);
    },
  };
}
