/**
 * A QR code drawn for a person to scan, per platform (m3-design.md section 2): `qr.web.tsx` as SVG,
 * `qr.native.tsx` as Views (no SVG package on the phone, section 8). Both draw `qr-matrix.ts`'s
 * modules. Metro loads one of them in place of this file; tsc and Bun's tests read this one, which
 * binds the web build's (`platform/split.ts`).
 */
import type { Split } from "../platform/split";
import type * as phone from "./qr.native";
import type { QrDrawing } from "./qr-types";
import * as web from "./qr.web";

export type { QrCodeProps } from "./qr-types";
export { qrPath } from "./qr-matrix";

/** Both platforms' files export `QrDrawing`. */
export type Platforms = Split<QrDrawing, typeof web, typeof phone>;

export const { QrCode }: QrDrawing = web;
