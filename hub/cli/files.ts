/**
 * The `hsn` commands that carry a file (m2-design.md section 6, "Commands that carry a file"):
 * `hsn update install <file>`, `hsn restore <file>` and `hsn backup export <file> [--history]`.
 * `hsn` reads and writes the file itself, as the user who runs it, since the hub's account may not
 * be able to read the user's files. An upload goes as `fileChunk` requests on one connection, then
 * the operation names it by its `job`; a download comes back as `fileChunk` lines before the
 * request's reply, into a temporary file renamed when the hash matches.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { FILE_CHUNKS } from "@hsn/protocol/app";
import { err, ok, Result } from "neverthrow";
import type { ChunkLine, ControlError, ReplyLine } from "../src/control-protocol/index.ts";
import type { ClientError, Session } from "./client.ts";

/** A command that carries a file, as `hsn`'s command line gives it. */
export type FileCommand =
  | { readonly kind: "updateInstall"; readonly path: string }
  | { readonly kind: "restore"; readonly path: string }
  | { readonly kind: "backupExport"; readonly path: string; readonly history: boolean };

/** The one upload a command makes on its connection. */
export const UPLOAD_JOB = 1;

/** What went wrong, for `main.ts` to print and turn into an exit code. */
export type FileFailure =
  | { readonly kind: "client"; readonly error: ClientError }
  | { readonly kind: "refused"; readonly error: ControlError }
  | { readonly kind: "file"; readonly message: string }
  | { readonly kind: "declined" };

/** What a finished command prints. */
export type FileDone = readonly string[];

/** What a file command needs of the terminal. */
export interface FileIo {
  readonly out: (line: string) => void;
  /** Asks a question and gives the answer's line. */
  readonly ask: (question: string) => Promise<string>;
  readonly nowMs: () => number;
}

const readFile = Result.fromThrowable(
  (path: string) => new Uint8Array(readFileSync(path)),
  (e) => `cannot read the file: ${e instanceof Error ? e.message : String(e)}`,
);
const writeFile = Result.fromThrowable(
  (path: string, bytes: Uint8Array) => {
    writeFileSync(path, bytes, { mode: 0o600 });
  },
  (e) => `cannot write the file: ${e instanceof Error ? e.message : String(e)}`,
);
const rename = Result.fromThrowable(
  (from: string, to: string) => {
    renameSync(from, to);
  },
  (e) => `cannot rename the file: ${e instanceof Error ? e.message : String(e)}`,
);
const remove = Result.fromThrowable(
  (path: string) => {
    rmSync(path, { force: true });
  },
  () => undefined,
);

// ----- `hsn open`'s page (console-page.ts): the only file calls it makes itself -----

/** What `hsn open` reads of a path, never following a link. */
export interface PageStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isLink: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly size: number;
  readonly atimeMs: number;
  readonly mtimeMs: number;
}

/** The file calls of `hsn open`'s page, behind results; tests give their own. */
export interface PageFs {
  /** The path's own entry (`lstat`), or undefined when there is none. */
  lstat(path: string): PageStat | undefined;
  /** Windows only, where `hsn` runs as the user: the folder, made with its parents. */
  makeFolder(path: string): Result<void, string>;
  /** Windows only: a new file, refused if anything is at the path. */
  writeNew(path: string, text: string): Result<void, string>;
  /** Windows only: the file deleted. */
  remove(path: string): Result<void, string>;
}

const lstatOf = Result.fromThrowable(
  (path: string): PageStat => {
    const st = lstatSync(path);
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      isLink: st.isSymbolicLink(),
      uid: st.uid,
      mode: st.mode,
      size: st.size,
      atimeMs: st.atimeMs,
      mtimeMs: st.mtimeMs,
    };
  },
  () => undefined,
);

