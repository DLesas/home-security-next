/**
 * The relay's log (docs/m4-design.md section 3, "What the relay stores": standard error, to the
 * host's journal; counts and errors only, no identity together with an IP address, and no
 * content). One JSON line per event.
 *
 * What a line can hold is fixed by its type: an event name, numbers, booleans, words from
 * `LogWord` and a `RelayError` (whose message is fixed text and a library's code). No free text,
 * so no identity, address, pseudonym, token, `h`, frame or Noise message can reach the log, by
 * mistake or otherwise: the log names no identity at all, which is stronger than the design asks.
 */
import type { RelayError } from "./errors.ts";

export type RelayLogLevel = "info" | "warning" | "error";

export type RelayLogEvent =
  | "started"
  | "listening"
  | "stopping"
  | "stopped"
  | "fatal"
  | "config"
  | "storage"
  | "upgradeRefused"
  | "handshakeFailed"
  | "hubJoined"
  | "hubRefused"
  | "hubClosed"
  | "streamRefused"
  | "streamClosed"
  | "slowReader"
  | "roster"
  | "pushFrame"
  | "alertSent"
  | "operatorAlert"
  | "sweep"
  | "presenceStalled"
  | "releaseIndex"
  | "releaseRefused"
  | "releaseError"
  | "upstream"
  | "refusedHubs";

/** The only words a log line may carry beside numbers and booleans. */
export type LogWord =
  | "hub"
  | "phone"
  | "relay"
  | "local"
  | "rate"
  | "busy"
  | "badPath"
  | "notConnected"
  | "perHub"
  | "perAddress"
  | "inAll"
  | "traffic"
  | "full"
  | "newIdentity"
  | "storedIdentities"
  | "refused"
  | "badFrame"
  | "timeout"
  | "noSharedVersion"
  | "overLimit"
  | "queue"
  | "unreachable"
  | "back"
  | "linkDown"
  | "limited"
  | "notFound"
  | "range"
  | "limit"
  | "unavailable"
  | "fetched"
  | "failed";

export type RelayLogFields = Readonly<Record<string, number | boolean | LogWord>>;

export interface RelayLog {
  write(
    level: RelayLogLevel,
    event: RelayLogEvent,
    fields?: RelayLogFields,
    error?: RelayError,
  ): void;
}

/** A log writing one JSON line per event through `line` (standard error in the program). */
export function jsonLineLog(line: (text: string) => void, now: () => number): RelayLog {
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

/** A log that keeps nothing. */
export const SILENT_LOG: RelayLog = { write: () => undefined };
