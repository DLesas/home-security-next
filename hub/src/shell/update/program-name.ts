/** The program's name in `versions/<version>/bin/` for a release's platform (the launcher's `programOf`). */
import type { ReleasePlatform } from "./release.ts";

export function programName(platform: ReleasePlatform): string {
  return platform === "windows-x64" ? "hsn-hub.exe" : "hsn-hub";
}
