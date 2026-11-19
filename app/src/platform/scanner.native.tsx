/** Expo's in-app QR scanner, using the same view for link, restore and pairing codes. */
import { Camera, CameraView } from "expo-camera";
import { useRef } from "react";
import { Platform } from "react-native";
import { styled } from "react-native-css";
import type { Permission, Scanner, ScannerViewProps } from "./scanner-types";

export type * from "./scanner-types";

const CameraPreview = styled(CameraView);
const denied: Permission = { state: "denied", canAskAgain: false };

/** Keeps only the state the permission page needs from Expo's native answer. */
function permission(
  answer: Awaited<ReturnType<typeof Camera.getCameraPermissionsAsync>>,
): Permission {
  return { state: answer.status, canAskAgain: answer.canAskAgain };
}

/** Shows an edge-to-edge preview inside the scanner page's clipped square. */
function Preview({ onScanned, light, testID }: ScannerViewProps) {
  const last = useRef<string | null>(null);
  return (
    <CameraPreview
      className="flex-1"
      {...(testID === undefined ? {} : { testID })}
      enableTorch={light}
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={({ data }) => {
        if (last.current === data) return;
        last.current = data;
        onScanned(data);
      }}
    />
  );
}

export const cameraScanner: Scanner = {
  // Expo's iOS codec probe opens a capture device and returns no codecs if it has no camera.
  available: () =>
    Platform.OS !== "ios"
      ? Promise.resolve(true)
      : CameraView.getAvailableVideoCodecsAsync().then(
          (codecs) => codecs.length > 0,
          () => false,
        ),
  permission: () => Camera.getCameraPermissionsAsync().then(permission, () => denied),
  ask: () => Camera.requestCameraPermissionsAsync().then(permission, () => denied),
  View: Preview,
};

/** Reads a QR from a local still image using the same native decoder on the simulator. */
export function scanStillImage(uri: string): Promise<string | undefined> {
  return Camera.scanFromURLAsync(uri, ["qr"]).then(
    (results) => results[0]?.data,
    () => undefined,
  );
}
