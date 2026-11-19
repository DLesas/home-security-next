/**
 * Choosing a file to send to the hub, per platform (m3-design.md section 2): `file-input.web.tsx`
 * is the browser's file input; `file-input.native.tsx` says to do it on the hub computer, since a
 * file is uploaded from the console only (a backup to restore, a release; m2-design.md section 6,
 * "C"). Metro loads one of them in place of this file; tsc and Bun's tests read this one, which
 * binds the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type * as phone from "./file-input.native";
import type { FileChoosing } from "./file-input-types";
import * as web from "./file-input.web";

export type { FileInputProps } from "./file-input-types";

/** Both platforms' files export `FileChoosing`. */
export type Platforms = Split<FileChoosing, typeof web, typeof phone>;

export const { FileInput }: FileChoosing = web;
