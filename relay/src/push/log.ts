/**
 * The push role's log (docs/m4-design.md section 3, "What the relay stores": counts and errors
 * only, to standard error and the host's journal). One JSON line per event.
 *
 * What a line can hold is fixed by its type: an event name, numbers, booleans, words from
 * `LogWord` and a `PushError`. No free text: so no push token, `h`, JWT, access token, key,
 * credential, relay identity or address can reach the log by mistake. A `PushError`'s message is
 * built from fixed texts and library codes (`errors.ts`, `safe/thrown.ts`).
 */
import type { PushError } from "./errors.ts";

export type PushLogLevel = "info" | "warning" | "error";

export type PushLogEvent =
  | "started"
  | "listening"
  | "stopped"
  | "refusedRelays"
  | "upgradeRefused"
  | "linkJoined"
  | "linkRefused"
  | "linkClosed"
  | "pushFrame"
  | "pushLimited"
  | "pushDropped"
  | "operatorAlert"
  | "credentialsRenewed"
  | "credentialsFailed"
  | "serviceUnreachable"
  | "relayLinkUp"
  | "relayLinkDown"
  | "relayLinkRefused"
  | "releasesUnreachable"
  | "fatal";

/** The only words a log line may carry beside numbers and booleans. */
export type LogWord =
  | "apns"
  | "fcm"
  | "production"
  | "development"
  | "accepted"
  | "badToken"
  | "limited"
  | "failed"
  | "pair"
  | "relayKey"
  | "address"
  | "total"
  | "frames"
  | "rate"
  | "busy"
  | "unauthenticated"
  | "authenticated"
  | "operator"
  | "local"
  | "remote"
  | "notConfigured"
  | "badRequest"
  | "payloadTooLarge"
  | "topic"
  | "wrongApp"
  | "notFound"
  | "credentials"
  | "rateLimited"
  | "unavailable"
  | "timeout"
  | "connection"
  | "other";

export type PushLogFields = Readonly<Record<string, number | boolean | LogWord>>;

export interface PushLog {
  write(level: PushLogLevel, event: PushLogEvent, fields?: PushLogFields, error?: PushError): void;
}

/** A log writing one JSON line per event through `line` (standard error in the push role). */
export function jsonLineLog(line: (text: string) => void, now: () => number): PushLog {
  return {
    write(level, event, fields, error) {
      const record = {
        at: new Date(now()).toISOString(),
        level,
        event,
        ...fields,
        ...(error === undefined ? {} : { error }),
      };
      line(`${JSON.stringify(record)}\n`);
    },
  };
}

/** A log that keeps nothing, for code paths a test does not watch. */
export const SILENT_LOG: PushLog = { write: () => undefined };
