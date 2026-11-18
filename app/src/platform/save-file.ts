/**
 * Handing a file the app made to the person (m3-design.md section 2): a backup or history export.
 * `save-file.web.ts` downloads it in the browser; `save-file.native.ts` will write it to the
 * app's cache (expo-file-system) and hand it to the share sheet (expo-sharing; P5, wave 1). Metro
 * loads one of them in place of this file; tsc and Bun's tests read this one, which binds the web
 * build's (`split.ts`).
 */
import type { SaveFiles } from "./save-file-types";
import type { Split } from "./split";
import type * as phone from "./save-file.native";
import * as web from "./save-file.web";

export type { SaveFault, Saved, SaveFiles } from "./save-file-types";

/** Both platforms' files export `SaveFiles`. */
export type Platforms = Split<SaveFiles, typeof web, typeof phone>;

export const { saveFile }: SaveFiles = web;
