/**
 * The app's four faces (docs/app-design.md, "Type"; m3-design.md section 2, "Fonts"): one family,
 * Atkinson Hyperlegible Next, in the three weights the design uses, and its Mono for what a person
 * must copy exactly. Each face is its own family name, the name `global.css`'s `--font-*` tokens
 * use, so a class such as `font-heavy` names one file and no weight is chosen by the system: the
 * web build declares the names with `@font-face`; the phone loads the same files under the same
 * names at start (`fonts-ready.native.ts`), and shows nothing until they are loaded.
 */

/** A face: the family name the theme uses, the theme's token, and the weight the file holds. */
export interface Face {
  readonly family: string;
  /** The `--font-*` token in `global.css` that names it. */
  readonly token: "text" | "strong" | "heavy" | "code";
  readonly weight: 400 | 600 | 700;
  /** Whether it is the Mono, for characters to copy exactly. */
  readonly mono: boolean;
}

/** The design's roles: body and secondary text 400, buttons and section headings 600, titles 700. */
export const FACES: readonly Face[] = [
  { family: "AtkinsonHyperlegibleNext_400Regular", token: "text", weight: 400, mono: false },
  { family: "AtkinsonHyperlegibleNext_600SemiBold", token: "strong", weight: 600, mono: false },
  { family: "AtkinsonHyperlegibleNext_700Bold", token: "heavy", weight: 700, mono: false },
  { family: "AtkinsonHyperlegibleMono_400Regular", token: "code", weight: 400, mono: true },
];

/** Whether the faces may be used yet: true at once in a browser, once loaded on a phone. */
export interface FontsReady {
  readonly useFontsReady: () => boolean;
}

/** Each family's file as expo-font takes it by URI: `uriOf` resolves a bundled file's module. */
export function faceSources(
  files: Readonly<Record<string, number>>,
  uriOf: (file: number) => string,
): Record<string, { readonly uri: string }> {
  return Object.fromEntries(
    Object.entries(files).map(([family, file]) => [family, { uri: uriOf(file) }]),
  );
}
