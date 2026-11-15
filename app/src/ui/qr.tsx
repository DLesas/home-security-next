/**
 * A QR code as SVG (m2-design.md section 8, `qr.web.ts`'s "show a code"; wave 2's ruling: `toqr`),
 * dark on light with the four-module quiet zone the standard asks for. One path, no inline style:
 * nothing the content security policy has to allow. Its text is given beside it, selectable, for a
 * person who cannot scan; scanning waits for the phone app.
 */
import { toQR } from "toqr";

/** The dark modules of `text`'s code, as an SVG path in module units, and the code's size. */
export function qrPath(text: string): { readonly size: number; readonly path: string } {
  const modules = toQR(text);
  const size = Math.round(Math.sqrt(modules.length));
  let path = "";
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (modules[row * size + col] === 1) path += `M${String(col)} ${String(row)}h1v1h-1z`;
  return { size, path };
}

const QUIET = 4;

export function QrCode({
  text,
  label,
  testID,
}: {
  readonly text: string;
  readonly label: string;
  readonly testID?: string;
}) {
  const { size, path } = qrPath(text);
  const box = size + 2 * QUIET;
  return (
    <svg
      role="img"
      aria-label={label}
      data-testid={testID}
      viewBox={`${String(-QUIET)} ${String(-QUIET)} ${String(box)} ${String(box)}`}
      width={Math.max(180, box * 4)}
      height={Math.max(180, box * 4)}
      shapeRendering="crispEdges"
    >
      <rect x={-QUIET} y={-QUIET} width={box} height={box} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
