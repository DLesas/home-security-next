/**
 * A QR code drawn in the terminal (m2-design.md section 6, `hsn restore`): two rows of modules per
 * line with half-block characters, light on dark, in a one-module quiet border.
 */
import { toQR } from "toqr";

const FULL = "█";
const LOWER = "▄";
const UPPER = "▀";
const EMPTY = " ";

/** The lines of `text`'s QR code. */
export function qrLines(text: string): readonly string[] {
  const modules = toQR(text);
  const size = Math.round(Math.sqrt(modules.length));
  const dark = (row: number, col: number) =>
    row >= 0 && row < size && col >= 0 && col < size && modules[row * size + col] === 1;
  const lines: string[] = [];
  for (let row = -1; row < size + 1; row += 2) {
    let line = "";
    for (let col = -1; col < size + 1; col++) {
      const top = dark(row, col);
      const bottom = dark(row + 1, col);
      // Light modules are drawn, so the code reads on a dark terminal.
      line += top ? (bottom ? EMPTY : LOWER) : bottom ? UPPER : FULL;
    }
    lines.push(line);
  }
  return lines;
}
