/**
 * Scanning a QR code with the phone's camera (m3-design.md section 2, rules 7 and 8): link,
 * restore and pairing codes. Types only, frozen by step 0; the phone's is expo-camera's (P5,
 * wave 1). The web build scans nothing: a browser is linked by its address or a typed code.
 */
import type { ComponentType } from "react";

/** The system's answer to a permission, and whether it may still be asked. */
export interface Permission {
  readonly state: "granted" | "denied" | "undetermined";
  /** False once the system will not ask again: the page then offers "Open settings". */
  readonly canAskAgain: boolean;
}

export interface ScannerViewProps {
  /** The text of the first QR code read. The view stops at once; the next page says what was found. */
  readonly onScanned: (text: string) => void;
  /** The phone's light on, where it has one ("Light on", "Light off"). */
  readonly light: boolean;
  readonly testID?: string;
}

export interface Scanner {
  /** Whether this phone has a camera to scan with (the iOS simulator has none). */
  available(): Promise<boolean>;
  /** The camera permission as it stands, without asking. */
  permission(): Promise<Permission>;
  /** Asks the system's question, after the page has said in one sentence what and why (rule 7). */
  ask(): Promise<Permission>;
  /** The camera's view: a square the width of the content column, 12 px corners, nothing over it. */
  readonly View: ComponentType<ScannerViewProps>;
}
