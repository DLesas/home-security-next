/**
 * The app's entry (`package.json` `main`): first the platform's `crypto.getRandomValues` is put in
 * place where the engine has none (a phone: m3-design.md section 2); then the platform's start
 * file loads, which in a browser takes a code out of the address and clears the address bar and
 * history (section 5, "at once"); then Expo Router starts.
 */
import "./platform/random-start";
import "./hub/start";
import "expo-router/entry";
