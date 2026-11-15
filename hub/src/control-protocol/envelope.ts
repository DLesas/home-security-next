/**
 * The control socket's lines (hub-design.md section 9): one JSON request per line, one JSON
 * reply per line, and for `hsn log --follow` one line per streamed record; in M2, a download's
 * `fileChunk` lines before its reply (m2-design.md section 6). A line is at most
 * `CONTROL_LINE_BYTES`.
 */
import { FILE_FAILED_REASONS, fileChunkBody } from "@hsn/protocol/app";
import { z } from "zod";
import { controlCommand } from "./commands.ts";
import { recordJson } from "./records.ts";
import { controlReply } from "./replies.ts";

/** The client's number for a request, echoed in its reply and stream lines. */
const requestNumber = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const requestLine = z
  .strictObject({
    id: requestNumber,
    /** The user name the CLI reports; the socket's permissions are the real check (AL8). */
    actor: z.string().min(1),
    command: controlCommand,
  })
  .readonly();

export const replyLine = z.object({ id: requestNumber, reply: controlReply }).readonly();

/** A record streamed to a `--follow` request, in the order the core made them. */
export const streamLine = z.object({ id: requestNumber, record: recordJson }).readonly();

/**
 * One chunk of a download (`hsn backup export`), on the request's connection after its reply
 * `{job}` (m2-design.md section 6): the chunks in order, the last with its end mark.
 */
export const chunkLine = z.strictObject({ id: requestNumber, fileChunk: fileChunkBody }).readonly();

/** A download that stops before its end mark, on the request's connection: nothing was saved. */
export const fileFailedLine = z
  .strictObject({
    id: requestNumber,
    kind: z.literal("fileFailed"),
    job: z.int().min(1),
    reason: z.enum(FILE_FAILED_REASONS),
  })
  .readonly();

export type RequestLine = z.infer<typeof requestLine>;
export type ChunkLine = z.infer<typeof chunkLine>;
export type FileFailedLine = z.infer<typeof fileFailedLine>;
export type ReplyLine = z.infer<typeof replyLine>;
export type StreamLine = z.infer<typeof streamLine>;
