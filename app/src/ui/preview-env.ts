/**
 * Whether a development build was asked for a preview of the screens (`preview.ts`): Metro's
 * `EXPO_PUBLIC_HSN_PREVIEW`, which Expo's Babel preset writes into a development bundle. A release
 * bundle never loads the preview: the root asks only under `__DEV__`, which it folds to false.
 */

/** Metro's public variable, inlined into the bundle (not the widened `process.env` of Expo's types). */
declare const process: { readonly env: { readonly EXPO_PUBLIC_HSN_PREVIEW?: string } };

/** The preview's settings, `key=value` pairs separated by `;`, or "" for none. */
export function previewSettings(): string {
  return process.env.EXPO_PUBLIC_HSN_PREVIEW ?? "";
}

export function previewAsked(): boolean {
  return previewSettings() !== "";
}

/** `key=value;key=value` as a map. */
export function parseSettings(text: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const part of text.split(";")) {
    const at = part.indexOf("=");
    if (at > 0) map.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return map;
}
