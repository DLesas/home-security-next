/**
 * The native module, `HubNet` (`ios/HubNetModule.swift`, `android/.../HubNetModule.kt`), bound to
 * the shape `contract.ts` gives it. Null where the build has none (a build made before the module,
 * or Expo Go): the browse then answers `unsupported`.
 *
 * Read from `globalThis.expo.modules`, where Expo's runtime installs every native module at start
 * and where its own `requireOptionalNativeModule` looks first, rather than by importing `expo`:
 * that import brings Expo's ambient types into the app's type checks, which then no longer see
 * Node's `node:crypto` the protocol package's files use (and widen `process.env`, as
 * docs/spikes/P0-phone-build.md found). `dev/wave0.ts` reads Expo's modules the same way. The
 * functions are looked for by name, so a module of another shape is none.
 */
import { HUB_NET_EVENT, type HubNetNative } from "./contract";

/** The module as Expo's runtime gives it: its async functions, and its events' `addListener`. */
interface HubNetModule {
  start(type: string, session: number): Promise<unknown>;
  stop(session: number): Promise<unknown>;
  permission(): Promise<unknown>;
  ask(): Promise<unknown>;
  addListener(event: string, listener: (event: unknown) => void): { remove(): void };
}

const FUNCTIONS = ["start", "stop", "permission", "ask", "addListener"] as const;

function isHubNet(value: unknown): value is HubNetModule {
  if (typeof value !== "object" || value === null) return false;
  const fields = value as Readonly<Record<string, unknown>>;
  return FUNCTIONS.every((name) => typeof fields[name] === "function");
}

/** A call into the module whose throw, if it throws at once, becomes a rejection. */
const later = (call: () => Promise<unknown>): Promise<unknown> => Promise.resolve().then(call);

export function nativeHubNet(): HubNetNative | null {
  const expo = (globalThis as { readonly expo?: { readonly modules?: object } }).expo;
  const module: unknown =
    expo?.modules === undefined ? undefined : Reflect.get(expo.modules, "HubNet");
  if (!isHubNet(module)) return null;
  return {
    start: (type, session) => later(() => module.start(type, session)),
    stop: (session) => later(() => module.stop(session)),
    permission: () => later(() => module.permission()),
    ask: () => later(() => module.ask()),
    listen: (listener) => {
      const subscription = module.addListener(HUB_NET_EVENT, listener);
      return () => {
        subscription.remove();
      };
    },
  };
}
