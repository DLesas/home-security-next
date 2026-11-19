/**
 * Renders the app's components to HTML under `bun test`, through React Native Web, as the web
 * build does: `react-native` loads as `react-native-web` (`native-web.ts`) for the imports that
 * follow, and `expo-router` as a stand-in whose `Link` is a plain link (the router itself runs
 * only in the build, where the browser check covers it).
 */
import { mock } from "bun:test";
import { createElement } from "react";
import { nativeWeb } from "./native-web";

await mock.module("react-native", () => nativeWeb);
await mock.module("expo-router", () => ({
  /** Render the router's link as the web build does. */
  Link: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
  /** The stand-in has no route parameters. */
  useLocalSearchParams: () => ({}),
  /** The stand-in serves the root route. */
  usePathname: () => "/",
}));
