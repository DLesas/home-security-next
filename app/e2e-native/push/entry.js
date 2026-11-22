/* global require -- Metro provides require.context for the router. */
// Dedicated emulator entry with the product router tree and a local stand-in token.
import "../../src/platform/random-start";
import "./local-phone";
import { registerRootComponent } from "expo";
import { ExpoRoot } from "expo-router";
import { createElement } from "react";
const routes = require.context("../../src/app");
/** Mounts the same screens and startup code as the product entry. */
function App() {
  return createElement(ExpoRoot, { context: routes });
}
registerRootComponent(App);
