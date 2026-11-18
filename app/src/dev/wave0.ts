/**
 * Wave 0's checks on a phone (m3-design.md section 10, "Wave 0"; docs/spikes/P0-phone-build.md):
 * development builds only. `hub/start.native.ts` loads this file under `__DEV__`, which a release
 * bundle folds to false before it collects modules, so none of it ships (the spike report shows
 * a release bundle without it). Nothing here is P2's work: it proves the engine, the native
 * modules and the socket, and lets the routes be seen before a phone can link.
 *
 * At start it logs one line per check to Metro's console, each prefixed `[wave0]`. Metro's own
 * environment, read when it bundles, asks for more:
 *
 * - `EXPO_PUBLIC_HSN_WAVE0_ROUTES=open | all | /a,/b`: the client's live store says "open", so the
 *   shell shows the routes instead of the link screen (every read is refused: there is no
 *   session); then the routes named are opened in turn, 4 s apart, and logged. Links opened in
 *   the app (`hsn:///devices`) reach the routes too.
 * - `EXPO_PUBLIC_HSN_WAVE0_SOCKET=wss://<address>:<port>/app/link,…`: React Native's own
 *   WebSocket to each, with the `Origin` the hub requires; logs whether TLS let it open, and how it
 *   closed.
 */
import { Linking } from "react-native";
import { BleManager } from "react-native-ble-plx";
import { decodeJson, encodeJson } from "../hub/codec";
import type { HubClient } from "../hub/client";
import { EMPTY_LIVE } from "../state/live";
import { bigOfBits, modPow, routesToWalk, socketRequest } from "./wave0-parts";

/** Metro's public variables, inlined into a development bundle by Expo's Babel preset. */
declare const process: {
  readonly env: {
    readonly EXPO_PUBLIC_HSN_WAVE0_ROUTES?: string;
    readonly EXPO_PUBLIC_HSN_WAVE0_SOCKET?: string;
  };
};

function log(check: string, result: unknown): void {
  console.log(`[wave0] ${check} ${JSON.stringify(result)}`);
}

/** The engine checks of m3-design.md section 2, and `TextEncoder` (the coordinator's ruling). */
export function engineChecks(): void {
  const crypto = (globalThis as { readonly crypto?: { getRandomValues?: unknown } }).crypto;
  const hasRandom = typeof crypto?.getRandomValues === "function";
  log("crypto.getRandomValues", hasRandom);
  if (hasRandom) {
    // The source the entry installed (`platform/random.native.ts`): two draws of 32 bytes, which
    // a working generator makes different and not all zero. The bytes themselves are not logged.
    const one = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const two = globalThis.crypto.getRandomValues(new Uint8Array(32));
    log("crypto.getRandomValues draws", {
      differ: one.some((b, i) => b !== two[i]),
      nonZero: one.some((b) => b !== 0) && two.some((b) => b !== 0),
    });
  }
  log("TextEncoder", typeof TextEncoder === "function" ? [...encodeJson("é")] : "missing");
  log("TextDecoder", {
    present: typeof TextDecoder === "function",
    // A lone 0xFF is not UTF-8: a fatal decoder refuses it, so the JSON does not parse.
    fatalRefuses: decodeJson(new Uint8Array([0x22, 0xff, 0x22])) === undefined,
    reads: decodeJson(encodeJson("é"))?.value === "é",
  });
  const at = Date.UTC(2026, 6, 1, 12, 0, 0);
  log(
    "Intl.DateTimeFormat timeZone",
    typeof Intl === "object"
      ? ["Europe/London", "America/New_York", "Asia/Kolkata"].map((timeZone) =>
          new Intl.DateTimeFormat("en-GB", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
          }).format(at),
        )
      : "missing",
  );
  // SRP's arithmetic (m3-design.md section 5): timed on numbers of SRP's sizes. They need not be
  // secret, so `Math.random` fills them where the engine has no `getRandomValues`.
  const fill = (bytes: Uint8Array<ArrayBuffer>) => {
    if (hasRandom) globalThis.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  };
  const modulus = bigOfBits(3072, fill);
  const base = bigOfBits(3072, fill);
  const started = Date.now();
  modPow(base, bigOfBits(512, fill), modulus);
  const short = Date.now() - started;
  modPow(base, bigOfBits(3072, fill), modulus);
  log("BigInt 3072-bit modPow ms", {
    exponent512: short,
    exponent3072: Date.now() - started - short,
  });
  log("Hermes", typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === "object");
}

