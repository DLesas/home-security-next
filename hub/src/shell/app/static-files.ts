/**
 * The web app's files (m2-design.md sections 5 and 8): the Expo export, served from the install
 * folder to `GET` and `HEAD` only. A path is a plain one inside the folder, of the characters an
 * export uses, with no `.` or `..` segment and nothing percent-encoded, so nothing outside the
 * folder can be named; a path with no extension is a route of the app and gets `index.html`.
 */
import { extname, join, resolve, sep } from "node:path";
import { statPath } from "../safe/fs.ts";

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

const PLAIN_PATH = /^\/[A-Za-z0-9._~@+/-]*$/u;

/** A file to serve: its path and type. */
export interface StaticFile {
  readonly path: string;
  readonly type: string;
}

export class StaticFiles {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  /** The file a request path names, or undefined: 404. */
  find(pathname: string): StaticFile | undefined {
    if (!PLAIN_PATH.test(pathname)) return undefined;
    const segments = pathname.split("/").slice(1);
    if (segments.some((s, i) => s === "." || s === ".." || (s === "" && i < segments.length - 1))) {
      return undefined;
    }
    const wanted = pathname.endsWith("/") || extname(pathname) === "" ? "/index.html" : pathname;
    const path = resolve(join(this.#root, wanted));
    if (!path.startsWith(this.#root + sep)) return undefined;
    const stat = statPath(CALLER, "look at a web file", path);
    if (stat.isErr() || !stat.value.isFile()) return undefined;
    return { path, type: TYPES[extname(path)] ?? "application/octet-stream" };
  }
}
