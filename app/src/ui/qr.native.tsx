/**
 * A QR code drawn with Views on a phone (m3-design.md section 2; section 12: "drawn with Views
 * from `toqr`'s modules", not react-native-svg), the phone's side of `qr.tsx`: `ink` runs on a
 * `chalk` square with the four-module quiet zone, each module a whole number of the screen's
 * pixels (`moduleSide`) so no seam shows. One image to a screen reader, named by `label`. The
 * sizes are computed, so they go in as numbers; the colours are the theme's classes.
 */
import { PixelRatio, View } from "react-native";
import type { QrCodeProps } from "./qr-types";
import { moduleSide, QUIET, qrMatrix, qrRows } from "./qr-matrix";

export function QrCode({ text, label, testID }: QrCodeProps) {
  const matrix = qrMatrix(text);
  const side = moduleSide(matrix.size, PixelRatio.get());
  return (
    <View
      role="img"
      aria-label={label}
      testID={testID}
      className="self-start bg-chalk"
      style={{ padding: QUIET * side }}
    >
      {qrRows(matrix).map((runs, row) => (
        <View key={row} className="flex-row" style={{ height: side }}>
          {runs.map((run, i) => (
            <View
              key={i}
              className={run.dark ? "bg-ink" : ""}
              style={{ width: run.length * side, height: side }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
