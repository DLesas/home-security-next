/**
 * The control socket's lines (hub-design.md section 9): one JSON request per line, one JSON
 * reply per line, and for `hsn log --follow` one line per streamed record.
 */
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

export type RequestLine = z.infer<typeof requestLine>;
export type ReplyLine = z.infer<typeof replyLine>;
export type StreamLine = z.infer<typeof streamLine>;
