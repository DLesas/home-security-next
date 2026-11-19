/** Bun's ws+unix URL syntax, which uses a colon to separate the socket from the HTTP path. */
import { parse, resolve } from "node:path";

const PREFIX = "ws+unix://";

/** On Windows, uses the current drive's rooted path so Bun does not parse a drive as the host. */
export function localSocketUrl(url: string): string {
  if (process.platform !== "win32" || !url.startsWith(PREFIX)) return url;
  const boundary = url.lastIndexOf(":/");
  if (boundary < PREFIX.length) return url;
  const socket = resolve(url.slice(PREFIX.length, boundary));
  const root = parse(socket).root;
  if (root.length !== 3 || root.toLowerCase() !== parse(process.cwd()).root.toLowerCase())
    throw new Error("a local WebSocket must be on the current drive on Windows");
  // A URL with no authority preserves the backslash-rooted path Winsock needs.
  return `ws+unix:${socket.slice(2)}${url.slice(boundary)}`;
}
