# P0: the phone build stands up (wave 0)

Run 2026-11-18 on this Mac (macOS 27.2.1, Apple silicon), by step 0c, part 2, and finished the same day by a second engineer ("P0b": the layout fault, Android, `expo-crypto`). The questions are [m3-design.md](../m3-design.md) section 10's "Wave 0": do development builds of the one `app/` codebase build and start on an iOS simulator and the Android emulator; does the engine have what the app needs (section 2's checks, with `TextDecoder` and `TextEncoder`); does NativeWind 5 render the app's screens there; does `react-native-ble-plx` build and load; can React Native's own WebSocket be made to accept the hub's self-signed certificate for a home-network address without a native module of ours (the reviewer's one-day check, which sizes `hub-net`); and how far does a first connection to a real hub go.

Versions: Expo 58.0.25, React Native 0.88.1 (Hermes, New Architecture), NativeWind 5.0.0-rc.1 with react-native-css 3.1.0-rc.1 and Tailwind 4.1.12, expo-crypto 58.0.8, Xcode 27.2, iOS 27.0 simulator (iPhone 18 Pro), Android emulator "Medium_Phone_API_37.0" (Android 17, API 37, arm64, 1080 × 2400 at 420 dpi), JDK Zulu 17.0.21, Node 22.14.0, Bun 1.4.2. The hub was `hub/test/world/hub-entry.ts` on this Mac, apps' port 8444, its certificate naming `192.168.5.248` (the Mac's home-network address) and the Mac's names.

## Answers

