/**
 * A file the app made, handed over on a phone, the phone's side of `save-file.ts`. Not built yet:
 * P5 builds it in wave 1 (written to the app's cache with expo-file-system, handed to the share
 * sheet with expo-sharing). Until then it refuses, `notBuilt`, and writes nothing.
 */
import type { SaveFiles } from "./save-file-types";
import { NOT_BUILT } from "./split";

export const saveFile: SaveFiles["saveFile"] = () => Promise.resolve(NOT_BUILT);
