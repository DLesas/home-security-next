/**
 * Handing a file the app made to the person on a phone (m3-design.md section 2: "the export
 * written to the app's cache and handed to the share sheet"), apart from Expo's modules so it can
 * be tested: what `save-file.native.ts` does. The file is written to the app's cache, the share
 * sheet is opened on it, and once the sheet is closed the cached copy is deleted, so a history
 * export, which is not encrypted, does not stay on the phone unless the person saved it.
 */
import type { Saved } from "./save-file-types";

export interface ShareDeps {
  /** Whether this phone can open the share sheet. */
  readonly available: () => Promise<boolean>;
  /** Writes `bytes` to the app's cache as `name`; resolves with the file's URI. */
  readonly write: (name: string, bytes: Uint8Array) => Promise<string>;
  /** Opens the share sheet on the file; resolves once it is closed. */
  readonly share: (uri: string, mimeType: string) => Promise<void>;
  /** Deletes the cached file. */
  readonly remove: (uri: string) => Promise<void>;
}

/** The type a file's name says: JSON Lines for the history, bytes for anything else. */
export function mimeTypeOf(name: string): string {
  return name.endsWith(".jsonl") ? "application/x-ndjson" : "application/octet-stream";
}

const FAILED: Saved = { ok: false, fault: "failed" };

/** Writes, shares, then deletes; `failed` when any step fails (a refusal is never thrown). */
export async function shareFile(deps: ShareDeps, name: string, bytes: Uint8Array): Promise<Saved> {
  const can = await deps.available().catch(() => false);
  if (!can) return FAILED;
  const uri = await deps.write(name, bytes).catch(() => undefined);
  if (uri === undefined) return FAILED;
  const shared = await deps.share(uri, mimeTypeOf(name)).then(
    () => true,
    () => false,
  );
  await deps.remove(uri).catch(() => undefined);
  return shared ? { ok: true } : FAILED;
}