| Question | iOS simulator | Android emulator |
| --- | --- | --- |
| 1. A development build builds and starts | **Yes** | **Yes**, once React Native's own `ACCESS_LOCAL_NETWORK` prompt is answered (granted with `pm grant` on the emulator, section 6) |
| 2. The engine's checks | **All present**; `crypto.getRandomValues` from expo-crypto, installed at the entry (table below) | **All present**, the same |
| 3. NativeWind 5 renders the screens | **Yes**, once the theme's line heights are written as ratios (section 3): every token class measures as the design's numbers. Two routes fail to render, as expected (`<input>`) | **Yes**, the same, measured the same way; the same two routes fail |
| 4. `react-native-ble-plx` builds and loads | **Yes**: `state()` answers `Unknown` (no radio) | **Yes**: `state()` answers `PoweredOn` (the emulator's virtual radio) |
| 5. React Native's WebSocket accepts the hub's certificate for a home-network address, without a module of ours | **Yes**, with a 70-line Objective-C file through `RCTSetCustomSRWebSocketProvider` | **Yes**, with the Kotlin file through `WebSocketModule.setCustomClientBuilder`; a name that is not a home address is still refused |
| 6. A first connection to the real hub | **TLS and the WebSocket upgrade to `/app/link`**, the hub's own `Host` and `Origin` accepted; the hub ended it at its 5 s handshake limit, since no Noise message 1 was sent | **The same**: opened in 537 ms over the home network; the hub closed it at 5 s with its refusal (1008, `refused`) |

So **`hub-net` shrinks to the mDNS browse on both platforms**: `browse(service, ms)` on Network's browser (iOS) and NsdManager (Android). Its socket half (`open`, `send`, `close`, the `message` and `closed` events) is not needed: React Native's own WebSocket, with `plugins/hub-tls.cjs`, reaches the hub on both. One thing goes with the socket half that the phone still needs from someone: on Android a release build must ask for `ACCESS_LOCAL_NETWORK` itself (React Native asks only in debuggable builds, section 6), at the moment the app first reaches the hub (rule 7 of section 2's layout rules: P2's and P5's).

## How it was run

- `bun install` added the four approved dependencies (below), and P0b `bun add --exact expo-crypto@58.0.8`; `expo prebuild` wrote `app/ios/` and `app/android/` (ignored by git); `expo run:ios` and `expo run:android` built them; Metro served the JavaScript. Every Expo command ran with `CI=1`, `EXPO_NO_TELEMETRY=1` and `EXPO_OFFLINE=1` (but the first Metro start of part 1, see "Downloads").
- **Wave 0's checks** live in [`app/src/dev/wave0.ts`](../../app/src/dev/wave0.ts), loaded by [`app/src/hub/start.native.ts`](../../app/src/hub/start.native.ts) under `if (__DEV__)` only. They log one line each to Metro's console (`[wave0] …`). Metro's environment asks for more: `EXPO_PUBLIC_HSN_WAVE0_ROUTES` makes the client's live store say "open", so the shell shows the routes in place of the link screen (the phone cannot link yet; every read is then refused, as on a hub that went away), and walks them; `EXPO_PUBLIC_HSN_WAVE0_SOCKET` lists hub URLs to open with React Native's own WebSocket.
- **A release build cannot carry it.** A release bundle folds `__DEV__` to `false` before Metro collects modules, so `dev/wave0.ts` is never collected. Checked again after P0b's changes: `expo export --platform ios --platform android` (release, Hermes bytecode) contains none of wave 0's strings (`wave0`, `3072-bit modPow`) and none of `react-native-ble-plx`'s JavaScript (`BleManager`), while expo-crypto's module (`ExpoCrypto`) is in both bundles.
- Screens on iOS were seen through T3 Code's device panel (`agent-device`), one screenshot per route as the walk reached it. The panel cannot drive Android on this Mac: it needs the Android SDK's command-line tools, which are not installed (an install, not approved). So nothing on Android was tapped or photographed. What is said of Android comes from the build output, Metro's log, `adb logcat`, the layout probe's measurements (section 3), and, per route, the screen's text and boxes as Android's accessibility tree has them (`adb shell uiautomator dump`, read only).
- Android ran with Metro carried to the emulator by `adb reverse tcp:8081 tcp:8081` (the debug build looks for Metro at `localhost:8081`, `metroOnLoopback` in `app.config.ts`), and, for one socket check, `adb reverse tcp:8444 tcp:8444`.

## 2. The engine (Hermes, development builds)

| Needed | iOS | Android | Consequence |
| --- | --- | --- | --- |
| `crypto.getRandomValues` | **Missing from the engine**; present once the entry installs expo-crypto's: two 32-byte draws differ and are not all zero | The same | Built (below). The keys themselves stay P2's |
| `TextEncoder` | Present: `"é"` encodes as `22 C3 A9 22` (JSON `"é"`) | The same | — |
| `TextDecoder` with `fatal: true` | Present, and fatal works: a lone `0xFF` is refused; `"é"` reads back | The same | `codec.ts` runs unchanged |
| `Intl.DateTimeFormat` with `timeZone` | Works: 12:00 UTC on 1 July 2026 is `13:00` in Europe/London, `08:00` in America/New_York, `17:30` in Asia/Kolkata | The same three | Not a blocker |
| `BigInt`, timed | One 3072-bit modular exponentiation: **156 to 174 ms** with a 512-bit exponent, **947 to 1027 ms** with a 3072-bit one (five runs over both parts) | **214 ms** and **1487 ms** (one run, the emulator) | SRP's client needs two or three exponentiations with short exponents: well under the 2 s † on both. Real phones in S9 |
| Hermes | Yes | Yes | — |

**The random source.** [`app/src/platform/random.ts`](../../app/src/platform/random.ts) is a pair like the others (`split.ts`): `random.web.ts` keeps the browser's own; `random.native.ts` puts expo-crypto's `getRandomValues` (the system's generator: `SecRandomCopyBytes` on iOS, `SecureRandom` on Android, read in expo-crypto 58.0.8's sources) on `globalThis.crypto`, unless the engine has its own, which is never replaced. [`random-start.ts`](../../app/src/platform/random-start.ts) installs it, and is the entry's first import, so `@noble/curves`, the protocol's Noise and `hub/files.ts` find it. Tested in `app/test/random.test.ts`. Note that expo-crypto's has no 65,536-byte limit, unlike Web Crypto's; `@noble/hashes` enforces the limit itself.

## 3. The routes, and what NativeWind does

### The layout fault, and its cause

Before the fix, on iOS, every line of text was the font size times too tall: body text, 17 px on a 26 px line, took 442 points per line. The cause, read in the libraries and reproduced:

1. **Tailwind 4 writes a text size's line height through two variables.** `text-body` becomes `font-size: var(--text-body); line-height: var(--tw-leading, var(--text-body--line-height))` (the exported CSS). `--tw-leading` is set only by a `leading-*` class, so the theme's `--text-body--line-height` is used.
2. **react-native-css's compiler turns any line height that contains `var()` into a call to its runtime `lineHeight` function**, and drops the unit of the value it inlines. `line-height` is in the set `unparsedRuntimeParsing` (`react-native-css/src/compiler/declarations.ts`, lines 89 to 103; used at lines 986 to 992), so the declaration compiles to `[{}, "lineHeight", [{}, "var", ["tw-leading", 26]], 1]`: the theme's `26px` is inlined as the bare number `26`. (A line height written without a variable, `line-height: 26px`, takes the other path, `parseLineHeight`, and compiles to the plain `26`, which is right.)
3. **The runtime's `lineHeight` takes every number as a CSS unitless multiplier** (`react-native-css/src/native/styles/line-height.ts`): it multiplies it by the element's em, the variable `--__rn-css-em` that the same rule's `font-size` sets (17). So 26 × 17 = 442. It cannot tell `26px` from `26`, since the compiler has already dropped the unit.

So in react-native-css 3.1.0-rc.1, a line height given in px (or any length) through a CSS variable is multiplied by the font size on a phone; only a unitless ratio comes out right. That is how Tailwind's own default theme writes line heights (`--text-base--line-height: calc(1.5 / 1)`), which is why NativeWind's defaults work and this theme's px values did not. The earlier reading of the measurements (26 × 17 + 2 × 12 = 466 for the bottom bar's labels) was right.

The library functions themselves, run on the compiled rules (`tools/resolve-lh.ts` in the scratch folder: react-native-css's own `lineHeight` and `calc` from its `src/native/styles/`, on the descriptors its own compiler made of the exported CSS) give, before: state 2112, title 1280, section 660, body 442, small 330, state-wide 4352; after: 48, 40, 30, 26, 22, 68.

### The fix: the tokens in the form the phone reads (option (a))

In `app/global.css` each line height is now the design's px over the size, unitless: `--text-body--line-height: calc(26 / 17);` and likewise `calc(48 / 44)`, `calc(68 / 64)`, `calc(40 / 32)`, `calc(30 / 22)`, `calc(22 / 15)`. Nothing else changed, and no library was patched or pinned.

- **On a phone**, the compiler keeps the `calc` (`[{}, "calc", [26, "/", 17]]`); the runtime's `calc` rounds the ratio to 4 places (1.5294) and `lineHeight` multiplies by the size and rounds to 2 places: 26.00. Every size of the design comes out exact this way (`app/test/type-tokens.test.ts` checks the arithmetic, and that every line height is unitless and the design's numbers).
- **In a browser**, `calc(26 / 17)` × 17 px computes exactly 26 px (Chrome keeps `calc` in double precision; a decimal such as `1.52941` does not: it gives 25.99997 px, and a 20-line paragraph 519.69 px tall instead of 520, measured). Lightning CSS keeps it as `calc(26/17)` in the export. A unitless line height is inherited as the ratio, not the px; in this app every element that changes size sets its own line height with it, and the comparison below shows no element moved.

### How the fix was proved

- **The smallest screen**: a temporary route (`src/app/wave0-layout.tsx`, removed before hand-in; a copy is in the scratch folder as `wave0-layout.tsx.probe`) drew each token class beside a reference written as React Native's own style with the design's numbers (`{ fontSize: 17, lineHeight: 26 }`, `{ fontSize: 44, lineHeight: 48, letterSpacing: -0.88 }`, `minHeight: 48` with `paddingHorizontal: 24, paddingVertical: 12`, the safe-area insets from `useSafeAreaInsets`), and logged both boxes (`onLayout`). Boxes in points (iOS) and dp (Android):

| Class | iOS before | iOS after | Reference (iOS) | Android after | Reference (Android) |
| --- | --- | --- | --- | --- | --- |
| `text-state` ("Armed") | 121.3 × 2112.3 | 121.3 × 48.3 | 121.3 × 48.3 | 127.6 × 48 | 127.6 × 48 |
| `text-title` | 92.3 × 1280.7 | 92.3 × 40.3 | 92.3 × 40.3 | 94.9 × 40 | 94.9 × 40 |
| `text-section` | 64 × 660.3 | 64 × 30.3 | 64 × 30.3 | 65.9 × 30.1 | 65.9 × 30.1 |
| `text-body` | 51 × 442.3 | 51 × 26.3 | 51 × 26.3 | 50.3 × 26.3 | 50.3 × 26.3 |
| `text-small` | 45.7 × 330.3 | 45.7 × 22.3 | 45.7 × 22.3 | 45.3 × 22.1 | 45.3 × 22.1 |
| `max-w-line text-body`, a 3-line paragraph | 354 × 1326.7 | 354 × 78.3 | 354 × 78.3 | 363.4 × 78.9 | 363.4 × 78.9 |
| `min-h-target px-6 py-3` | 49 × 48 | 49 × 48 | 49 × 48 | 49.1 × 48 | 48.8 × 48 |
| `min-h-row w-12` | 48 × 56 | 48 × 56 | 48 × 56 | 48 × 56 | 48 × 56 |
| `pt-safe pb-safe` | 354 × 96 | 354 × 96 | 354 × 96 (insets 62 + 34) | 363.4 × 48 | 363.4 × 48 (insets 24 + 24) |

  The same width for class and reference shows the state sentence's letter spacing, `-0.02em`, applied as −0.88 points (−0.02 × 44; react-native-css's `em` resolves against the element's own size). The `md:` breakpoint (768 px) held on both: `flex md:hidden` laid out, `hidden md:flex` did not (0 × 0). `gap-4` gave 16 between two 1-point children (height 18). The 0.4 dp difference in one Android width is the screen's pixel rounding at 2.625 pixels per dp.
- **Every route afterwards**, below, on iOS by screenshot and on Android by the accessibility tree's text boxes: on Android's Home, "Disarmed" is 48.0 dp tall, body lines 26.3, "Doors" (a section heading) 30.1, a title 40.0; the bottom bar's four labels 50.3 dp (26 + 2 × 12).
- **The web is unchanged.** The exported CSS differs from the export before the fix in exactly six declarations, the six line-height tokens (`--text-body--line-height:26px` became `calc(26/17)`, and so on); every other file of the export is byte-identical but for the CSS file's hashed name in `index.html`. In the installed Chrome, every route at 390 × 844 and at 1280 × 800 (32 screenshots, the e2e harness's real hub, linked through the console) was captured with the export before the fix twice and with the fix once: 22 screenshots are byte-identical between before and after; the other 10 also differ between the two runs before the fix, by their changing text only (the time in history and notifications, the hub's identity on the status page), and in them every text element's box, font size, line height and letter spacing are identical before and after (`web-before-*/`, `web-after-1/`, `*.txt`). `HSN_E2E_CHANNEL=chrome bun run app:e2e` passes (39 of 39). The final export (with the random source) has the same CSS file byte for byte; its JavaScript differs only by `random-start`'s call in the entry and the module numbers after it.

### The other token classes, checked for the same kind of fault

The whole exported CSS was compiled with react-native-css's compiler (`native-rules-before.txt`, `native-rules-after.txt` in the scratch folder) and every rule read:

- **Spacing, the 48 px targets, rows, the rail and the column** are inlined as plain numbers (`min-h-target` → `minHeight: 48`, `px-6` → `paddingInline: 24`, `max-w-column` → `maxWidth: 640`): right, and measured above.
- **Letter spacing in em** goes through the runtime's `em`, which multiplies by the element's own font size: right for a length in em, measured above. (The same multiplication is wrong only for `lineHeight`, which takes a bare number as a multiplier.)
- **The 768 px breakpoint** compiles to `[">=", "width", 768]` against the window's width in points: right, shown above.
- **Safe areas** (`pt-safe`, `pb-safe`, from `tailwindcss-safe-area`): right, the insets measured above. No screen uses them yet (P5's rule 1); until then the content of every route starts under the status bar (visible in the iOS screenshots), which is expected.
- **`max-w-line` (`65ch`) is dropped on a phone**: React Native has no `ch` (Metro's warning; the rule is missing from the compiled sheet). A phone's column is narrower than 65 characters anyway (354 points on the iPhone 18 Pro), and `max-w-column` (640) still holds on a wide screen, so nothing shows; on a screen 768 px or wider a paragraph could run to 640 instead of about 550. Not changed: a px value would change the web, where `ch` follows the font.
- Dropped as having no React Native equivalent, and harmless: preflight's element rules, `.block`, `.inline`, `.fixed`, the `web:` focus rings (`@supports selector(div > div)`, web only by design).

### The routes

| Route | iOS (screenshot) | Android (accessibility tree) |
| --- | --- | --- |
| `/` | Renders: the state field (`sage`) with "Disarmed", its detail lines, the setup notice, Doors; the bottom bar at the bottom, one line high | Renders: "Disarmed", "No doors yet.", the modes line, the setup notice, "Doors" |
| `/devices`, `/device/1`, `/groups`, `/modes`, `/history`, `/notifications`, `/settings`, `/people`, `/schedules`, `/site`, `/status`, `/setup` | Each renders with no error, laid out as on the web: titles, paragraphs wrapping in the column, buttons 48 points high, notices, the destination's row of links | Each renders with no error; each title and its first lines found in the tree at the expected size |
| `/link` | Renders. One overflow: the tick box's label ("Keep the code for 24 hours, …") wraps but runs to the screen's right edge, past the 24-point gutter (a `Text` in a row does not shrink in React Native unless told to; `ui/parts.tsx`, P5's) | Renders; the same label wraps to two lines |
| `/backup` | **Render error**, as expected: `View config getter callback for component 'input'` (`ui/file-input.tsx`, the restore's file input). The tree goes with it | The same error |
| `/updates` | **Render error**, the same (`file-input.tsx`) | The same error |

Each failing route was walked alone, so that every route was reached. The fonts are the system's, as expected until expo-font loads the bundled faces (P5). Nothing was restyled.

## 4. `react-native-ble-plx`

**Version 3.5.1**, the newest on the npm registry (published 2026-02-18; read with `npm view`). Its **stated** React Native support: the README's compatibility table lists only React Native 0.74.1, 0.69.6 and Expo 51 (for 3.1.2), and says "Tested against Expo SDK 49"; its `peerDependencies` are `react-native: "*"`. **No version states support for 0.88**; only the peer range covers it, which is why 3.5.1 was taken. It compiled for both platforms (its Android `RefreshGattCustomOperation.java` warns of unchecked operations, nothing more), its config plugin ran (`isBackgroundEnabled: false`, `neverForLocation: true`, the Bluetooth sentence from the translation file), and `new BleManager().state()` answered `Unknown` on iOS and `PoweredOn` on the Android emulator, then `destroy()` returned. That is all a simulator and an emulator can show.

## 5. The hub's certificate: React Native's own WebSocket

The hub's certificate is self-signed. Without help, React Native's socket refuses it: on iOS `OSStatus error -9807` (an invalid chain) and close code 1006, the first run's result.

[`app/plugins/hub-tls.cjs`](../../app/plugins/hub-tls.cjs), a config plugin, copies two files of native code into the generated projects and installs them through React Native's two global hooks (read in React Native 0.88.1):

- **iOS** ([`HSNHubTls.m`](../../app/plugins/hub-tls/HSNHubTls.m)): `RCTSetCustomSRWebSocketProvider`, set as the app loads. For a `wss://` URL whose host is a private, link-local or loopback address literal or a `.local` name, it makes the socket with an `SRSecurityPolicy` subclass that turns SocketRocket's chain check off; for every other URL it returns nothing, and React Native makes its own socket with the system's checks. SocketRocket's policy API was read in `ios/Pods/ReactNativeDependencies/Headers/SocketRocket/SRSecurityPolicy.h` (React Native's prebuilt dependencies).
- **Android** ([`HubTls.kt`](../../app/plugins/hub-tls/HubTls.kt)): `WebSocketModule.setCustomClientBuilder`, set in `MainApplication.onCreate`. An `X509ExtendedTrustManager` that skips the system's check only when the connected peer's address is loopback, site-local, link-local or IPv6 unique-local, and a hostname verifier that accepts only such address literals or `.local` names; everything else goes to the system's.

Results, the hub at 192.168.5.248:

| URL | What the policy decides | iOS | Android |
| --- | --- | --- | --- |
| `wss://192.168.5.248:8444/app/link` | A home address: certificate accepted | **Opened** (TLS, then the upgrade with `Origin: https://192.168.5.248:8444`; the hub checks `Host` and `Origin`); ended by the hub at its 5 s handshake limit (reported as 1001, "Stream end encountered", by SocketRocket) | **Opened** in 537 ms, directly over the home network; closed by the hub at 5.5 s with **1008, `refused`** (its handshake timeout, `hub/src/shell/app/channel.ts`) |
| `wss://127.0.0.1:8444/app/link` | Loopback: certificate accepted | TLS passed; the hub answered **421** (the `Host` is not one of its certificate's names), so the hub's own rule held | The same, through `adb reverse`: TLS passed, **421 Misdirected Request** |
| `wss://127.0.0.1:8444/app/link` sent with `Host: 192.168.5.248:8444` | Loopback, the hub's own `Host` | — | **Opened**, closed by the hub at 5 s (1008) |
| `wss://localhost:8444/app/link` | A name, not `.local`: the system's checks | **Refused**, `-9807`, as without the plugin | **Refused**: "Hostname localhost not verified" (the system's verifier, reached because the name is not a home host) |

**The certificate question on Android: yes.** React Native's own WebSocket accepts the hub's self-signed certificate for a home-network address, through the Kotlin already compiled in, and keeps the system's checks for a name that is not one. Not shown on Android: the chain check refusing a self-signed certificate at a public address (no such peer can be made on this Mac; the trust manager's code sends every non-home peer to the system's check).

The plugin is applied to every build (the phone needs it at home in a release too), not only development builds.

## 6. Android: the permission prompt, and how it was passed

React Native 0.88.1's development support, on Android 17, **asks for `ACCESS_LOCAL_NETWORK` before it reaches Metro**, in every debuggable build, and waits for the answer (`ReactAndroid/.../devsupport/LocalNetworkPermissionUtil.kt`: "Requested only in debuggable builds, and always (like iOS), since the dev-server host can change"); it asks only while the permission is not granted (`checkSelfPermission`). The first run stopped there.

P0b granted that one permission to the app's own development build on this emulator, as approved: `adb shell pm grant invalid.hsn.app android.permission.ACCESS_LOCAL_NETWORK` (`dumpsys` before: `granted=false`; after: `granted=true`). No other setting was changed. The app was then built and started with `expo run:android` without uninstalling it first (a reinstall keeps the grant and ends the old process, so each start is cold), and its JavaScript ran at once, with no prompt.

Also seen in part 1, as the app's own user (`run-as invalid.hsn.app nc -z`): `10.0.2.2:8081` (the emulator's alias for the Mac) is not reachable without the permission. A development-only setting in `app.config.ts` (`metroOnLoopback`) points the debug build's Metro address at `localhost:8081`, which `adb reverse` carries; with the permission granted the app also reached the hub at `192.168.5.248` directly.

## Not shown, plainly

- A Noise handshake from a phone: the phone cannot make a key yet (`keys.native.ts` refuses until P2), so no message 1 was sent; the connection stopped after the upgrade, on both platforms.
- Android's screens as pictures: the device panel cannot drive Android here, and a screenshot through `adb` is not how this Mac's devices are to be driven. Android's routes are shown by Metro's log, the accessibility tree's text and boxes, and the layout probe's measurements.
- Whether the iOS plugin's chain check is off **only** for the policy's sockets in every case: shown for the URLs above, not for redirects or IPv6. On Android, the chain check refusing a non-home peer (above).
- iOS's local network question: the simulator does not ask it (m3-design section 2). Android's release builds: React Native does not ask for `ACCESS_LOCAL_NETWORK` in them; the app must (section "Answers").
- The QR code on a phone (`/link` reaches it only with a session).
- The bundled fonts on a phone (P5), and the safe areas on the screens (P5): the safe-area classes work, but no screen uses them yet.
- The release check against a real release prebuild: `scripts/release-check.ts` was tested on strings only. Note that Expo's template already sets `android:usesCleartextTraffic="true"` in `android/app/src/debug/` and `debugOptimized/` manifests; the check reads the main manifest, which our development-only plugin also writes unless the prebuild runs with `HSN_RELEASE` set, so a release must be prebuilt with it.
- The defect in react-native-css is avoided, not fixed: any later line height given through a variable in px (a `leading-*` theme token in px, say) would come out multiplied again. `app/test/type-tokens.test.ts` guards the text tokens; nothing guards a token not yet written.

## Found on the way

- **`process.env` becomes `any`** in any TypeScript program that takes `expo-router`'s types (through `expo`, `expo-modules-core` declares `NodeJS.ProcessEnv` with an `any` index). `app/src/dev/wave0.ts` navigates by the app's own link (`Linking.openURL("hsn:///…")`) instead of `expo-router`'s `router`, and reads Expo's native modules from `globalThis.expo.modules` instead of importing `expo-secure-store` and `expo-camera`, so the tests' program is not widened. expo-crypto's types bring the same widening: `app/test/random.test.ts` loads `random.native.ts` by a computed path, with expo-crypto stood in for, for the same reason. Wave 1's code that imports Expo packages into what the tests load will widen it (the lint then refuses `process.env` reads in `app/test/browser/`).
- **Tailwind scans every file under `app/`, tests and comments included**, for class names: a test comment saying "type table" added a `.table` rule to the exported CSS until reworded. Worth knowing when comparing exports.
- **iOS asks "Open in “HSN”?"** for each link opened from outside the app (`simctl`/the device panel), as Safari's links do; a link the app opens itself is not asked.
- Expo's prebuild adds by default `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `SYSTEM_ALERT_WINDOW` and `VIBRATE` to Android's manifest; `ble-plx`'s plugin adds the old `BLUETOOTH` and `BLUETOOTH_ADMIN`. Not removed here (`android.blockedPermissions` can, when someone decides).
- `expo run:ios` built and installed but failed its last step, bringing the Simulator to the front through `osascript` ("System Events": not allowed on this Mac); the app was then started from the device panel. No setting was changed.
- The test hub's control socket did not open from the scratch folder (its path is longer than 103 bytes); the hub ran without it, which the checks here did not need.

## Installed and downloaded, and from where

| What | From | By |
| --- | --- | --- |
| `@hsn/deployment` (`workspace:*`, a link), `expo-secure-store` 58.0.3, `expo-camera` 58.0.14 (the versions `node_modules/expo/bundledNativeModules.json` pins, `~58.0.3` and `~58.0.14`), `react-native-ble-plx` 3.5.1; with them `barcode-detector` 3.2.4, `zxing-wasm` 3.1.7, `@types/emscripten` 1.41.6, `type-fest` 5.10.0, `tagged-tag` 1.0.0 (expo-camera's) | The npm registry | `bun install` (`app/package.json`, `bun.lock`) |
| `expo-crypto` 58.0.8 (P0b; `bundledNativeModules.json` pins `~58.0.8`, and 58.0.8 is the newest 58.0 release); nothing else came with it | The npm registry | `bun add --exact` (`app/package.json`, `bun.lock`) |
| `react-native-ble-plx`'s metadata and README; expo-crypto's version list (P0b) | The npm registry | `npm view` |
| Expo's project template for SDK 58 | The npm registry ‡ (Expo's prebuild, not logged) | `expo prebuild` |
| React Native 0.88.1's prebuilt iOS core and dependencies, debug and release (`react-native-artifacts-0.88.1-reactnative-core-*.tar.gz`, `…-reactnative-dependencies-*.tar.gz`), Hermes for iOS 260318099.0.5, debug and release | `https://repo.reactnative.dev/maven2/` | CocoaPods (`expo run:ios`). P0b's prebuild found each in the shared cache (`~/Library/Caches/ReactNative`, checksums verified) and downloaded none |
| The CocoaPods spec index, and `MultiplatformBleAdapter` 0.2.0 (ble-plx's) and `fast_float` 8.0.0 | CocoaPods' CDN for the index; the pods' own sources, mostly GitHub ‡ (not logged) | CocoaPods. P0b's install added only `ExpoCrypto` 58.0.8, from `node_modules` |
| Gradle 9.4.1 | `https://services.gradle.org/distributions/gradle-9.4.1-bin.zip` | The Gradle wrapper |
| Android build-tools 37.0.0 | Google's SDK repository ‡ | The Android Gradle plugin, after checking the SDK's licences |
| The Android Gradle plugin, AndroidX, React Native's Android artifacts and the other libraries | Google's Maven repository and Maven Central ‡ (Gradle's cache already held part of them from Android Studio) | Gradle. P0b's builds logged no download (expo-crypto's Android side builds from `node_modules` with libraries already cached) |
| One version check | Expo's servers ‡ ("An update for expo is available: 58.0.25 → ~58.0.26") | The first `expo start` of part 1, before `EXPO_OFFLINE=1` was added; no account, no login |

## Where the evidence is

In the reviewer's scratchpad. Part 1, `step0c/` (not in the repository): `ios-build.log`, `ios-build-2.log`, `android-build.log`, Metro's logs per run (`metro-1-ios-baseline.log`: the socket refused without the plugin; `metro-ios-three-sockets.log`: the three URLs with the plugin; `metro-ios-walk-a.log`, `-b`, `-c`: the walks), `shots/ios_*.png`, `export-native/`, `hub.log`, and the scripts `walk.sh` (iOS) and `android-run.sh` (Android).

P0b, `P0b/`: `ios-run.sh` and `android-run.sh` (adapted from part 1's: they start Metro and the app, carry ports with `adb reverse`, and read the screen's text with `uiautomator dump`); `ios-layout-before.log`, `ios-layout-after.log`, `android-sockets-layout.log` (the probe's measurements, and Android's sockets); `ios-engine-sockets.log`, `android-engine-sockets.log`; `ios-walk-*.log`, `android-walk-*.log`; `shots/` (one iOS screenshot per route, and the probe before and after); `android-screens/` (each Android route's accessibility tree); `wave0-layout.tsx.probe` (the probe route); `tools/` (`dump-native.mjs` and `compile-native.mjs`: react-native-css's compiler on the exported CSS; `resolve-lh.ts`: its runtime functions on the result; `lh-chrome.mjs`: px, `calc` and decimal line heights in Chrome; `web-shots.mts`: every web route before and after); `native-rules-before.txt`, `native-rules-after.txt`; `dist-before/`, `dist-after/`, `dist-final/` (the web exports compared); `web-before-1/`, `web-before-2/`, `web-after-1/` (the screenshots and boxes compared); `export-native/` (the release bundles searched); `prebuild.log`, `ios-build.log`, the Android build logs, `hub.log`, `e2e-chrome.txt`, `check.txt`.
