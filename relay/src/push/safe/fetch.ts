/**
 * `fetch` behind a result, for FCM and Google's token endpoint (docs/m4-design.md section 10:
 * "`fetch` for FCM"). A rejected fetch becomes `timeout` or `connection` with its code only: its
 * message may name the request.
 */
import { err, ok, type Result } from "neverthrow";
import { thrownCode } from "./thrown.ts";

export interface FetchAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

export type FetchFailure =
  { readonly kind: "timeout" } | { readonly kind: "connection"; readonly code?: string };

export interface FetchRequest {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly timeoutMs: number;
  /** A certificate authority to trust instead of the system's: the stand-ins' only (tests). */
  readonly ca?: string;
}

/** Sends a request and reads its whole answer. Never rejects. */
export async function fetchText(
  url: string,
  request: FetchRequest,
): Promise<Result<FetchAnswer, FetchFailure>> {
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(request.timeoutMs),
      ...(request.ca === undefined ? {} : { tls: { ca: request.ca } }),
    });
    const body = await response.text();
    return ok({ status: response.status, headers: response.headers, body });
  } catch (thrown) {
    const code = thrownCode(thrown);
    const name = thrown instanceof Error ? thrown.name : "";
    if (name === "TimeoutError" || name === "AbortError") return err({ kind: "timeout" });
    return err(code === undefined ? { kind: "connection" } : { kind: "connection", code });
  }
}
