/**
 * The words that name the device the app runs on: "this browser" on the web, "this phone" on a
 * phone (docs/app-design.md, "Wording": things are named as the household knows them). A key with
 * such words has a `_phone` twin in the translation file, which i18next's context chooses.
 */
import { Platform } from "react-native";

/** i18next's options that choose a key's phone words on a phone, and its own in a browser. */
export const HERE: { readonly context?: "phone" } =
  Platform.OS === "web" ? {} : { context: "phone" };
