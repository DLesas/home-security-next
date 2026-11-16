/**
 * The web app's files (m2-design.md sections 5 and 8): the Expo export, served from the install
 * folder to `GET` and `HEAD` only. What may be served is exactly the set of regular files under
 * the web root, listed once when the listeners open by a walk that never leaves the root and never
 * follows a link; a request is looked up in that set and nothing else, so no name can reach a file
 * outside it, whatever characters the build gives its files (Expo names a route's chunk
 * `[id]-<hash>.js`). A request path is percent-decoded first, refusing an encoded separator or
 * NUL and any malformed escape; a path with no extension is a route of the app and gets
 * `index.html`.
 */
import { extname, join } from "node:path";
import { folderNames, lstatPath } from "../safe/fs.ts";

const ORIGIN = "shell/app/static-files";
const CALLER = { kind: "config", origin: ORIGIN } as const;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** A build holds a few hundred files; a walk past these limits stops (a misconfigured root). */
const MAX_FILES = 10_000;
const MAX_DEPTH = 32;

/** A file to serve: its path and type. */
export interface StaticFile {
  readonly path: string;
  readonly type: string;
}

/**
 * Every regular file under `root`, by its URL path (`/a/b.js`): directories are entered only when
 * they are directories themselves, never through a link, and links are never listed.
 */
function walk(root: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  const visit = (folder: string, url: string, depth: number): void => {
    if (depth > MAX_DEPTH || files.size >= MAX_FILES) return;
    const names = folderNames(CALLER, folder);
    if (names.isErr()) return;
    for (const name of names.value) {
      if (name.includes("/") || name.includes("\\") || name.includes("\0")) continue;
      const path = join(folder, name);
      const st = lstatPath(CALLER, "look at a web file", path);
      // `lstat`: a link is neither a file nor a folder here, so it is never entered nor listed.
      if (st.isErr() || st.value === undefined) continue;
      if (st.value.isDirectory()) visit(path, `${url}${name}/`, depth + 1);
      else if (st.value.isFile() && files.size < MAX_FILES) files.set(`${url}${name}`, path);
    }
  };
  const top = lstatPath(CALLER, "look at the web root", root);
  if (top.isOk() && top.value?.isDirectory() === true) visit(root, "/", 0);
  return files;
}

/**
 * A request path, percent-decoded: undefined for a malformed escape, an encoded separator (`%2F`,
 * `%5C`) or NUL, or bytes that are not UTF-8.
 */
export function decodedPath(pathname: string): string | undefined {
  if (/%(?:2f|5c|00)/iu.test(pathname) || pathname.includes("\0")) return undefined;
  if (/%(?![0-9a-fA-F]{2})/u.test(pathname)) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < pathname.length; i++) {
    const char = pathname[i] ?? "";
    if (char === "%") {
      bytes.push(Number.parseInt(pathname.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(char));
    }
  }
  const raw = Uint8Array.from(bytes);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  return Buffer.from(text, "utf8").equals(Buffer.from(raw)) ? text : undefined;
}

export class StaticFiles {
  readonly #files: ReadonlyMap<string, string>;

  /** Lists the build's files once: what is added to the folder later is not served. */
  constructor(root: string) {
    this.#files = walk(root);
  }

  /** How many files may be served, for tests. */
  get count(): number {
    return this.#files.size;
  }

  /** The file a request path names, or undefined: 404. */
  find(pathname: string): StaticFile | undefined {
    const decoded = decodedPath(pathname);
    if (decoded?.startsWith("/") !== true) return undefined;
    // An absolute path inside the path, and `.` or `..` segments, name nothing (refused plainly).
    const segments = decoded.split("/").slice(1);
    if (segments.some((s, i) => s === "." || s === ".." || (s === "" && i < segments.length - 1)))
      return undefined;
    const wanted = decoded.endsWith("/") || extname(decoded) === "" ? "/index.html" : decoded;
    const path = this.#files.get(wanted);
    return path === undefined
      ? undefined
      : { path, type: TYPES[extname(path)] ?? "application/octet-stream" };
  }
}
