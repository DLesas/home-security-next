/**
 * The types of `save-file.ts`'s pair, apart from it: in the phone's type check
 * (`tsconfig.native.json`) `./save-file` is the phone's file.
 */
import type { NotBuilt } from "./split";

/** Why a file was not handed over. */
export type SaveFault = "failed" | NotBuilt["fault"];

export type Saved = { readonly ok: true } | { readonly ok: false; readonly fault: SaveFault };

export interface SaveFiles {
  /** Hands `bytes` over under the file name `name`; resolves once handed over, or refused. */
  readonly saveFile: (name: string, bytes: Uint8Array) => Promise<Saved>;
}
