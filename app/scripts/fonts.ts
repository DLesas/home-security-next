/**
 * The web build's font files (docs/app-design.md, "Type"): the four faces the app uses, copied
 * from the font packages into `<build>/fonts/`, where `global.css`'s @font-face rules name them
 * and the hub serves them (font-src 'self'). Nothing is fetched from the internet. The phone (M3)
 * loads the same files through expo-font. Run as `bun scripts/fonts.ts dist`.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const FACES = [
  "@expo-google-fonts/atkinson-hyperlegible-next/400Regular/AtkinsonHyperlegibleNext_400Regular.ttf",
  "@expo-google-fonts/atkinson-hyperlegible-next/600SemiBold/AtkinsonHyperlegibleNext_600SemiBold.ttf",
  "@expo-google-fonts/atkinson-hyperlegible-next/700Bold/AtkinsonHyperlegibleNext_700Bold.ttf",
  "@expo-google-fonts/atkinson-hyperlegible-mono/400Regular/AtkinsonHyperlegibleMono_400Regular.ttf",
] as const;

if (import.meta.main) {
  const build = process.argv[2] ?? "dist";
  const out = join(build, "fonts");
  mkdirSync(out, { recursive: true });
  for (const face of FACES) {
    const from = Bun.resolveSync(face, join(import.meta.dir, ".."));
    copyFileSync(from, join(out, face.slice(face.lastIndexOf("/") + 1)));
  }
  console.log(`fonts: ${String(FACES.length)} faces in ${out}`);
}
