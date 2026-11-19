/**
 * The types of `qr.tsx`'s pair, apart from it: in the phone's type check (`tsconfig.native.json`)
 * `./qr` is the phone's file.
 */
import type { JSX } from "react";

export interface QrCodeProps {
  /** The code's text, drawn; shown beside it by the screen, for a person who cannot scan. */
  readonly text: string;
  /** What the code is, for a screen reader. */
  readonly label: string;
  readonly testID?: string;
}

export interface QrDrawing {
  readonly QrCode: (props: QrCodeProps) => JSX.Element;
}
