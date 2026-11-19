/**
 * Opening a WebSocket, which throws on an address it cannot use, behind a result (rule 3: every
 * `try` of the bench is in this folder). Used by the bridge's client in a development build.
 */
import { fault, ok, type Outcome } from "../outcome.ts";

/** The part of a WebSocket the bridge's client uses (the browser's, React Native's and Bun's). */
export interface BridgeSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
}

export type MakeSocket = (url: string) => BridgeSocket;

export function openSocket(make: MakeSocket, url: string): Outcome<BridgeSocket, "failed"> {
  try {
    return ok(make(url));
  } catch {
    return fault("failed");
  }
}

/** Sends a text, which throws if the socket closed meanwhile; false then. */
export function sendText(socket: BridgeSocket, text: string): boolean {
  try {
    socket.send(text);
    return true;
  } catch {
    return false;
  }
}
