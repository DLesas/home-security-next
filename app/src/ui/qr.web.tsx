/**
 * A QR code as SVG (m2-design.md section 8, `qr.web.ts`'s "show a code"; wave 2's ruling: `toqr`),
 * the web build's side of `qr.tsx`: `ink` on `chalk` with the four-module quiet zone the standard
 * asks for. One path, no inline style: nothing the content security policy has to allow. Its text
 * is given beside it, selectable, for a person who cannot scan.
 */
import type { QrCodeProps } from "./qr-types";
import { QUIET, qrPath } from "./qr-matrix";

export function QrCode({ text, label, testID }: QrCodeProps) {
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
      <rect x={-QUIET} y={-QUIET} width={box} height={box} className="fill-chalk" />
      <path d={path} className="fill-ink" />
    </svg>
  );
}
