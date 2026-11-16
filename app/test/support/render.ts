/**
 * Renders the app's components to HTML under `bun test`, through React Native Web, as the web
 * build does: `react-native` loads as `react-native-web` for the imports that follow, and
 * `expo-router` as a stand-in whose `Link` is a plain link (the router itself runs only in the
 * build, where the browser check covers it).
 */
import { plugin } from "bun";

const web = Bun.resolveSync("react-native-web", import.meta.dir);
const react = Bun.resolveSync("react", import.meta.dir);
plugin({
  name: "react-native as react-native-web, expo-router as links",
  setup(build) {
    build.onLoad({ filter: /\/node_modules\/react-native\/index\.js$/u }, () => ({
      contents: `export * from ${JSON.stringify(web)};`,
      loader: "js",
    }));
    build.onLoad({ filter: /\/node_modules\/expo-router\/build\/index\.js$/u }, () => ({
      contents: `import { createElement } from ${JSON.stringify(react)};
export function Link({ href, children }) { return createElement("a", { href }, children); }
export function useLocalSearchParams() { return {}; }
export function usePathname() { return "/"; }`,
      loader: "js",
    }));
  },
});
