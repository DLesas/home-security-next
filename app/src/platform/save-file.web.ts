/**
 * A file the app made, downloaded by the browser (m2-design.md section 9, the export), the web
 * build's side of `save-file.ts`: a link to the bytes, clicked; the link is let go after 10 s.
 */
import type { Saved } from "./save-file-types";

export function saveFile(name: string, bytes: Uint8Array): Promise<Saved> {
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 10_000);
  return Promise.resolve({ ok: true });
}
