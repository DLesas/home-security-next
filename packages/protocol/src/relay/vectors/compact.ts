/**
 * The compact form of a long value in `relay-frames.json` (`compactHex`, `compactText` in
 * `../vector-formats.ts`; vectors/README.md, "Compact values"): a value is its text itself, or an
 * array of pieces joined in order, each piece text itself or `{repeat, times}`, that text written
 * `times` times.
 */
import type { CompactValue } from "../vector-formats.ts";

/** The value's text: the pieces joined, each `{repeat, times}` written out. */
export function expandCompact(value: CompactValue): string {
  if (typeof value === "string") return value;
  return value
    .map((piece) => (typeof piece === "string" ? piece : piece.repeat.repeat(piece.times)))
    .join("");
}

/**
 * Writes `text` compactly: every run of at least `minRun` equal units (one character of text, or
 * two hex digits for a byte) becomes `{repeat: unit, times}`; the text between runs stays as it
 * is. Text with no such run is written as itself.
 */
export function compactRuns(text: string, unit: 1 | 2, minRun = 32): CompactValue {
  const pieces: (string | { repeat: string; times: number })[] = [];
  let plain = "";
  let at = 0;
  while (at < text.length) {
    const piece = text.slice(at, at + unit);
    let times = 1;
    while (text.slice(at + times * unit, at + (times + 1) * unit) === piece) times += 1;
    if (times >= minRun) {
      if (plain !== "") pieces.push(plain);
      plain = "";
      pieces.push({ repeat: piece, times });
    } else {
      plain += text.slice(at, at + times * unit);
    }
    at += times * unit;
  }
  if (pieces.length === 0) return text;
  if (plain !== "") pieces.push(plain);
  return pieces;
}
