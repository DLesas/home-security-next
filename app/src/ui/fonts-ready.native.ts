/**
 * The faces on a phone (m3-design.md section 2, "Fonts"): expo-font loads the four bundled files
 * at start under the family names `global.css` uses (`fonts.ts`), from the same font packages the
 * web build copies them from (`scripts/fonts.ts`). Nothing is fetched from the internet. The root
 * shows only the page's colour until they are loaded; a face that fails to load leaves the
 * system's, and the app still starts.
 *
 * Each file is handed to expo-font by its URI, which React Native's own asset resolution gives
 * (`Image.resolveAssetSource`: Metro's server in a development build, the app's bundle in a
 * release), not by its module number: expo-asset reads a module number through `AssetRegistry`
 * from `react-native`, which NativeWind's `react-native-css` 3.1.0-rc.1 does not pass on from
 * React Native 0.88 (its `components/index.cts` lists every other export), so expo-asset finds
 * it undefined ("Cannot read property 'getAssetByID' of undefined", seen on the iOS simulator).
 */
import { AtkinsonHyperlegibleMono_400Regular } from "@expo-google-fonts/atkinson-hyperlegible-mono/400Regular";
import { AtkinsonHyperlegibleNext_400Regular } from "@expo-google-fonts/atkinson-hyperlegible-next/400Regular";
import { AtkinsonHyperlegibleNext_600SemiBold } from "@expo-google-fonts/atkinson-hyperlegible-next/600SemiBold";
import { AtkinsonHyperlegibleNext_700Bold } from "@expo-google-fonts/atkinson-hyperlegible-next/700Bold";
import { useFonts } from "expo-font";
import { Image } from "react-native";
import { faceSources } from "./fonts";

/** Each face's file, by the family name `fonts.ts` gives it. */
export const FACE_FILES = {
  AtkinsonHyperlegibleNext_400Regular,
  AtkinsonHyperlegibleNext_600SemiBold,
  AtkinsonHyperlegibleNext_700Bold,
  AtkinsonHyperlegibleMono_400Regular,
} as const;

const SOURCES = faceSources(FACE_FILES, (file) => Image.resolveAssetSource(file)?.uri ?? "");

export function useFontsReady(): boolean {
  const [loaded, error] = useFonts(SOURCES);
  return loaded || error !== null;
}