/** The real file calls. */
export const PAGE_FS: PageFs = {
  lstat: (path) => lstatOf(path).unwrapOr(undefined),
  makeFolder: Result.fromThrowable(
    (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    () => "cannot make the page's folder",
  ),
  writeNew: Result.fromThrowable(
    (path: string, text: string) => {
      writeFileSync(path, text, { flag: "wx", mode: 0o600 });
    },
    () => "cannot write the page",
  ),
  remove: Result.fromThrowable(
    (path: string) => {
      rmSync(path, { force: true });
    },
    () => "cannot delete the page",
  ),
};

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The chunks of `file` as `fileChunk` commands: 48 KB ‡ each, the last with the count and hash. */
export function chunksOf(file: Uint8Array, job = UPLOAD_JOB) {
  const size = FILE_CHUNKS.maxChunkBytes;
  const count = Math.max(1, Math.ceil(file.length / size));
  const sha256 = sha256Hex(file);
  return Array.from({ length: count }, (_, n) => ({
    kind: "fileChunk" as const,
    job,
    n,
    data: base64url(file.subarray(n * size, (n + 1) * size)),
    ...(n === count - 1 ? { end: { chunks: count, sha256 } } : {}),
  }));
}

/** A reply's success, or the refusal or the client's error. */
function answered(result: Result<ReplyLine, ClientError>): Result<unknown, FileFailure> {
  if (result.isErr()) return err({ kind: "client", error: result.error });
  const reply = result.value.reply;
  if (!reply.ok) return err({ kind: "refused", error: reply.error });
  return ok(reply.result.kind === "op" ? reply.result.body : undefined);
}

async function upload(
  session: Session,
  actor: string,
  file: Uint8Array,
  timeoutMs: number,
): Promise<Result<void, FileFailure>> {
  for (const chunk of chunksOf(file)) {
    const sent = answered(await session.request(actor, chunk, timeoutMs));
    if (sent.isErr()) return err(sent.error);
  }
  return ok(undefined);
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null && name in body
    ? (body as Record<string, unknown>)[name]
    : undefined;
}

function day(ms: unknown): string {
  return typeof ms === "number" ? new Date(ms).toISOString().slice(0, 10) : "?";
}

/** Runs one file command on an open session. */
export async function runFileCommand(
  command: FileCommand,
  session: Session,
  actor: string,
  io: FileIo,
  timeoutMs: number,
  qrLines: (text: string) => readonly string[],
): Promise<Result<FileDone, FileFailure>> {
  switch (command.kind) {
    case "updateInstall": {
      const file = readFile(command.path);
      if (file.isErr()) return err({ kind: "file", message: file.error });
      const uploaded = await upload(session, actor, file.value, timeoutMs);
      if (uploaded.isErr()) return err(uploaded.error);
      const staged = answered(
        await session.request(
          actor,
          { kind: "op", op: "update.upload", body: { job: UPLOAD_JOB } },
          timeoutMs,
        ),
      );
      return staged.map((body) => [`staged: version ${String(field(body, "version"))}`]);
    }
    case "restore": {
      const file = readFile(command.path);
      if (file.isErr()) return err({ kind: "file", message: file.error });
      const uploaded = await upload(session, actor, file.value, timeoutMs);
      if (uploaded.isErr()) return err(uploaded.error);
      const started = answered(
        await session.request(
          actor,
          { kind: "op", op: "restore.start", body: { job: UPLOAD_JOB } },
          timeoutMs,
        ),
      );
      if (started.isErr()) return err(started.error);
      const body = started.value;
      const lastChange = field(body, "lastChangeMs");
      const ageDays =
        typeof lastChange === "number"
          ? Math.floor((io.nowMs() - lastChange) / 86_400_000)
          : undefined;
      io.out(
        `this backup is of hub ${String(field(body, "identity"))}, made ${day(field(body, "madeMs"))}`,
      );
      io.out(
        `its people and permissions are from ${day(lastChange)}${ageDays === undefined ? "" : ` (${ageDays} days ago)`}: anyone removed since then can use the hub again`,
      );
      const answer = await io.ask("go on? [y/N] ");
      if (!/^y(?:es)?$/iu.test(answer.trim())) return err({ kind: "declined" });
      const qr = String(field(body, "qr"));
      for (const line of qrLines(qr)) io.out(line);
      io.out(qr);
      io.out("scan it with a phone that holds this hub's backup key; waiting for the restore");
      await session.closedByHub();
      return ok(["the hub restarts as the restored hub"]);
    }
    case "backupExport": {
      const parts: Uint8Array[] = [];
      const seen: {
        last: ChunkLine["fileChunk"] | undefined;
        gap: boolean;
        failed: string | undefined;
      } = { last: undefined, gap: false, failed: undefined };
      // The reply `{job}` first, then the chunks, ending with the end mark or `fileFailed`
      // (section 6); nothing is written unless the whole file came.
      const exported = answered(
        await session.request(
          actor,
          { kind: "op", op: "backup.export", body: { history: command.history } },
          undefined,
          {
            onChunk: (chunk) => {
              if (chunk.n !== parts.length) seen.gap = true;
              parts.push(Buffer.from(chunk.data, "base64url"));
              seen.last = chunk;
            },
            onFailed: (reason) => {
              seen.failed = reason;
            },
          },
        ),
      );
      if (exported.isErr()) return err(exported.error);
      if (seen.failed !== undefined)
        return err({
          kind: "file",
          message: `the export stopped (${seen.failed === "stopping" ? "the hub is stopping" : "the hub could not make it"}): nothing was saved`,
        });
      const bytes = Buffer.concat(parts);
      const end = seen.last?.end;
      const whole = end?.chunks === parts.length && end.sha256 === sha256Hex(bytes);
      if (seen.gap || !whole)
        return err({
          kind: "file",
          message: "the export arrived with a gap, a wrong total or a wrong hash",
        });
      const temporary = `${command.path}.part`;
      const written = writeFile(temporary, bytes).andThen(() => rename(temporary, command.path));
      if (written.isErr()) {
        remove(temporary).unwrapOr(undefined);
        return err({ kind: "file", message: written.error });
      }
      return ok([`exported ${bytes.length} bytes to ${command.path}`]);
    }
  }
}
