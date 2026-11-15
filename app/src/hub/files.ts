/**
 * Files over the channel (m2-design.md section 6): `fileChunk` requests up (an upload, on the
 * console only: `restore.start`, `update.upload`) and `fileChunk` events down (`backup.export`),
 * each at most 48 KB ‡, numbered from 0, the last carrying the count and the SHA-256 of the
 * whole, the bytes as base64url without padding. The receiver refuses a gap, a wrong total or a
 * wrong hash. File bytes never enter the hub's core; here they never enter the live store.
 */
import { type AppEvent, FILE_CHUNKS } from "@hsn/protocol/app";
import type { Requester, RequestOutcome } from "./channel";
import { sha256, toHex } from "./digest";
import type { Timers } from "./wire";

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) return undefined;
  const padded =
    text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Sends a file as `fileChunk` requests, one after another; the first refusal stops it. */
export async function sendFile(
  hub: Requester,
  job: number,
  bytes: Uint8Array,
  progress: (sent: number, total: number) => void = () => undefined,
): Promise<RequestOutcome<"fileChunk">> {
  const size = FILE_CHUNKS.maxChunkBytes;
  const chunks = Math.max(1, Math.ceil(bytes.length / size));
  const hash = toHex(await sha256(bytes));
  let last: RequestOutcome<"fileChunk"> = { ok: false, local: "offline" };
  for (let n = 0; n < chunks; n++) {
    const data = toBase64url(bytes.subarray(n * size, (n + 1) * size));
    const end = n === chunks - 1 ? { end: { chunks, sha256: hash } } : {};
    last = await hub.request("fileChunk", { job, n, data, ...end });
    if (!last.ok) return last;
    progress(n + 1, chunks);
  }
  return last;
}

/** `io` and `stopping`: the hub said, with `fileFailed`, that it could not finish the file. */
export type DownloadFault = "gap" | "hash" | "badChunk" | "stalled" | "io" | "stopping";

/** How long a download waits for its next chunk ‡. */
export const CHUNK_WAIT_MS = 60_000;

/**
 * Gathers a file's `fileChunk` events for `job`: the bytes when the last has come and the count
 * and hash match, or why not.
 */
export function receiveFile(
  onEvent: (listener: (event: AppEvent) => void) => () => void,
  job: number,
  timers: Timers,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly fault: DownloadFault }
> {
  return new Promise((resolve) => {
    const parts: Uint8Array[] = [];
    const state: { finished: boolean; stop: (() => void) | undefined } = {
      finished: false,
      stop: undefined,
    };
    let cancel = timers.after(CHUNK_WAIT_MS, () => {
      finish({ ok: false, fault: "stalled" });
    });
    const finish = (
      result:
        | { readonly ok: true; readonly bytes: Uint8Array }
        | { readonly ok: false; readonly fault: DownloadFault },
    ) => {
      if (state.finished) return;
      state.finished = true;
      cancel();
      state.stop?.();
      resolve(result);
    };
    state.stop = onEvent((event) => {
      if (state.finished) return;
      if (event.ev === "fileFailed" && event.body.job === job) {
        finish({ ok: false, fault: event.body.reason });
        return;
      }
      if (event.ev !== "fileChunk" || event.body.job !== job) return;
      const body = event.body;
      if (body.n !== parts.length) {
        finish({ ok: false, fault: "gap" });
        return;
      }
      const data = fromBase64url(body.data);
      if (data === undefined || data.length > FILE_CHUNKS.maxChunkBytes) {
        finish({ ok: false, fault: "badChunk" });
        return;
      }
      parts.push(data);
      cancel();
      cancel = timers.after(CHUNK_WAIT_MS, () => {
        finish({ ok: false, fault: "stalled" });
      });
      const end = body.end;
      if (end === undefined) return;
      if (end.chunks !== parts.length) {
        finish({ ok: false, fault: "gap" });
        return;
      }
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const part of parts) {
        bytes.set(part, at);
        at += part.length;
      }
      void sha256(bytes).then((digest) => {
        finish(toHex(digest) === end.sha256 ? { ok: true, bytes } : { ok: false, fault: "hash" });
      });
    });
    // Chunks replayed while subscribing may have finished it already.
    if (state.finished) state.stop();
  });
}

/**
 * A download (`backup.export`): the chunks are gathered from before the request is sent, since
 * they may come before its reply; then those of the reply's job are kept.
 */
export async function downloadFile(
  hub: Requester & { onEvent(listener: (event: AppEvent) => void): () => void },
  history: boolean,
  timers: Timers,
): Promise<
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly fault: DownloadFault }
  | Exclude<RequestOutcome<"backup.export">, { readonly ok: true }>
> {
  const early: AppEvent[] = [];
  const stopEarly = hub.onEvent((event) => {
    if (event.ev === "fileChunk" || event.ev === "fileFailed") early.push(event);
  });
  const asked = await hub.request("backup.export", { history });
  if (!asked.ok) {
    stopEarly();
    return asked;
  }
  const job = asked.body.job;
  // The events that came before the reply, then the live ones, in order.
  const replay = (listener: (event: AppEvent) => void) => {
    stopEarly();
    for (const event of early) listener(event);
    return hub.onEvent(listener);
  };
  return receiveFile(replay, job, timers);
}

/** A job number for an upload, unique among this connection's uploads (section 6). */
export function uploadJob(): number {
  const n = new Uint32Array(1);
  globalThis.crypto.getRandomValues(n);
  return (n[0] ?? 1) % 0x7fffffff || 1;
}
