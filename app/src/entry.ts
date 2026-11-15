/**
 * The app's entry (`package.json` `main`): first a code in the address is taken out of it and the
 * address bar and history cleared (section 5, "at once"), then Expo Router starts.
 */
import "./hub/arrival";
import "expo-router/entry";