/** Loads the native modules wave 0 installs; a simulator has no radio, so loading is what shows. */
async function nativeModules(): Promise<void> {
  const manager = new BleManager();
  log("react-native-ble-plx state", await manager.state());
  await manager.destroy();
  // Expo's native modules, as Expo's runtime registers them. Read without importing the
  // packages, whose types widen `process.env` for every program they enter (Expo's global
  // declaration), the tests' included.
  const modules = (globalThis as { readonly expo?: { readonly modules?: object } }).expo?.modules;
  log("expo native modules", {
    ExpoSecureStore: modules !== undefined && "ExpoSecureStore" in modules,
    ExpoCamera: modules !== undefined && "ExpoCamera" in modules,
  });
}

/**
 * React Native's own WebSocket to a hub, as the phone at home would open it (D132). An entry
 * `url@host:port` sends that `Host` (and its `Origin`) instead of the URL's: the emulator reaches
 * the hub through `adb reverse` on loopback, but presents itself as the hub's own address.
 */
function socketCheck(entry: string): void {
  const { url, headers } = socketRequest(entry);
  const started = Date.now();
  // React Native's WebSocket takes headers as its third argument ‡.
  const Socket = WebSocket as unknown as new (
    url: string,
    protocols: undefined,
    options: { readonly headers: Readonly<Record<string, string>> },
  ) => WebSocket;
  const socket = new Socket(url, undefined, { headers });
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    log("socket open", { url, headers, ms: Date.now() - started });
  };
  socket.onerror = (event) => {
    log("socket error", { url, message: (event as { message?: unknown }).message ?? null });
  };
  socket.onclose = (event) => {
    log("socket closed", { url, code: event.code, reason: event.reason, ms: Date.now() - started });
  };
}

/**
 * Shows the routes in place of the link screen, then opens each of `walk` in turn. A route that
 * fails to render takes the whole tree with it (there is no error boundary), so a walk ends at
 * its first failure; the next launch walks from there.
 */
function showRoutes(client: HubClient, walk: readonly string[]): void {
  client.live.setState({ ...EMPTY_LIVE, connection: { kind: "open" } }, true);
  log("routes", "open");
  walk.forEach((route, n) => {
    setTimeout(
      () => {
        // The app's own link, which the router takes as any link opened in the app. (Not
        // `expo-router`'s `router`: its types bring Expo's, which widen `process.env` in every
        // program this file enters.)
        void Linking.openURL(`hsn://${route}`);
        log("route", route);
      },
      4000 * (n + 1),
    );
  });
  setTimeout(
    () => {
      log("routes", "done");
    },
    4000 * (walk.length + 1),
  );
}

export function startWave0(client: HubClient): void {
  engineChecks();
  nativeModules().catch((error: unknown) => {
    log("native modules failed", String(error));
  });
  const socket = process.env.EXPO_PUBLIC_HSN_WAVE0_SOCKET;
  for (const url of (socket ?? "").split(",")) if (url !== "") socketCheck(url);
  // After the shell's first render, so the store's "open" is not overwritten by the channel's start.
  const routes = process.env.EXPO_PUBLIC_HSN_WAVE0_ROUTES;
  if (routes !== undefined && routes !== "")
    setTimeout(() => {
      showRoutes(client, routesToWalk(routes));
    }, 2000);
}
