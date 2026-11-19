/**
 * A QR code's modules (m2-design.md section 8; m3-design.md section 2: "the same modules, `toqr`,
 * drawn as runs of Views" on a phone), shared by both drawings: `qr.web.tsx` draws them as one
 * SVG path, `qr.native.tsx` as rows of runs. Pure, so both are tested against the same matrix.
 */
import { toQR } from "toqr";

/** The four-module quiet zone the standard asks for around the code. */
export const QUIET = 4;

/** The code's modules: `size` × `size`, row by row, true for dark. */
export interface QrMatrix {
  readonly size: number;
  readonly dark: readonly boolean[];
}

export function qrMatrix(text: string): QrMatrix {
  const modules = toQR(text);
  const size = Math.round(Math.sqrt(modules.length));
  return { size, dark: Array.from(modules, (m) => m === 1) };
}

/** The dark modules of `text`'s code, as an SVG path in module units, and the code's size. */
export function qrPath(text: string): { readonly size: number; readonly path: string } {
  const { size, dark } = qrMatrix(text);
  let path = "";
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (dark[row * size + col] === true) path += `M${String(col)} ${String(row)}h1v1h-1z`;
  return { size, path };
}

/** A stretch of one row, all dark or all light, `length` modules long. */
export interface Run {
  readonly dark: boolean;
  readonly length: number;
}

/** Each row as runs, left to right, covering the row: a phone draws one View per run. */
export function qrRows(matrix: QrMatrix): readonly (readonly Run[])[] {
  const rows: Run[][] = [];
  for (let row = 0; row < matrix.size; row++) {
    const runs: Run[] = [];
    for (let col = 0; col < matrix.size; col++) {
      const dark = matrix.dark[row * matrix.size + col] === true;
      const last = runs[runs.length - 1];
      if (last?.dark === dark) runs[runs.length - 1] = { dark, length: last.length + 1 };
      else runs.push({ dark, length: 1 });
    }
    rows.push(runs);
  }
  return rows;
}

/**
 * One module's side in points on a screen of `scale` pixels per point: a whole number of the
 * screen's pixels, so no seam shows between runs, and the code with its quiet zone at least 180
 * points wide, as the web draws it, with at least 4 points a module.
 */
export function moduleSide(size: number, scale: number): number {
  const box = size + 2 * QUIET;
  const pixels = Math.max(Math.ceil(4 * scale), Math.ceil((180 * scale) / box));
  return pixels / scale;
}
