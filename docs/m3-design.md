# M3 design: the phone build, Bluetooth pairing and the phone-only features

Proposed 2026-11-18, revised the same day with the coordinator's rulings and reconciled twice with the two sibling designs as they were revised, for review before any code is written. It designs the phone half of milestone M3 of [build-plan.md](build-plan.md) (Bluetooth pairing in the phone build and on the devices, Wi-Fi details, factory reset, the pairing code on the e-paper display, and the app's side of update over Bluetooth), the phone build of the app that all of it needs, and milestone M5, "Phone-only features", as far as it can be built before the relay exists. Two finished designs sit beside it and are not repeated here: [m3-updates-design.md](m3-updates-design.md) ("UD": two-slot updates, the hub's signing key, rollout, update over Wi-Fi, and the device side, format and session of update over Bluetooth) and [m4-design.md](m4-design.md) ("RD": the relay, push, the relay-to-phone protocol, the push payload, and the configuration point). Section 10 says what this design takes from each.

"M2 n" means section n of [m2-design.md](m2-design.md), "HD n" of [hub-design.md](hub-design.md), "FD n" of [firmware-design.md](firmware-design.md), "UD n" of the updates design, "RD n" of the relay design, "AD" [app-design.md](app-design.md), "§n" a section of [protocol.md](protocol.md). D and O numbers refer to [architecture.md](architecture.md) (D125 to D131 are the relay design's proposals; this design proposes D132 and D133); AP, PR, DS, UP, RA and HB numbers to [software.md](requirements/software.md). **‡ marks a fact about Apple, Google, Expo or a library stated from memory**, to be checked before anything depends on it; a fact read in this repository's `node_modules` or code says where it was read. **† marks a provisional value of this design**, to be set by a measurement or in review.

The design in ten lines:

- The phone build is the same `app/` code. What is web-only today (the key in Web Crypto and IndexedDB, the page's own origin, the address fragment, browser tabs, the QR code drawn as SVG, file input and download, the browser's notifications and sound, Web Crypto's hashing and random numbers) moves behind platform files; the screens, the store and the channel client run unchanged.
- It is a development build made on this Mac with Expo's local tools (`expo prebuild`, `expo run:ios`, `expo run:android`): never Expo Go, no paid build service. Xcode 27.2 with iOS 18.4, 27.0 and 27.1 simulators, and an Android SDK with an API 37 emulator, are installed. Its names and identifiers come from the one configuration point, `packages/deployment/` (RD 2).
- The phone keeps its keys in the phone's secure storage, readable after the first unlock so that a Disarm from the lock screen can use them, and not carried to another phone by a phone backup.
- At home it reaches the hub by address on the apps' HTTPS port. TLS there is carriage only: the Noise session, with the hub's key pinned at linking, proves the hub (D132). Away, it reaches the hub through the relay's phone path (RD 3).
- Linking needs from the hub the apps' port in its mDNS record and its addresses in `hub.info`; the phone adds the camera, deep links, a typed code with discovery, and keeping every backup key it is given. A fault in M2's `backup.key` is fixed on the hub.
- Restore, which M2 built on the hub and left waiting for a phone (D119), gets its phone side: a TypeScript client of restore's six messages, tested against the real hub.
- Pairing is ESP-IDF's protocomm over Bluetooth with its SRP security, the code on the e-paper as the password, carrying the setup messages USB carries (§10); the hub provisions through two operations, `pair.prepare` and `pair.finish` (D133). Update over Bluetooth uses the updates design's own service and session, opened only on the hub's offer over LoRa.
- react-native-ble-plx is the Bluetooth library, behind an interface of ours. A scripted board behind the same interface runs pairing and update in `bun test` and, through a bridge, in the simulators; Chrome's Web Bluetooth on the Mac tries pairing against a real board before any phone exists; spike S9 proves the rest on real phones.
- Several hubs, the app lock, notifications while the app is open and the countdown screen are built now. Push, critical alerts, the lock-screen Disarm, home-or-relay switching and presence follow the relay design; critical alerts also wait for the bundle identifier, Apple's entitlement and a real iPhone.
- Nine packages are proposed (one only if a check fails), three more already installed through Expo become direct, plus two native modules of ours. Nothing is installed until the reviewer approves.

## 1. What this designs, and what stays

### The build plan's rows, and where each is designed

| Piece | Requirements | Here | Elsewhere |
| --- | --- | --- | --- |
| The phone build (not a row of its own; M3 and M5 need it) | D31, D48, D93 | Section 2 | The configuration point: RD 2 |
| Spike S9 | | Section 5, "What spike S9 must show" (pairing) | The transfer's measurements: UD 5, "What spike S9 must measure" |
| Bluetooth pairing on the devices and in the phone build, Wi-Fi details, factory reset | PR1–PR4, DS7, DS8, AP2 | Section 5 | The firmware's Bluetooth link: FD, by the firmware owner, from section 5 |
| Pairing code generation and e-paper display | PR6, D85 | Section 5, "The board" | The display driver: FD |
| Linking a phone; restore from a phone | D34, D61, D62, D78, D99, D119, D120 | Sections 3, 4 | |
| Update over Bluetooth from the phone | UP6, AP3 | Section 7, the app's side | Device side, frames, session key, service: UD 5 |
| Two-slot updates, signing, rollout, update over Wi-Fi | UP1–UP5, UP7–UP9 | The pages that show them (section 7) | UD 2–5 |
| M5: several hubs, home or relay, notifications, critical alerts, lock-screen Disarm, countdown screen, presence, app lock | AP1a, AP6, AP8, AP9, AP9a, AP10, AP11, RA5, RA8 | Section 6 | Push, the payload and the relay path: RD 3, 5 |

### What does not change

- **The look.** AD governs the phone as it governs the web. Section 2 proposes, in AD's style, the rules a phone needs that AD does not have; nothing is restyled.
- **The channel's cryptography** (M2 5, 6): Noise IK for sessions, XXpsk3 for linking and restore, the prologues, `seq` and stored replies, events and `rev`. A phone is a client of kind 2 (`"phone"`), which M2's schemas and hub already accept. There is **one channel version 2** for the three designs, frozen once by one step 0 owner; section 3 lists what this design contributes to it.
- **The hub's side of linking and restore**: link tokens and codes, `LinkResult` with the backup key for phones, `backupKeyChanged`, and restore's six messages on `/app/restore`, built in M2 and tested with scripted phones (`hub/test/unit/shell-app/linking.test.ts`, `hub/test/unit/upkeep/restore-update.test.ts`). `backup.key` changes (section 4).
- **The device protocol.** The pairing data (§9) and the setup messages (§10) travel over Bluetooth byte for byte as over USB. Added: the Bluetooth carriage for pairing (section 5), two text fields in the mDNS record (section 2), and the updates design's messages and frames (UD 5).
- **Security scope (D124).** This design builds what the architecture decided: keys on the phone, the channel as built, a password-authenticated pairing over the radio (which D124 still defends), and the app lock as a requirement. Anything further is a question in section 12, with what it defends and what it costs.

## 2. The phone build

### What runs unchanged, and what is web-only today

Read in `app/src` on 2026-11-18.

| Where | Today | On the phone |
| --- | --- | --- |
| `src/app/` (routes), `src/state/`, `hub/channel.ts`, `hub/client.ts` without tabs, `hub/codec.ts`, `hub/faults.ts`, `wire.ts`'s `Inbox` and `Timers`, most of `src/ui/` | Platform-neutral React Native and TypeScript | Unchanged |
| `_layout.tsx` | Imports `startBrowserClient` and the browser's arrived code directly | Imports `startClient` from `hub/start.ts`, resolved per platform (below) |
| `hub/browser.ts`, `hub/arrival.ts`, `hub/fragment.ts` | The page's own origin, a code in the address fragment, `pagehide` | `hub/start.native.ts`: addresses from the stored record; codes from deep links (expo-linking, installed) and the camera |
| `hub/tabs.ts` | Web Locks and BroadcastChannel, one session per browser | Not used: an app is one process, and `client.ts` already runs without tabs |
| `wire.ts`'s `webSocketConnect`, `channelOrigin` | The browser's WebSocket to the page's origin | `hubSocketConnect` at home (below); the relay's `Connect` away (section 6) |
| `platform/client-key.ts` | `StoredClient.key.privateKey` is a Web Crypto `CryptoKey`; `makeClientKey` and `staticKeyOf` use `crypto.subtle` | The key's type becomes the platform's: 32 bytes on the phone, its Diffie-Hellman by `@noble/curves` 2.4.0 (already a dependency of `@hsn/protocol`) |
| `platform/keys.web.ts` | IndexedDB | `keys.native.ts` over expo-secure-store |
| `hub/digest.ts` | `crypto.subtle.digest`, asynchronous | The protocol package's own functions over `@noble/hashes`' SHA-256 (`secretPsk`, `secretLookup`, `typedPsk`, `appIdentityBytes`), which `digest.ts` mirrors and `test/digest.test.ts` already compares |
| `hub/files.ts` (one line), `hub/browser.ts` | `crypto.getRandomValues` | Not provided by React Native 0.88.1's JavaScript (searched in `node_modules/react-native/Libraries`); wave 0 checks the engine |
| `ui/qr.tsx` | Draws an `<svg>` element | `qr.native.tsx`: the same modules (`toqr`, pure JavaScript) drawn as runs of Views, each a whole number of pixels so no seam shows |
| `ui/file-input.tsx`, the uploads in `ui/backup.tsx` and `ui/updates.tsx` | `<input type="file">` | Not on the phone: uploads are console-only (M2 6, "C"; `firmware.upload` too, UD 4), so these pages say "do this on the hub computer" |
| The download in `ui/backup.tsx` | `Blob`, `URL.createObjectURL`, `document.createElement("a")` | The export written to the app's cache (expo-file-system) and handed to the share sheet (expo-sharing) |
| `ui/notifications.tsx`: `BrowserNotifications`, the alarm sound | `Notification`, `AudioContext` | expo-notifications: a notification with sound while the app is open (M3); push from M5 |
| `ui/parts.tsx`: `spaceToPress`, the focus rings | `onKeyDown`, NativeWind's `web:` variant | Ignored on the phone; no change |
| `global.css` `@font-face` | Web only | expo-font (below) |
| `app.json` | `"platforms": ["web"]`, fixed name, slug and scheme | `app.config.ts`, with iOS and Android, reading `@hsn/deployment` (RD 2); the scheme stays `hsn` (below) |

### Choosing a file per platform

Metro takes `x.native.ts` before `x.ts` on iOS and Android, and `x.web.ts` on the web ‡. Each pair has a plain `x.ts` holding only the interface, which TypeScript resolves; each platform file ends with `satisfies` that interface, so both are checked by `tsc`. A lint rule refuses `window`, `document`, `navigator`, `indexedDB`, `localStorage`, `crypto.subtle` and `BroadcastChannel` outside `*.web.ts(x)`, as the core's lint refuses `Temporal` (M2 2), so the split cannot quietly erode.

### Keys and storage on the phone

| Item | Where | Notes |
| --- | --- | --- |
| The client's static private key, 32 bytes, one per hub | expo-secure-store, item `hub.<identity>.key` | Made with `@noble/curves`' X25519 from `crypto.getRandomValues` |
| The record: hub identity and static key, client number, person, last `seq`, the hub's addresses and apps' port, the address that last worked, the hub's relay URL (RD 3: from `hub.info`, the code's `r=`, or the default), the home's name on this phone (M5) | Item `hub.<identity>.record`, JSON, about 500 bytes | A secure-store item should stay under about 2 KB ‡ |
| The backup keys, one per epoch | Item `hub.<identity>.backup` | At most 16 epochs (section 4) |
| The list of linked hubs | Item `hubs` | |
| M5: the push key and key id per hub, the hub's identity, the last `armed` and the last shown `seq`s | Where the notification extension and service can read them: the App Group `DEPLOYMENT.ios.appGroup` and a shared keychain group on iOS ‡, the app's own storage on Android (RD 13, F3) | Written by our `push` module |
| A firmware image during a Bluetooth update | The app's cache, by image id; deleted when the session ends (UD 9) | expo-file-system |
| A Bluetooth update's session key | Memory only, until `expiresInMs` (UD 5) | Never written, logged or shown |

- **Readable after the first unlock, on this device only.** On iOS the items use `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` ‡ (expo-secure-store's `keychainAccessible`, whose default is "when unlocked" ‡). The lock-screen Disarm (D51, D63) must read the key while the phone is locked; "this device only" keeps the key out of phone backups, so a new phone is linked from another device or the hub computer (D61) and is given the current backup key then (D99). On Android expo-secure-store encrypts with a key held in the Android Keystore ‡, and the app excludes its storage from Android's automatic backup ‡, to the same effect.
- **`seq` as on the web** (M2 8): the next number is written before the request is sent (`reserveSeq` over the native store). A secure-store write takes a few milliseconds ‡.
- **One key per hub**, as the web makes one per link: two hubs cannot tell they share a phone.
- **The interfaces.** `RecordStore` keeps its shape. `StoredClient.key` becomes `{ publicKey: Uint8Array; secret: PlatformSecret }`, `PlatformSecret` being `CryptoKey` on the web and `Uint8Array` on the phone; `makeClientKey` and `staticKeyOf` move into the platform files. A `HubRecords` lists one `RecordStore` per hub; the web uses it with exactly one, so M5's several hubs need no migration.
- **Removal.** When the hub says this client was removed (the `session` event), or after M2 8's five refused handshakes, the phone deletes that hub's record, key, backup keys and push key, and says so.

### Reaching the hub at home

- **Where.** The apps' listener, `wss://<address>:<apps' port>/app` (M2 5), as a browser on the home network uses it; never the console's loopback listener.
- **Which address, in order:** the one that last worked; the hub's addresses as it last named them (the QR code's `a=`, then `hub.info`'s `addresses`, version 2); then an mDNS browse for `_hsn-hub._tcp` for 2 s †. Each is given 1.5 s † to connect. The relay comes last (section 6). A connection to the wrong computer cannot pass: Noise's message 2 fails (`notOurHub`, as built). The per-hub name (RD 7, built last, when a domain exists) is not used by the phone; when link codes gain `n=` with the names work, the phone ignores it.
- **mDNS today** advertises the device port with one TXT key, `id`, holding the device-signing identity in 16 hex digits (`hub/src/shell/advertise/mdns.ts`). M2 5 promised an `app=8444` field; it is not built. **Two TXT keys are added, `app` (the apps' port) and `aid` (the app identity, 26 characters)**: H1's work, and protocol text in section 12. Both are unauthenticated and only choose where to try.
- **The certificate (D132).** The hub's certificate is self-signed (M2 5). A phone's TLS refuses it, and React Native's WebSocket has no per-connection way to accept it: iOS builds SocketRocket sockets through one global `RCTSetCustomSRWebSocketProvider`, Android's `WebSocketModule` takes one global `setCustomClientBuilder` (both read in React Native 0.88.1). **The phone needs no trust from TLS**: unlike a browser it loads no code from the hub, and every byte it sends is inside Noise, whose hub key it pinned at linking. So the phone accepts the certificate the hub presents, only for connections to a private, link-local or loopback address or a `.local` name, and never for anything else (the relay keeps ordinary TLS). Rejected: pinning the fingerprint the code carries (`c=`), which a new address or the renewal at 700 days (M2 5) changes, so the phone would refuse its own hub for no protection Noise does not already give. Rejected: a plain `ws://` app path on the device listener, which changes the hub and D101's split.
- **Wave 0's one-day check** (the reviewer's condition): whether React Native's own WebSocket can be made to accept the hub's certificate for a home-network address, and only for one, through those two global hooks (a provider on iOS and a client builder on Android that decide by host) with a few lines of native code in a config plugin. If it can, that is used, and `hub-net` shrinks to the mDNS browse. If it cannot, `hub-net` carries the socket too.
- **Headers.** The hub checks `Host` (one of the certificate's names or addresses) and `Origin` (exactly `https://` and the `Host`) on every upgrade (`hub/src/shell/app/policy.ts`). The phone connects by an address the certificate names and sends `Origin: https://<address>:<port>` itself (React Native's WebSocket takes headers ‡; Android's adds a default origin, read in its `WebSocketModule.kt`). No hub change.
- **The phone's own permissions.** iOS asks once before an app's first connection to a home-network address and gives no way to ask or to read the answer; the app declares `NSLocalNetworkUsageDescription` and `NSBonjourServices` (S4 3.3, Apple TN3179). The hub's addresses are allowed by App Transport Security's `NSAllowsLocalNetworking` ‡. Android 17 (API 37) enforces `ACCESS_LOCAL_NETWORK` for apps that target it (S4 3.3); React Native 0.88.1 targets API 36 (read in its `gradle/libs.versions.toml`), so it is not enforced yet, but the app declares and asks for it from the start, in the Nearby devices group with Bluetooth's.
- **Our module, `hub-net`** (`app/modules/hub-net/`, Swift and Kotlin): `browse(service, ms)` on Network's browser ‡ and NsdManager ‡; and, unless wave 0's check makes it unneeded, `open(url, origin)`, binary `send`, `close(code)`, events `message` and `closed` with a reason (`localNetworkDenied` where the system says so ‡), on URLSession's WebSocket task ‡ and on OkHttp, which React Native already carries ‡. Its TypeScript face is a `Connect` (`wire.ts`), so the channel and the handshakes do not change.

### The JavaScript engine: wave 0's checks

React Native 0.88.1 runs Hermes. Each item is checked once on each simulator by a test screen in the development build:

| Needed | Used by | If missing |
| --- | --- | --- |
| `crypto.getRandomValues` | keys (noble), job numbers | expo-crypto's, put on `globalThis` at the entry ‡ |
| `TextDecoder` with `fatal: true` | `codec.ts` | A short strict UTF-8 decoder in `codec.ts`. Expo's native runtime installs `TextDecoderStream`, `URL` and `structuredClone` but not `TextDecoder` (read in `expo/src/winter/runtime.native.ts`), so it relies on the engine's |
| `Intl.DateTimeFormat` with `timeZone` | times in the hub's zone (M2 8 left this check to M3) | A blocker, raised to the reviewer before wave 1 |
| `BigInt` arithmetic, and its speed | SRP (section 5) | Timed: one SRP session on the simulator, then on real phones in S9 |
| NativeWind 5.0.0-rc.1 on native | every screen | Proven on the web only (stack.md). Every route is rendered on both simulators; a failure goes to the product owner, whose choice it is |

### Fonts

expo-font (58.0.12, installed with Expo) loads the four bundled faces at start under the family names `global.css` already uses (`AtkinsonHyperlegibleNext_400Regular` and the others, chosen so the phone could use them: `scripts/fonts.ts`). Nothing is fetched (AD, "Type"). The root renders nothing until they are loaded, as it already waits for i18next, and `expo-system-ui` keeps the background `limewash` meanwhile. Rejected: embedding the fonts through expo-font's config plugin, where iOS names a face by its PostScript name and Android by its file name ‡, so each token would need two names.

### A phone's layout: rules proposed for app-design.md

AD stays as it is. What it does not cover, with the rule proposed in its style (the text to add is in section 12's proposals):

1. **Safe areas.** The state field fills the space behind the status bar in its own colour; its text starts below it. The bottom bar sits above the home indicator, its `limewash` reaching the screen's edge. In landscape the gutters grow by the side insets. Written with NativeWind's safe-area utilities (`pt-safe`, `pb-safe`, from `tailwindcss-safe-area` 1.3.0, which NativeWind 5's theme imports; read in `node_modules`), never as numbers; Expo Router already provides the inset provider (read in `expo-router/build/ExpoRoot.js`).
2. **The status bar.** Dark text on the day field and on every other page; light text on the night and alarm fields (expo-status-bar, installed).
3. **Back.** Android's back button goes from a page to its destination's first page or index, from there to Home, and from Home out of the app. iOS has no swipe back: the "Settings" link above each settings page (AD) is the way back, as on the web. Routes stay in Expo Router's `Slot`.
4. **Text size.** The app follows the phone's text size up to twice its own sizes, AD's 200%, and no further (React Native's `maxFontSizeMultiplier` ‡). The bottom bar's words never shrink; its height grows.
5. **The keyboard.** While a person types, the field and the action that saves it stay visible above the keyboard.
6. **Announcements.** A countdown or an alarm is announced at once (M2 8). Android reads the live region; iOS needs `AccessibilityInfo.announceForAccessibility` ‡, which the alarm banner calls.
7. **Asking for a permission.** Never at start. At the moment it is needed, a page says in one sentence what the phone will ask and why, with one button that names it ("Allow the camera"); the system's question follows. If the answer is no, the page says what will not work, offers "Open settings", and offers the way that needs no permission where there is one ("Type the code instead"). The system's own question (iOS's purpose strings) uses the same sentence. The permissions: camera (scanning), Bluetooth (pairing, updates), local network (reaching the hub), notifications (M3 and M5), location always (presence, M5), Face ID (app lock, M5).
8. **The camera screen.** The page title "Scan the code", one line saying what to point at, then the camera's view: a square the width of the content column, 12 px corners, nothing drawn over it. Under it a quiet button "Type the code instead" and, where the phone has a light, "Light on" or "Light off". When a code is read, the view stops at once and the next page says what was found. A code that is not one of ours gets an ochre notice: "This is not a code from your home system." The camera's view is a fourth filled surface beside AD's three.
9. **Notifications and their one action** (M5). The title is the state's word as the state field says it ("Countdown", "Alarm"); the body says what happened, one sentence ("Front door opened at 14:02."). At most one action, named by the push's `actions` (RD 5): "Disarm" (D51) where the person may disarm, or "Arm away" for a presence offer. With several homes, the body starts with the home's name. No app name, no symbols. The texts come from the translation files by `n.kind` (RD 5); the relay's own two alerts use RD 5's wording. When a device's alarm arrives, the phone removes that device's countdown notification, so one replaces the other on the phone and nothing on the wire says so (RD 5, F9).
10. **Orientation.** Phones in portrait; tablets either way, since the layout already works from 768 px.
11. **One colour scheme.** The app declares itself light (`userInterfaceStyle`), so the keyboard and system dialogs stay pale while AD has one scheme.

### Development builds, not Expo Go

Expo Go runs only the native modules it was built with: not react-native-ble-plx, not ours, and it follows one Expo SDK at a time ‡. So the phone app is always a **development build**, made by Expo's continuous native generation: `expo prebuild` writes `ios/` and `android/` from `app.config.ts` and the config plugins, and those folders are not committed ‡. A debug build loads its JavaScript from Metro on the Mac, so JavaScript changes need no rebuild; a native change (a module, a plugin, a permission string) needs `prebuild` and a new build. `expo-dev-client` (a launcher and menu) is not needed and not proposed.

### Building and running on this Mac

Found with read-only commands on 2026-11-18:

| | Found |
| --- | --- |
| Mac | macOS 27.2.1 on arm64 |
| Xcode | 27.2 (27B52), `/Applications/Xcode.app` |
| iOS simulators | Runtimes iOS 18.4, 27.0 and 27.1. Devices: iPhone 16, 16 Plus, 16 Pro, 16 Pro Max, 16e and iPads (18.4); iPhone 17, 17e, Air, 18 Pro, 18 Pro Max and iPads (27.0); iPhone Duo (27.1) |
| CocoaPods, Ruby | 1.17.0 (Homebrew); 4.0.9 |
| Android Studio | Installed, SDK at `~/Library/Android/sdk`: platform-tools (adb 1.0.41, version 37.0.1), emulator 37.2.12, platforms android-36 and android-37.0, build-tools 35.0.0 and 36.0.0, NDK 27.1.12297006, CMake 3.22.1, the `licenses` folder; no command-line tools |
| Android emulator | One AVD, "Medium_Phone": API 37, Google Play image, arm64-v8a |
| Java | Zulu 17.0.21 (arm64); Android Studio's own runtime |
| Not set, not found | `ANDROID_HOME` unset; `adb` and `emulator` not on the `PATH`; no Watchman, Maestro or idb; no ESP-IDF on 2026-11-18 (v6.1.1 is now being installed under `~/esp/esp-idf`, approved) |

What React Native 0.88.1 asks (read in its `gradle/libs.versions.toml` and `scripts/cocoapods/helpers.rb`): Android compile SDK 37, target 36, minimum 24, build-tools 37.0.0 (not installed), NDK 27.1.12297006 (installed), Android Gradle plugin 9.2.1, Kotlin 2.2.0; iOS 15.1 at least, which Expo 58 may raise ‡.

How, with no paid service:

1. The owner sets `ANDROID_HOME` to `~/Library/Android/sdk` and puts its `platform-tools` and `emulator` on the `PATH`.
2. Once the dependencies are approved and installed: `cd app && bunx expo prebuild`.
3. iOS: `bunx expo run:ios --device "iPhone 17"`. CocoaPods installs the pods; a simulator build needs no signing and no Apple account ‡.
4. Android: start "Medium_Phone", then `bunx expo run:android`.
5. Metro serves the JavaScript, resolving `@hsn/protocol` and `@hsn/deployment` through the Bun workspace as the web export resolves `@hsn/protocol` today.
6. The hub for the phone runs on the Mac. A simulator shares the Mac's network ‡ and the emulator reaches the Mac's home-network address through its virtual router ‡, so both use that address, which the hub's certificate names. The emulator's `10.0.2.2` is not in the certificate, so `Host` would be refused (421). Away-from-home paths are tried against RD 11's local relay.

What the first runs download is in section 11, so the product owner can be told once.

### Names, identifiers and the Apple account

**One configuration point:** `packages/deployment/src/deployment.ts` (RD 2, D128). `app/app.config.ts` replaces `app.json` and reads `DEPLOYMENT.productName`, `ios.bundleId`, `ios.appGroup`, `ios.teamId` and `android.applicationId` from it; nothing in `app/` names them otherwise. Its placeholders (`invalid.hsn.app`) build for the simulators; a release build refuses them (RD 2). The bundle identifier and application id can be chosen before the product's name (RD 15, QP1).

**The URL scheme is `hsn`, everywhere, and never follows the product's name.** It is the protocol's: `hsn://link/1`, `hsn://restore/1`, and `hsn://pair/1` on every board's display, which boards in houses cannot change. It stays in `LINKING` (`packages/protocol/src/app/constants.ts`) and is not in the configuration (RD 2); `app.config.ts` sets the app's scheme to it.

**Cleartext to a local relay, development builds only.** For testing against a relay run on this Mac (RD 11, F2), a development build may open `ws://` to a private or loopback address. On iOS that is App Transport Security's local-network exception (`NSAllowsLocalNetworking`, already declared for the hub, which covers private addresses ‡); on Android a config plugin of ours sets cleartext traffic on, in the development build only, since Android's network security configuration cannot name address ranges ‡. A release build refuses it in three places: `app.config.ts` applies the Android setting only when the build is not a release (`HSN_RELEASE` unset); the release check beside RD 2's rules fails the build if the generated Android manifest allows cleartext; and the app's relay `Connect` refuses any `ws://` URL when it is not a development build (`__DEV__` false), whatever `hub.info` says. The hub's own `relay.set` accepts `ws://` only for a loopback or private address (RD 2).

The steps in the Apple account are RD 5's AS1 to AS7 and Google's Firebase project (RD 5, QP3); this design adds none. What each means for the phone:

| Step (RD 5) | Phone work it unblocks | Until then |
| --- | --- | --- |
| None | Every simulator and emulator build | |
| AS1 (bundle id, extension id, App Group) | The extension's shared storage with the real group; real APNs to the simulator | The placeholder group, which the simulator accepts ‡ |
| AS3 (critical-alert entitlement) | Asking for critical alerts (AP9) | Time Sensitive (AS4) |
| AS7 (a real iPhone registered; Xcode signed into the account) | Every build on a real iPhone, S9 and S10 | Simulators only |
| Firebase project | Real FCM to the emulator and an Android phone | RD 5's stand-in (S5 step 4) |

## 3. Linking a phone (D34, D61, D62, D99, D120, D121)

### What M2's hub already does, and what the phone adds

The hub makes link tokens (QR code `hsn://link/1?h&s&a&p&c`, link address, typed code `XXXX-XXXX-XXXX`), runs XXpsk3 linking for `kind: "phone"`, gives a phone the backup key and its epoch in `LinkResult`, makes invites that last 24 hours, removes clients with what they linked, tells a person's other clients of a new link, and sends `backupKeyChanged` (M2 5, 7). Version 2 adds the code parameter `r=` (the hub's relay, when not the default, RD 9); `n=` (the per-hub name) arrives later, with the names work. The prefix stays `hsn://link/1`. The phone adds:

| Way in | How the phone gets it | Where it connects |
| --- | --- | --- |
| A QR code: the web app's or another phone's link screen, the installer's terminal (D62) | The camera screen (section 2), or the phone's own camera app opening the link in the app as a deep link | At home: the code's `a=` addresses and `p=` port; else through the relay to `h=` (RD 3; the relay from `r=` or the default). The hub's key is checked against `h` at message 2 (as built in `handshake.ts`) |
| A typed code | A field, read by the protocol's `parseTypedCode` | At home only: each hub an mDNS browse finds in 2 s † is tried in turn; a lookup a hub does not hold closes before message 2 and costs no try (M2 5). Away it cannot name the hub, so the phone says "A typed code works only on the home network. Use the QR code or link instead." (RD 3, F10) |
| A link address pasted into the field | Read by `parseLinkFragment` | Its own address |

- **Deep links.** A code that arrives from another app is shown first, "Link this phone to the home at 192.168.1.20?", with "Link this phone" and "Cancel". A code scanned or typed in the app links at once: the person has just chosen to.
- **The phone's name.** `LinkRequest.name` is "iPhone" or "Android phone" (translated); the person can rename it under People. When the token asks for the person's name (`askName`), the phone asks as the web does.
- **Inviting another phone** from a linked one is the existing screen (`ui/link-device.tsx`) with the QR code drawn natively (section 2), and React Native's own share sheet for a code meant for someone not present.
- **Removal** is the existing screens. On the removed phone, the `session` event deletes that hub's record and keys (section 2), and the link page says "This phone was removed from <home>." with "Link again".
- **The first phone of a hub with no screen** (D62, D105): the installer prints a QR code and a typed code; the phone links with either and runs first-time setup (AP0). Devices are added over Bluetooth (section 5). The Wi-Fi details become settable from a phone (`site.wifi` for *manage system*, no longer console-only: section 5, H1).
- **Words for two new failures**, beside M2's: "The phone is not allowed to reach your home network. Turn on Local Network for this app in Settings." (iOS, when the system refuses ‡); "No hub answered on this network. Check that the phone is on the home Wi-Fi, or scan the QR code." (a typed code and no hub found).

### This design's contribution to channel version 2

One version 2 for the three designs, frozen once by one step 0 owner. Names' parts (`names.*`, `hub.info`'s `name`, `n=`) are not in the first freeze: they arrive with the names work, when a domain exists. The hub speaks 1 and 2; the web build speaks the hub's; the phone speaks 2 only, since nothing is in use before the product is finished (D119). This design contributes:

| Addition | Section |
| --- | --- |
| `hub.info` gains `addresses: string[]` (the certificate's home-network addresses, as the code's `a=` lists them) and `appsPort`; the shell has both (`hubFacts`). The relay design adds `relay` to the same reply (RD 9); `name` arrives later, with the names work, outside the first freeze | 2 |
| `pair.prepare` and `pair.finish` | 5 |
| `backup.key` changed, `backup.keyHeld` new, and the snapshot's `backupKeyEpoch` for phones | 4 |
| `site.wifi`'s permission: *manage system*, from any client (was console only) | 5 |
| `presence.set` (M5) | 6 |

The relay design contributes `push.register`, `push.unregister`, `push.test`, `relay.*`, `update.offers`, `update.fetch`, the snapshot's `push` and the code's `r=` (RD 9); the updates design `firmware.*` (with `firmware.offers` and `firmware.fetch`), `rollout.*`, the device object's `update` and the `deviceUpdate` event (UD 4). Not in the first freeze: `names.*`, `hub.info`'s `name` and `n=`, which come with the names work, when a domain exists (RD 9).

## 4. The backup key and restore from a phone (D78, D99, D119)

### Keeping the key

- **At linking**, `LinkResult.backupKey` (key and epoch) is written in the same write as the hub's record.
- **On `backupKeyChanged`**, and at the start of any session whose snapshot names an epoch the phone does not hold, the phone asks `backup.key`, writes the key, then confirms with `backup.keyHeld` (below).
- **Old epochs are kept**, at most 16. The key is replaced when a phone is removed (M2 9), against that phone; the phones that remain are not what it guards against, and a copy of a backup made before the replacement and kept outside the backup folder stays restorable by them.
- **Deleted** with the hub's record when the phone is removed or the person removes that home from the phone.
- **Never shown**, never in a log, a store, an event or a crash report.

### The fault in M2's `backup.key`, and its fix (A8)

Today (`hub/src/core/upkeep/ops.ts`, `hub/src/core/people/backup-epoch.ts`) the hub answers `backup.key` only for a phone whose recorded epoch is older than the key's, answers a phone at the current epoch `unauthorized {}`, and records the epoch as held when it answers. A phone that loses the reply, or fails to write it, is recorded as holding a key it does not have and is refused ever after. The fix, a hub change in version 2 for A8, M2's owner of `hub/src/core/upkeep/` (with the owner of `people/` for `backup-epoch.ts`):

1. **`backup.key`** (a read, no `seq`): any linked phone (client kind 2) may ask at any time; the reply is always the current `{key, epoch}`. The hub no longer changes `clients.backup_key_epoch` when it answers. Browsers and the console stay refused (M2 5). The routine `commands` row it already writes stays, without the key.
2. **`backup.keyHeld {epoch}`** (new; a change, with `seq`; the phone itself): sent after the phone has written the key. The hub sets `clients.backup_key_epoch` to `epoch`, written now, and refuses an epoch other than the current one as `invalid {field: "epoch", reason: "range"}`. `LinkResult`'s epoch is recorded as held at linking, as today, since the phone writes the key with its record or the link fails.
3. **The snapshot** gains, for a phone, `backupKeyEpoch`: the current epoch. A phone compares it with what it holds at every session, so a replacement made while it was away is caught without asking.
4. Tests (A8): a reply lost after `backup.key` leaves the hub's record unchanged and a second ask succeeds; `backup.keyHeld` with a stale epoch is refused; the M2 tests that expected `unauthorized` for a current phone are changed.

### Restoring from the phone

M2 9 built the hub's side and tested it with a scripted phone; the phone's side is new, in `app/src/hub/restore.ts`, platform-neutral TypeScript on the protocol package's Noise.

1. On the new hub's console the person uploads the backup, sees its age and goes on (D122); the console shows the restore code as a QR code.
2. On the phone: Settings, "Restore a hub" (shown when the phone holds any backup key), opens the camera screen. A restore code scanned from the link camera is recognised by its prefix too.
3. The phone runs restore's messages on `/app/restore` (M2 5), at the code's address: it checks message 2's key against `h`, reads `RestoreOffer {identity, epoch, madeMs, lastChangeMs}`, and looks for a backup key for that identity and epoch. Without one it closes and says "This phone does not hold the key for that backup. Use a phone that was linked to that home on <date>." With one it says "Restoring <home> from the backup of 3 March" and sends `RestoreKey`; the console has already asked (D122), so the phone does not ask again.
4. On `RestoreResult {ok: true}` the phone replaces that hub's addresses with the code's `a=` and `p=`, waits for the restart, and connects with IK as before: the restored hub has the old identity and app key, and the file holds this phone's client. Its first change is answered `seqTooLow` once (the 2³² jump, M2 9), which `raiseSeq` already handles. The failures (`wrongKey`, `badFile`, `expired`, `busy`) use M2 9's words.
5. A phone linked after the backup was made is not in the file, so the restored hub refuses it: the phone says so and offers to link again from another phone or the hub computer.

6. After a restore every device gets a new key (UD 7, D141): a device not yet heard under its new key shows "Not heard since the restore" until it is, and Bluetooth updates of it are held meanwhile (`held: keyChange`, section 7).

Tested under `bun test` against the real hub, as `app/test/real-hub.test.ts` runs it.

## 5. Bluetooth pairing (PR1–PR4, PR6, DS7, DS8, AP2, D85, D133)

### The exchange

```
Phone app                            Board (pairing window open)             Hub
  scan by protocomm's service UUID  ←── advertising: role, chip, state
  connect; read proto-ver (plain): "hsn-pair/1", role, chip, firmware
  prov-session: SRP6a with the code, ESP-IDF security 2
  hsn-setup, inside the session:
    Identify  ─────────────────────→
              ←───────────────────── Identity (§10)
  pair.prepare {identity, name}  ──────────────────────────────────────→  address and key made, written now
                                 ←──────────────────────────────────────  {device, provision}
    Provision ─────────────────────→  stored; answers; restarts as its role
              ←───────────────────── Provision result
  pair.finish {device, result}   ──────────────────────────────────────→  paired, waiting for first contact
                                      first packet, LoRa or Wi-Fi ─────→  contacted: a `device` event
```

Three layers:

1. **Bluetooth Low Energy**, with ESP-IDF's protocomm over BLE, in its own GATT layout: one service, one characteristic per endpoint, a request written and its answer read back ‡. Protocomm stays in ESP-IDF v6; the provisioning manager that used it moved to `network_provisioning` in idf-extra-components, with security versions 0 and 1 off by default (hardware-notes.md, ESP-IDF v6.0 notes). Pairing uses protocomm directly and not the provisioning manager, whose Wi-Fi endpoints it does not need. **Pairing and update use separate services** (D138): this layout for pairing, the updates design's service for transfer (section 7).
2. **Protocomm security 2** ‡: SRP6a (RFC 5054's 3,072-bit group with SHA-512) with the board's pairing code as the password and a fixed user name, then AES-256-GCM on every later request and answer. This is stack.md's choice (†, "confirmed in the Bluetooth spike"). Because it is a password-authenticated exchange, a code of a few characters cannot be worked out from a recorded or intercepted attempt; someone within Bluetooth range, whom D124 still defends against, gets one guess per attempt, and the board stops listening after 5 wrong codes in one window.
3. **The setup messages of §10**: Identify, Identity, Provision, Provision result, byte for byte as over USB, one per request on the endpoint `hsn-setup`. So the board's `SetupService` (FD 4) serves both paths with a rule per path, and the hub makes the Provision message with the code `hsn usb add` uses (HD 9).

**The phone's side of layer 2 is ours**, in TypeScript, in `packages/protocol/src/pairing/`: the SRP6a client over BigInt with `@noble/hashes`' SHA-512, and AES-GCM from `@noble/ciphers`, as M2's Noise is ours over the same libraries. Its vectors are made from ESP-IDF v6.1's own sources (`esp_srp` and protocomm's security 2) with fixed random values, and checked on every build; everything said here of those parameters is from memory until then. **The vectors wait only for ESP-IDF v6.1.1, now being installed on this Mac under `~/esp/esp-idf` (approved)**; making them needs no board. Rejected: Espressif's own provisioning libraries for iOS and Android ‡, wrapped in a module: a reviewed client, but two native code bases in their own Bluetooth stacks beside the one the update transfer needs, nothing of it under `bun test`, and their upkeep unknown ‡. Rejected: Noise XXpsk3 with the code as the pre-shared key, which would reuse our Noise, but a short code in XXpsk3 can be worked out offline by whoever plays the board for one attempt (M2 5), and D120's acceptance of that covers the home network, not the radio range around the house.

### The board: window, code, display, advertising

The firmware's work, listed for its owner in section 10:

- **The pairing window.** Bluetooth is off (PR3) except in a window of 2 minutes (DS7): on an unpaired board at power-up and at any press of the button. A paired board opens no pairing window in a release build: it would refuse Provision anyway, and its Bluetooth opens for an update only on the hub's offer over LoRa (UD 5, D138). An armed sensor's hold is ignored and reported (DS8); a development build opens the window on a paired board too, for PR5's sake. The window closes when a Provision is accepted, after 5 wrong codes, or at its end, and stays open while a session is. The board's LED shows the window (FD's `Blink::pairing`), since the display is not redrawn for it (E12).
- **What the board accepts over Bluetooth.** Identify at any time in a session. Provision only while unpaired, in a release build; at any time in a development build. Never Erase or Set role, which stay USB only (§10).
- **The code** (PR6, D85): made from the chip's random number generator at first boot and at each factory reset, kept in flash, never sent. Eight characters of Crockford base32, `XXXX-XXXX`: seven of secret (35 bits) and a check character, as the linking code makes it (mod 37, M2 5), read with the same forgiveness (case, spaces, dashes, `I` and `L` as `1`, `O` as `0`). With online guesses only and 5 per window, 35 bits is ample. **Provisional until S9** shows a person can type it from the e-paper.
- **The display** (D85; drawn at first boot and at a reset only, E12): the QR code `hsn://pair/1?c=<code without its dash>&d=<chip id, 12 hex>`; the code in large characters; the role in words ("Door sensor", "Siren", "Gateway") with the chip's last four hex digits ("Siren 4F2A"); and one line, "Add it in the app." About 45 characters make a version 3 code, 29 modules, at 5 px a module with its quiet zone on the 200 px panel †. A paired board still shows its code, which then pairs nothing; the app says "The code works until the device is added" where it asks for one.
- **Advertising** while the window is open: protocomm's service UUID, and service data of format 1, the role and the chip id (6 bytes) †; local name `hsn-pair-<4 hex>` †. Nothing secret, and nothing about updates: a board advertises either this service in a pairing window or the update service, with its own name `hsn-<address>`, in an update window, never both (UD 5, D138).

### Phone and hub: two operations (D133)

| Operation | Change | Who | Body | Reply |
| --- | --- | --- | --- | --- |
| `pair.prepare` | yes | MS | `identity`: the board's Identity message (§10) as hex; `name`: the device's name (HD 9's rule: 1 to 64 characters, no spaces) | `{device, provision}`: the device's number, and the Provision setup message to send, base64url. Refused: `invalid {field, reason}` with `pairedElsewhere`, `alreadyOurs`, `noWifi` or `badIdentity`; `busy {because: "provisioning"}` |
| `pair.finish` | yes | MS | `device`; `result`: the board's Provision result message, as hex | The device, paired; or, for "refused" or "not valid", gone |

The hub's rules are `hsn usb add`'s (HD 9), with one addition:

- `pair.prepare` writes the device row (provisioning), its key, its counters (1,024) and settings now, before it replies. A second `pair.prepare` for the same chip while its row is provisioning gets the same address and key, as a USB retry does.
- **A chip the hub holds as reset by its owner** (HD 6's state 3) or left behind by a forced move (state 5) **keeps its row** (number, name, groups, permissions, history) and gets a new key, new counters and a settings version above its last; the body's name replaces the old only if it differs (the reviewer's answer). A removed device (state 4) gets a new row. The same holds for `hsn usb add`.
- The reply is stored with the `seq` (M2 5's last 16 replies), so `client_replies` holds a Provision with a device key, in the database that holds every device key already; it is never in a record: the `commands` row carries the body with the key bytes zeroed, as `usb_sent` does.
- The Provision carries the site's Wi-Fi details (below).
- `pair.finish` with "accepted": paired, waiting for first contact; with "refused" or "not valid": the rows are deleted (HD 9), or a kept row (state 3 or 5) returns to its state.
- A pairing never finished (the phone lost on the way) leaves the row provisioning. A board that accepted makes first contact anyway and becomes contacted (HD 9); otherwise the device list shows "Not finished: add it again, or remove it".
- The hub records a phone's provisioning as it records USB's (`usb_sent`, `provision_*`), with the link named `bluetooth:<client number>`.

Rejected: tunnelling the setup messages through the hub as a link of their own. It would keep one path in the hub's `setup` module, but at a round trip through the hub per message and a new kind of link in the core, for what two operations do.

### Wi-Fi details (PR2, D47)

The Provision carries the site's Wi-Fi name and password (§9): required for sirens, and for gateways not on USB; given to sensors too, for updates over Wi-Fi. The phone never holds them as text: they ride inside the Provision bytes, inside the channel and the Bluetooth session. **`site.wifi` is allowed from any client with *manage system*** (the reviewer's answer; H1), since every Provision already carries the password across the home network inside the channel, and setup on a hub with no screen needs it (D105). When the site has none and the board is a siren or a gateway, `pair.prepare` refuses `noWifi`, and the app says "This siren needs your Wi-Fi details. Set them under This home first." A home Wi-Fi that changes after pairing is covered by nothing (section 13).

### Factory reset (PR4, DS8, D89)

On the board it is the 15 s hold, built in M1a (button action 4, D89). In the app:

- After "Remove this device", the confirmation says "Hold the button under its cover for 15 seconds before you use it again."
- A device reset by its owner shows in the list as "Reset. Add it again, or remove it." with "Add it again", which runs the flow below and keeps its row.
- `pair.prepare` refused `pairedElsewhere`: "This device belongs to another hub. Hold its button for 15 seconds to clear it, then try again."

### The flow on the phone

Devices, "Add a device" (the console keeps "Add over USB"). Each step is a page in AD's form; the screen stays awake from step 3 (expo-keep-awake), and the app must stay in front, which the page says.

| Step | The page | Ends with |
| --- | --- | --- |
| 1 | "Open pairing on the device": "Press the button under its cover. Its code is on the display there." | "Scan its code", or "Type its code" |
| 2 | The camera screen, or the code field | A code |
| 3 | "Looking for the device…": a scan by protocomm's service; for a scanned code, the board with that chip; for a typed one, every board open for pairing: one is taken, several are listed ("Siren 4F2A") | Found; or after 20 s †: "No device is open for pairing nearby. Press its button again and keep the phone close." |
| 4 | "Checking the code…" (SRP) | Right; or "That is not this device's code."; after five: "The device stopped listening after five wrong codes. Press its button again." |
| 5 | Its name, with the role's word filled in | "Add this siren" |
| 6 | "Adding…": `pair.prepare`, Provision, `pair.finish` | |
| 7 | "Waiting for the siren to reach the hub…", up to 60 s † | A `device` event showing it contacted: "Siren added. It is working." No contact: a sensor, "It has not been heard yet. Check that a gateway is near."; a siren or gateway, "It could not reach the hub. Check the Wi-Fi details under This home." |

Bluetooth off, or not allowed, are pages of section 2's rule 7. A sensor added while a mode is current starts disarmed (M2 7), and the last page says so, as the web does.

### The Bluetooth library

**react-native-ble-plx** ‡, stack.md's choice (†): central role, scanning by service, connecting, MTU, reading, writing with and without response, notifications, on both platforms, with its own Expo config plugin ‡. It serves both pairing and update (UD 9 asks for it). It sits behind an interface of ours, so it can be replaced. Wave 0 checks that it builds and loads under React Native 0.88's New Architecture ‡, which is all a simulator can show of it. The alternatives: react-native-ble-manager ‡, of the same shape; or our own Expo module over CoreBluetooth and Android's Bluetooth, kept as the fallback if S9 finds the library broken or slow.

The interfaces, contributed to the joint step 0 (section 10):

```ts
interface BleCentral {
  state(): Promise<"on" | "off" | "unauthorized" | "unsupported">;
  scan(service: string, found: (advert: Advert) => void): () => void; // returns stop
  connect(id: string, wantMtu: number): Promise<Outcome<GattLink, BleFault>>;
}
interface Advert {
  readonly id: string;
  readonly name: string | null;
  readonly serviceData: Uint8Array | null;
  readonly rssi: number;
}
interface GattLink {
  readonly mtu: number;
  write(characteristic: string, data: Uint8Array, response: boolean): Promise<Outcome<void, BleFault>>;
  read(characteristic: string): Promise<Outcome<Uint8Array, BleFault>>;
  watch(characteristic: string, data: (bytes: Uint8Array) => void): () => void;
  onClosed(closed: (fault: BleFault | null) => void): void;
  close(): void;
}
type BleFault = "off" | "unauthorized" | "notFound" | "lost" | "timeout" | "failed";

/** Pairing, layers 2 and 3 over a link: a protocomm security 2 session, then setup messages. */
interface SetupSession {
  exchange(message: Uint8Array): Promise<Outcome<Uint8Array, PairFault>>;
  close(): void;
}
declare function openSetupSession(link: GattLink, code: PairingCode): Promise<Outcome<SetupSession, PairFault>>;
type PairFault = BleFault | "wrongCode" | "tooManyTries" | "protocol";
```

### Building and testing without a real phone

Three stand-ins, each behind `BleCentral`, so everything above it is the code a phone runs:

1. **A scripted board** (`tools/ble-bench/`, Bun): models of the board's two GATT services. For pairing, the board's side of protocomm security 2 (test-only TypeScript, checked against the same ESP-IDF vectors once they exist) and the setup answers of `ScriptedBoard` (`hub/test/unit/setup/support/board.ts`). For update, the device side of UD 5's frames (Hello, Get, Done), pulling from the phone. In process, `bun test` runs a whole pairing and a whole update against the real hub; a board that accepts a pairing joins the bench's air (`app/e2e/support/bench.ts`) as a sensor or siren, so the hub sees it contacted.
2. **A bridge for the simulators.** `tools/ble-bench` serves the same boards on a WebSocket on the Mac. A development build given its address (`EXPO_PUBLIC_HSN_BLE_BENCH`) uses `bridgeBleCentral` instead of ble-plx, and the iOS simulator and the Android emulator go through every pairing and update page against the real hub and scripted boards. A test of the release bundle checks that the bridge is not in it.
3. **A real board without a phone.** Chrome on the Mac has Web Bluetooth ‡. A desk page served on `localhost` by `tools/ble-bench` runs the same TypeScript pairing client through `navigator.bluetooth`, behind `BleCentral`, against a development board running ESP-IDF's protocomm. It proves layers 2 and 3 against ESP-IDF itself, which the vectors only promise, with boards and the Mac alone. It is a tool, never part of the web app (D93 keeps Bluetooth out of it).

None of them shows a phone's Bluetooth stack, its permissions, its background limits or its speed.

### What spike S9 must show on real phones (pairing)

On one iPhone and one Android phone, with a development board running the pairing firmware, before this section is trusted. The transfer half is UD 5's eight measurements, run in the same spike.

1. ble-plx in our development build, under the New Architecture, scans by protocomm's service, connects, and reads and writes its characteristics.
2. A whole pairing with a scanned code and with a typed one, and the stop after five wrong codes; one SRP session's arithmetic in Hermes takes under 2 s † on the slower phone.
3. Three people unfamiliar with the code each type it correctly from the e-paper under the cover at the first try, or the code's length or alphabet changes (the reviewer's condition).
4. The permission prompts behave as section 2's rule 7 says: iOS's Bluetooth question; Android 12 and later's Nearby devices permission for scanning and connecting ‡, and, if a phone older than Android 12 is in scope (section 12), the location permission scanning then needs ‡.
5. A pairing survives the app going to the background for 10 s †, or stops and says so.
6. Each phone's camera reads the e-paper's QR code under the cover at arm's length.

Passed when all six hold on both phones; reported in `docs/spikes/S9-bluetooth.md` with UD 5's numbers. A failure of 1 moves to our own Bluetooth module; a failure of 2's time is taken to the reviewer before anything else is built on it.

## 6. Phone-only features (M5)

| Feature | From the relay design | Can be built now | Waits for |
| --- | --- | --- | --- |
| Several hubs (AP8) | Nothing more: every push names its hub, key ids are per phone and hub (RD 13, F11) | Everything: records per hub (section 2), the Homes page, switching | Nothing |
| Home or relay (RA5, RA8) | The phone path `/v1/phone/<identity>/<session\|link\|restore>`, its close codes and the relay's URL (RD 3) | All of it, against RD 11's local relay on this Mac | The operated relay, for away from home for real |
| Notifications while the app is open (AP6, AP9a) | Nothing | A notification with sound for each notification event; the categories page exists (M2) | Nothing |
| Push, decrypted on the phone (AP6, D32, D126) | `push.register`, `push.unregister`, `push.test` (RD 9); the sealed payload `h` and `PushContent` (RD 5) | The extension and service against RD 5's vectors; S5 on the simulators (RD 5) | AS1 and a Firebase project, for real APNs and FCM |
| Critical alerts (AP9, D92) | `PushContent`'s `n.critical`, in the uniform envelope A; envelope B only if S5 fails (RD 5) | Asking for the permission on the notifications page; raising to critical in the extension and the service | AS3 (Apple's entitlement, after the bundle id); a real iPhone (S10); on Android the phone in hand, for Do Not Disturb ‡ |
| Countdown replaced by its alarm | No collapse identifier on the wire (RD 5, F9) | The phone removes a device's shown countdown when that device's alarm arrives | S5, whether an extension or service can remove a shown notification ‡ |
| The hub-unreachable alert (D96, D127) | Sealed by the hub in advance; looks like every other push (RD 5) | The phone's loudness from its stored armed state | As push |
| Disarm on the lock screen (D51, D63, AL7a) | The relay carrying message 1 with `first` (RD 3) | The action and its handler; S5 on the simulators | S10 on real phones |
| The countdown screen (AP10) | Nothing | Built in M2: the state field's countdown and its Disarm on Home. A tap on a countdown notification opens Home | Nothing |
| Presence offers (AP11, D98) | The offer delivered by push with the action `armAway` or `disarm` (`PushContent.actions`, RD 5); the report reaching the hub from away | The settings page and geofencing with simulated locations ‡ | A hub rule (section 12); a real phone for real geofencing (the Android phone in hand) |
| App lock (AP1a, D63) | Nothing | All of it, with the simulators' simulated face and fingerprint ‡ | A real phone for real biometrics (the Android phone in hand; an iPhone) |
| Screens for relay status, offered updates and the test alert (RD 13, F17) | `relay.status`, `relay.set`, `update.offers`, `update.fetch`, `push.test` (RD 9) | All, P5's, in both builds where RD 9's permissions allow | Nothing. The names screens come with the names work |

### Several hubs

- One record and one key per hub (section 2). One session is open, the chosen home's; the others are reached when chosen, and by push.
- Settings gains one page on the phone, "This phone": its homes, the app lock and presence. Homes lists each with the name the person gives it on this phone (first "Home", then "Home 2"), "Link another home", and "Remove this home from this phone", which sends `push.unregister` and then `client.remove` for itself, and then deletes the record.
- With more than one home, Home names the chosen one in a line above the state sentence, with "Change" leading to Homes. The name never enters the state sentence (AD).
- Whether the name lives on each phone (built now, no hub change) or is a hub setting everyone sees is a question for the product owner. RD 9's `hub.info.name` is the per-hub DNS name, not a home's name.

### Home or relay (RA5, RA8)

- At home, section 2's order; away, the relay, last: `<relay url>/v1/phone/<identity>/<path>` (RD 3), the relay URL from `hub.info.relay`, else the code's `r=`, else `DEPLOYMENT.relay.url` (RD 3). While `DEPLOYMENT`'s domain is the placeholder there is no default relay (RD 2), so a hub with none has no away path.
- The relay's `Connect` (P2's) is React Native's own WebSocket, since the relay has an ordinary certificate (RD 13, F2; `ws://` only in development builds, section 2), and gives the same `Wire` (`wire.ts`), so the channel and Noise do not change. Its closes map to words: 4404 "The hub is not connected to the internet relay."; 1013 and 4429 "The relay is busy. Trying again."; the hub's own closes pass through as at home.
- While on the relay the phone tries home again every 60 s † and whenever the app comes to the front. Which path is in use is shown under This home ("Connected at home", "Connected through the relay"), never on Home.

### Notifications, critical alerts and the lock-screen Disarm

The relay design owns the format and the path; this design builds the phone's side exactly as RD 5 ("On the phone") and RD 13 (F3, F5, F6, F7) require. Its fields are not restated here.

- **Registration.** The phone makes a push key and key id per hub and registers with `push.register` (RD 9) when its token changes, at a new link, when the snapshot's `push` says the hub holds no valid target for it, and with a new key at least every 30 days (RD 5). `push.unregister` when the person removes the home from the phone or turns notifications off for it. "Send a test alert" on the notifications page is `push.test`.
- **Decrypting** `h` into `PushContent` (RD 5): an iOS Notification Service Extension in Swift and an Android messaging service in Kotlin, in `app/modules/push/` with their config plugin, against RD 5's vectors. Text from `n.kind` with the translation files (D58); repeats dropped by hub and `n.seq`; the one button named by `actions` ("Disarm" for `disarm`, "Arm away" for `armAway`).
- **Countdown replaced by its alarm.** There is no collapse identifier on the wire (RD 5, F9): when a device's alarm arrives, the extension or service removes the shown countdown notification of the same hub and device, then shows the alarm ‡ (S5 checks that it can).
- **Loudness, decided on the phone after decrypting: envelope A.** Every push arrives in the same envelope (D126, D127), and the extension or service raises it by itself: critical for `n.critical` (iOS's critical interruption level once AS3 is granted ‡; on Android a channel of the highest importance that passes Do Not Disturb where the person allows it ‡). The hub-unreachable alert is sealed by the hub in advance and arrives like every other push (D127): after decrypting it, the phone makes it critical only if it last saw that home armed (D96). This is the design. If S5 step 2 shows the iOS extension cannot raise a push to critical by itself, RD 5's envelope B applies; this design does not assume it, and under B the phone's only change is not raising on iOS.
- **The stored armed state** per hub, in the shared storage: written from every push's `armed` (RD 5) and, while the app runs, from every `arming` event and snapshot. That answers O15's second half on the phone's side, with RD 16's stated gap.
- **Disarm on the lock screen** is a notification action that runs without unlocking and without opening the app ‡ (D51), and without the app lock (D63). It starts the app's JavaScript in the background ‡, which reads the keys (readable after first unlock), opens a session through whichever path answers first, home or relay, whose message 1 carries `first: disarm {target: "mine"}` with its `seq` (M2 5, RD 13 F7), and posts the outcome as a notification ("Disarmed." or "Could not reach the hub. Open the app to disarm."). S5 step 3 (RD 5) shows whether the JavaScript starts in time with the app closed ‡; if not, the choice between a Disarm that opens the app (one unlock) and a native Disarm (a second Noise in Swift and Kotlin) goes to the product owner.
- **A delayed notification** (`delayed`, D102) says "Delayed: happened at 14:02." `relay_unreachable` (RD 9) is never pushed and shows in the app's notifications only.
- **S5** is run beside the relay design's step 0 by its push owner with this design's P1 (RD 12). Its step 2 decides between envelopes A and B; its step 5 decides whether `@bacons/apple-targets` and `@react-native-firebase/messaging` are needed (RD 10, conditional).

### Presence offers

- Opt-in per person, under This phone. Turning it on explains, asks for location "always" (rule 7), and asks "Set this place as home": the phone's location now, with a radius of 150 m †, kept on the phone only (D59, D98).
- The phone tells the hub only that it left or arrived (`presence.set {away}`, version 2, through the relay when away). The hub's rule, new in M5 (H1, after the product owner's answer): when every opted-in person's phones are away, it offers Away; when a person arrives while armed, it offers Disarm. Each offer is a pushed notification with one action, `armAway` or `disarm` in `PushContent.actions` (RD 5, F16), shown as "Arm away" or "Disarm"; nothing changes without a tap (D25). "Arm away" opens the app on Home and asks there as any arming does, since arming may need a confirmation for an open door or a low battery (D50, AL12); only Disarm runs from the notification without opening the app.
- Geofencing by region monitoring on iOS ‡ and by geofences that need background location on Android ‡, with Google Play's declaration for it ‡, through expo-location and expo-task-manager ‡.

### App lock (AP1a, D63)

- Under This phone, "Lock the app" asks for the face or fingerprint once to turn on (expo-local-authentication ‡). It is not offered on a phone with neither and no passcode.
- The app locks at start and when it returns after more than 1 minute † in the background. The lock page has the title "Locked" and one button, "Unlock", named after what the phone has ("Unlock with Face ID") ‡; the phone's passcode is accepted instead.
- The lock hides everything, the state field included. Notification actions never ask (D63).

## 7. Update over Bluetooth, the app's side (UP6, AP3)

The device side, the frames, the session key, the service and the rules for when a device may update are UD 4 and 5's; the phone uses their interface exactly ("What this gives the phone design", UD 5). **A sensor opens Bluetooth for an update only on the hub's offer over LoRa** (UD 5, D138); there is no button hold for it. The phone serves the image: it answers the sensor's Gets, it never pushes.

### The pages

- **The firmware pages** (both builds; UD 4, "What the app shows" and "App operations and events"): the firmware page (images and versions, own builds marked; upload on the console only), approving a rollout, every device's state with UD 4's distinctions (held: armed, held: battery, needs a phone, waiting its turn, fetching with percent, verified, installing, on trial, confirmed, rolled back, refused with its reason), and pause, resume and cancel. From `rollout.status` and the `deviceUpdate` event. The web build shows "needs a phone" and says to use the phone app (UD 9).
- **On the phone, for a device that needs one**, known from the device object's `update: {state, held, method}` (UD 5): "This sensor is out of Wi-Fi range. Update it with this phone, near it." with "Update with this phone", or the reason it is held in words.

### The flow

1. **Ask the hub.** `firmware.bluetooth {device}` (UD 4, 5). The reply gives the address, image id, version, file size, SHA-256, the session key, the window, `expiresInMs` and `needsWake`. Its refusals in words: `held: armed` "It is armed. Disarm it first."; `held: battery` "Its battery is low. Charge it first."; `held: countdown`, `held: alarm` "Not while a countdown or alarm runs."; `held: siteMove` "Not while the home's radio settings are changing."; `held: keyChange` "It has not been heard since the hub was restored. Wait until it is."; `notPaired`, `onTrial` "It is checking a new version already."; `noImage`, `busy` "Another update of it is under way."
2. **Get the file** if the phone does not hold it: `firmware.download {image}`, streamed as `fileChunk` events (M2 6) into the app's cache by image id, with progress; the header's hash checked against `sha256`. This can be done at home before walking out to the sensor.
3. **Wake the sensor.** When `needsWake` is true the page says: "Open the sensor's cover to start now, or wait up to <its heartbeat interval>. Opening the cover sends everyone a tamper alert; that is expected." The alert stays as it is: it is raised. Otherwise "Get close to the sensor."
4. **Find and connect.** A scan for the update service's UUID, the device named `hsn-` and the `address` from `firmware.bluetooth`'s reply in 8 hex digits (UD 5), not by chip id as in pairing, for the window (`windowS`). Connect asking for an MTU of 517, subscribe to `tx`.
5. **Open.** The sensor notifies Hello; the phone writes Open with the tag `HMAC-SHA256(K, …)` of UD 5, from the session key, the address, the sensor's random and the image id (`@noble/hashes`). A wrong tag closes; five end the window (`sessionRefused`).
6. **Serve.** For each Get, one Data with exactly the bytes asked from the file and their CRC-32, written without response; a Get outside the file is answered Gone `outOfRange`. "Sending the update: 40%, about 30 seconds left", from the highest offset served; "Keep the phone near the sensor" and "Cancel". The screen stays awake.
7. **Done.** The sensor notifies Done: verified, "Sent. It installs when the hub says so.", which may wait for its turn or for a disarm; refused, its reason in words (UD 5's reasons). Then the hub's `deviceUpdate` events: waiting, installing, on trial, rolled back (UP2); and the `device` event naming the new version: "Updated to 1.3.0".
8. **A drop** before Done: the phone reconnects and opens again within the window and until `expiresInMs`; the sensor asks from its checkpoint (UD 5), so the phone needs no offset of its own. After the expiry: "The session ended. Start again."
9. **Afterwards** the session key is forgotten (it was held in memory only, until `expiresInMs`), and the cached file is deleted (UD 9).

### Its interface

```ts
/** `firmware.bluetooth`'s reply, as the phone holds it: in memory only, until `expiresAtMs`. */
interface BluetoothUpdate {
  readonly device: number;
  readonly address: number;          // u32
  readonly imageId: Uint8Array;      // 8 bytes
  readonly version: string;
  readonly fileBytes: number;
  readonly sha256: Uint8Array;
  readonly sessionKey: Uint8Array;   // 32 bytes, never written, logged or shown
  readonly windowS: number;
  readonly expiresAtMs: number;      // now + expiresInMs, on the phone's clock
  readonly needsWake: boolean;
}
/** Serves the file to one sensor over UD 5's service: Hello → Open → (Get → Data)… → Done. */
interface FirmwareServer {
  serve(
    link: GattLink,
    update: BluetoothUpdate,
    file: Uint8Array,
    served: (highestOffset: number) => void,
  ): Promise<Outcome<{ readonly verified: boolean; readonly reason: number }, UpdateFault>>;
}
type UpdateFault = BleFault | "wrongTag" | "windowEnded" | "expired" | "protocol";
```

The 0xF2 frames' codecs, the tag and CRC-32 are the protocol package's (UD 9, step 0); `FirmwareServer` is P4's, over them.

### Tests

The scripted board's update side (section 5) under `bun test`: a whole transfer, Gets repeated and out of order within UD 5's eight outstanding, a CRC the sensor rejects, a drop and a reconnection, a wrong tag five times, the window ending, a Get outside the file. The firmware's own `ScriptPhone` (UD 9, U2) tests the device side against the same frames, so the two ends meet in the frames' vectors. Through the bridge on the simulators by the written checklist. Speed only in S9.

## 8. New dependencies

None is installed; nothing is added until the reviewer approves. Versions for Expo's own packages are those `expo install` picks for SDK 58 ‡.

| Package | Version | For | Native module, so a development build | Without it |
| --- | --- | --- | --- | --- |
| expo-secure-store | not installed | Client keys, records, backup keys | yes | Our own Keychain and Keystore module |
| expo-camera | not installed | Scanning link, restore and pairing codes | yes | react-native-vision-camera ‡ with its code scanner; or typed codes only, which leaves restore impossible (it has no typed code, M2 5) |
| react-native-ble-plx | not installed | Bluetooth: pairing and updates | yes, with its own config plugin ‡ | react-native-ble-manager ‡; our own module |
| expo-font | 58.0.12, in `node_modules` and `bun.lock` through `expo`; made a direct dependency | Loading the bundled faces | yes, in every Expo build | Fonts embedded by a config plugin, two names per face ‡ |
| expo-file-system | 58.0.13, through `expo`; made direct | Caching a firmware image; writing an export | yes, in every Expo build | The image held in memory, lost if the app closes |
| expo-keep-awake | 58.0.4, through `expo`; made direct | The screen on during pairing and transfer | yes, in every Expo build | A screen that may sleep mid-transfer |
| expo-sharing | not installed | Handing a backup export to the share sheet | yes | No export from a phone: "Export it from a computer" |
| expo-crypto | not installed; only if wave 0 finds no `crypto.getRandomValues` | Random numbers for keys | yes | react-native-get-random-values ‡ |
| expo-notifications | not installed (RD 10: only 56.0.16 in a local cache, for an older Expo) | Notifications while open (M3); push permission and token, categories, the Disarm action (M5) | yes | Our own native modules |
| expo-task-manager | not installed | Background notification actions and geofence events (M5) | yes | Our own native handling |
| expo-local-authentication | not installed | App lock (M5) | yes | Our own module |
| expo-location | not installed | Geofencing (M5) | yes | Our own region-monitoring module |
| `hub-net`, ours (`app/modules/hub-net/`) | new | mDNS browse; the hub socket unless wave 0's check makes it unneeded | yes | react-native-zeroconf ‡ for the browse |
| `push`, ours (`app/modules/push/`, M5) | new | The extension and service that open `h` (RD 5) | yes | None (D32) |

Conditional on S5 (RD 10, not counted above): `@bacons/apple-targets` ‡ to add the extension target, or our own config plugin; `@react-native-firebase/messaging` ‡ if `expo-notifications` cannot hand data messages to our code with the app killed, or our own Kotlin service.

Used as they are, already direct: expo-linking 58.0.17 (deep links), expo-status-bar 58.0.5, react-native-safe-area-context 5.11.1, expo-system-ui 58.0.7, `toqr` 0.1.1; and `@noble/curves`, `@noble/hashes`, `@noble/ciphers` 2.4.0 through `@hsn/protocol`. Not proposed: expo-dev-client, react-native-svg (the QR code is drawn with Views), a network-change listener (the phone retries on reconnect and on coming to the front), expo-device. Maestro, a tool to drive the simulators, is not proposed now (section 12, for the product owner).

## 9. Test strategy

**Waves 1 and 2 are proven by `bun test` and by the scripted bridge**, with a short written checklist for the simulators (the reviewer's answer).

**Under `bun test`, on every build, with no simulator:**

- Protocol package: the pairing code and board QR reading; SRP6a and security 2 against vectors made from ESP-IDF v6.1.1's sources (being installed on this Mac under `~/esp/esp-idf`); the setup session's framing; this design's parts of channel version 2.
- App logic: the native record store over an in-memory secure store (`seq` written before sending, the backup key written with the record, `backup.keyHeld` only after the write, everything deleted on removal); the order of addresses against a fake `hub-net`; linking `kind: "phone"` against the real hub, with the backup key; the restore client against the real hub (`app/test/support/real-hub.ts`); the pairing flow against the scripted board and the real hub; the update server against the scripted board's update side (section 7); the relay `Connect` against RD 11's local relay and the real hub (with the relay design's B7).
- Hub: H1's `pair.prepare` and `pair.finish` in the core's scenario tests (HD 11's `World`), the kept row of a reset device, and crash tests (a prepare committed and its reply lost, retried with the same `seq`, gets the same key); `site.wifi` from a phone; the mDNS record's new keys. A8's `backup.key` and `backup.keyHeld` (section 4).
- Lint: no web global outside `*.web.ts(x)`; the release bundle holds no bridge.

**On the simulator and the emulator, by the written checklist** (`app/e2e-native/checklist.md`, about one page; each line a step and what must be seen). A Bun harness (`app/e2e-native/harness.ts`) starts a real hub on a temporary data folder at the Mac's home-network address, the board bench and `tools/ble-bench`, and prints the link code as a deep link to open with `xcrun simctl openurl` or `adb shell am start` ‡. The checklist, run on both simulators, and on the Android phone the product owner has, before each wave is called done: link by deep link and by typed code; every route; Home, Away, a scripted door's countdown, Disarm; add a scripted siren and sensor over the bridge; update a scripted sensor over the bridge; remove and link again; restore onto a second hub process; the permission pages (camera, Bluetooth, local network, notifications) with each answer. What a simulator gives only by injection: the camera on iOS, which the simulator lacks ‡ (deep links); Bluetooth (the bridge); push (`xcrun simctl push` ‡, RD 5's stand-in for the emulator); location (`xcrun simctl location` ‡, `adb emu geo fix` ‡); a face or fingerprint (the Simulator's menu ‡, `adb emu finger touch` ‡); the lock screen (the Simulator's lock ‡). The Android emulator's camera can show a picture in its virtual scene ‡, so a QR code can really be scanned there. By hand before release: VoiceOver and TalkBack (M2 8).

**Continuous integration:** both development builds compiled on a hosted macOS runner when `app/` changes (section 12 asks about cost); the simulators are not driven there (Maestro is not being installed).

**Playwright, unchanged:** every web test of M2 keeps running on the web export, including `done-when.e2e.ts`. The shared screens the platform split touches, and the new shared pages (relay status, offered updates, firmware, rollout), are covered there for the web.

**The Android phone in hand** shows now, before boards or an iPhone: a release-like development build on a device with no account; the camera scanning a QR code; Android's local network and Nearby devices permissions on its own Android version; keys read with the phone locked; real biometrics for the app lock; real FCM once a Firebase project exists; and, when boards arrive, the Android half of S9.

**Only an iPhone shows:** iOS's local network question, which the simulator does not ask ‡; the camera on iOS; critical alerts through silent mode and Disarm from a locked iPhone (S10); Face ID; the iPhone half of S9. **Only real phones of both kinds** show real geofencing, push through Apple's and Google's services to a device, and background and battery limits.

## 10. The order of work

The coordinator writes the joint order of work for the three designs. This section gives this design's part of it.

### What this design contributes to the joint step 0

1. `app/app.config.ts` reading `@hsn/deployment` (RD 2; the package itself is the relay design's step 0 item), the scheme `hsn` from `LINKING`, cleartext `ws://` for development builds only with the release check that refuses it (section 2); `ios/` and `android/` ignored by git; the permission strings.
2. The platform interfaces, types only: `StoredClient`'s key type, `HubRecords`, `BackupKeys`, the phone's `Connect` options, `HubFinder`, `Scanner`, `BleCentral`, `GattLink`, `SetupSession`, `BluetoothUpdate`, `FirmwareServer`, `hub/start.ts`.
3. This design's part of channel version 2 (section 3): `hub.info`'s `addresses` and `appsPort`; `pair.prepare`, `pair.finish`; `backup.key`'s new rule, `backup.keyHeld`, the snapshot's `backupKeyEpoch`; `site.wifi`'s permission; `presence.set`.
4. `packages/protocol/src/pairing/`, types and constants: `hsn://pair/1`, the pairing code's format and reader, protocomm's endpoint names, the pairing advertising format, the vector files' formats.
5. protocol.md: the two mDNS keys in §10 and a section "Pairing over Bluetooth" (section 12), agreed with the firmware owner.
6. The lint rule for web globals.

### Wave 0: the build stands up (now, simulators)

The development builds build and start on an iOS 27 simulator and the API 37 emulator; the engine checks of section 2; every route renders with NativeWind 5; ble-plx builds and loads; the one-day check of React Native's WebSocket against the hub's certificate (section 2), which decides `hub-net`'s size; a first session with the real hub on the Mac; the same build installed on the Android phone in hand. Reported in `docs/spikes/P0-phone-build.md`. Needs from the owner only the approval of the installs and of the first builds' downloads (section 11). Beside it, S5's phone side with the relay design's push owner (RD 12).

### Owners

Each owner changes only the folders named; a frozen interface changes only through the step 0 owner.

| Owner | Folders | Steps |
| --- | --- | --- |
| P1 | `app/modules/hub-net/`, `app/modules/push/` | 1. Browse, and the socket if wave 0 needs it, in Swift and Kotlin. 2. (M5, with S5) the push extension and service, against RD 5's vectors |
| P2 | `app/src/platform/*.native.ts`, `app/src/hub/start.native.ts`, `app/src/hub/finder.ts`, `app/src/hub/restore.ts`, `app/src/hub/relay.ts`, `app/src/hub/push.ts`, `app/plugins/` | 1. Key vault and records. 2. Address order, deep links, typed codes with discovery. 3. Backup keys and the restore client. 4. Config plugins: purpose strings, Android permissions, backup exclusion, development-only cleartext and its release check. 5. The relay `Connect` and push registration (RD 13, F18) |
| P3 | `packages/protocol/src/pairing/`, `packages/protocol/vectors/pairing-*.json` | 1. Code and board QR. 2. SRP6a and security 2, with vectors from ESP-IDF v6.1.1's sources: **waits only for the installation under way** (`~/esp/esp-idf`, approved); no board needed. 3. The setup session over a `GattLink` |
| P4 | `app/src/pairing/`, `app/src/ble-update/` (their pages included) | 1. `BleCentral` on ble-plx. 2. The pairing flow. 3. The update flow and `FirmwareServer`, on UD's frame codecs |
| P5 | `app/src/app/`, `app/src/ui/`, `app/locales/en/` | 1. The platform split of the shared UI (QR, file input, export, notifications, the root), fonts. 2. Safe areas, status bar, back, text size, announcements. 3. The camera and permission pages. 4. The phone's link and restore pages. 5. The firmware and rollout pages (UD 4). 6. The relay status, offered updates and test alert pages (RD 13, F17). 7. (M5) This phone, Homes, app lock, notifications. The names pages come with the names work |
| P6 | `tools/ble-bench/`, `app/e2e-native/` | 1. Scripted Bluetooth boards, pairing and update, in process. 2. The bridge. 3. The harness and the checklist. 4. The Chrome desk page |
| H1 (hub) | `hub/src/core/setup/`, `hub/src/core/registry/`, the new operations in `hub/src/core/app/`, `hub/src/shell/advertise/`; presence's rule in M5 | 1. The mDNS keys. 2. `hub.info`'s fields. 3. `pair.prepare`, `pair.finish`, the kept row of a reset device, with scenario and crash tests. 4. `site.wifi` from a phone. 5. (M5) Presence |
| A8 (M2's owner of `hub/src/core/upkeep/`) | `hub/src/core/upkeep/`, with the owner of `hub/src/core/people/` for `backup-epoch.ts` | The `backup.key` fix: the new rule, `backup.keyHeld`, the snapshot's `backupKeyEpoch`, the tests (section 4) |
| F1 (firmware) | The ESP-IDF platform's Bluetooth link for pairing and the display; the setup service's Bluetooth rule in the core | After M1b's platform layer: protocomm over NimBLE with security 2, the window, the code, the display and its content; beside UD's NimBLE update link (UD 9, step 3) |

What could collide: the shared UI is P5's alone, and P4 keeps its pages in its own folders, which P5's routes import; `@hsn/protocol`'s and `@hsn/deployment`'s frozen files are the step 0 owner's; M2's A7 owned all of `app/`, which P1, P2, P4 and P5 now share by folder; `hub/src/core/upkeep/` stays A8's, who makes the `backup.key` fix.

### Waves

| Wave | Who | Done when |
| --- | --- | --- |
| 1 (now, simulators and the Android phone) | P1.1; P2.1–2.4; P3.1; P5.1–5.5; H1.1–1.2, H1.4; A8's fix; P6.1 | Under `bun test` and by the checklist on both simulators and the Android phone, a phone links to the real hub by deep link and by typed code, keeps its key across restarts, keeps its backup key through a replacement, runs every shared screen, is removed and links again, and restores a hub onto a second hub process |
| 2 (pairing and update, no phone) | P3.3; P4.1–4.3; H1.3; P6.2–6.3 | Through the bridge, on both simulators, a scripted siren and sensor are added, reach the hub and work, and a scripted sensor is updated; the same under `bun test`; wrong codes and the five-try stop |
| 2a (ESP-IDF on the Mac, no board) | P3.2, once ESP-IDF v6.1.1 is installed | The pairing vectors made from ESP-IDF's sources pass under `bun test`; the scripted board's side checked against them |
| 2b (boards, when they arrive) | F1; P6.4 | The desk page adds a development board with the e-paper module |
| 3 (real phones, with boards) | S9: the Android half with the phone in hand; the iPhone half when one is bought (pairing here, transfer in UD 5) | Section 5's six points and UD 5's eight measurements, on both |
| M5, now | P5.7 (homes, app lock, notifications); S5 with the relay design | Two hubs on the Mac switched between; the lock, on the Android phone too; a sealed push from RD 5's vectors decrypted on the simulator |
| M5, with the relay design's waves | P1.2; P2.5; P5.6; H1.5 | The relay design's local "done when" (RD 11, `bun run m4`) with the real phone build in the simulators and on the Android phone, through a local relay over `ws://` (section 2); then S10 |

### What this takes from the relay design

All decided there; listed so the reviewer can see each is used as written.

1. **The configuration point** (RD 2, D128): `packages/deployment/src/deployment.ts`; this design's `app.config.ts` reads it. The scheme `hsn` is not in it.
2. **The phone path through the relay** (RD 3, "Phones"): React Native's own WebSocket to `<relay url>/v1/phone/<identity>/<session | link | restore>`, the same Noise messages one for one, no authentication of the phone at the relay, its close codes, the relay URL's order (`hub.info.relay`, `r=`, the default). Typed codes work only at home. `ws://` to a local relay in development builds only (F2).
3. **Push keys and registration** (RD 5, D126): `push.register`, `push.unregister`, `push.test` (RD 9), the phone making the key and key id, the times it registers again.
4. **The payload** (RD 5): `h` and `PushContent`, one padded size; text from `n.kind`; `actions` (`disarm`, `armAway`); `armed`.
5. **Envelopes** (RD 5): the uniform envelope A, the extension raising a push to critical by itself, is the design; envelope B is RD 5's named fallback if S5 fails, not assumed here.
6. **The relay's own alerts** (RD 5, D127): sealed by the hub in advance, alike on the wire; the phone decides loudness after decrypting, from its stored armed state.
7. **No collapse identifier** (RD 5, F9): the phone removes a device's countdown when its alarm arrives.
8. **What the phone needs from Apple and Google** (RD 5): the extension's duties, the Android service's, the steps AS1 to AS7 and the Firebase project.
9. **S5** beside the relay design's step 0, with this design's P1; its step 2 decides between the envelopes, its step 5 the conditional packages (RD 10).
10. **Channel version 2's other parts** (RD 9): `hub.info`'s `relay`, the snapshot's `push`, `relay.*`, `update.offers`, `update.fetch`, and their screens (RD 13, F17). `names.*`, `hub.info`'s `name` and `n=` come later, with the names work.

### What this takes from the updates design

1. **When a sensor opens Bluetooth for an update**: only on the hub's offer over LoRa (UD 5, D138); `needsWake` when it learns of it at its next reply.
2. **The operations and events** (UD 4): `firmware.bluetooth {device}` with its reply and refusals (`held: keyChange` among them), `firmware.download {image}`, `firmware.list`, `rollout.*`, the device object's `update: {state, held, method}`, the `deviceUpdate` event, and the states the app must tell apart.
3. **The session** (UD 5): the session key from the hub, in memory only until `expiresInMs`; the tag; five wrong tags end the window.
4. **The service and frames** (UD 5): the service UUID and the `rx` and `tx` characteristics, the name `hsn-<address>`, MTU 517 asked, 0xF2 frames one per write or notification, the pull order Hello, Open, (Get, Data)…, Done; the phone answers Gets and sends nothing unasked.
5. **The file**: header and image, exactly the bytes the device pulls; deleted after the session (UD 9).
6. **Pairing's own service**: separate from the update service (D138); a board advertises one or the other, never both.
7. **S9's transfer half** (UD 5, eight measurements: the device-driven pull with 4, 8 and 16 Gets outstanding among them) in the same spike as section 5's pairing half.
8. **The tamper alert** a cover opened for an update raises: kept, and the app says beforehand that it will come.
9. **The key change after a restore** (UD 7, D141): devices "Not heard since the restore" until heard; Bluetooth updates held meanwhile.
10. **UD 10's seven changes to this design**, each made: no update window on a paired board's hold (section 5); no update state in pairing's advertising (section 5); "wait for the sensor, or open its cover" by `needsWake` (section 7, step 3); finding by `hsn-<address>` (step 4); "Sent. It installs when the hub says so." (step 7); S9's transfer measured as UD 5 lists (section 5 points there); the operations of both designs in the one version 2 (section 3).

## 11. Readiness

What the product owner has, as of 2026-11-18: an Android phone; no iPhone; the development boards have not arrived; ESP-IDF v6.1.1 being installed on this Mac under `~/esp/esp-idf` (approved); no product name, bundle identifier or domain; Maestro not being installed.

| Piece | Today | Provable now, on this Mac and the Android phone | Waits for |
| --- | --- | --- | --- |
| The hub's side of linking phones, the backup key in `LinkResult`, `backupKeyChanged` | Built and proven (M2, scripted phones) | | |
| `backup.key` as fixed (section 4) | Built with M2's fault | Yes | A8's change |
| The hub's side of restore | Built and proven (M2, scripted phone) | | |
| Noise, the backup codec, the channel client's logic | Built and proven in pure JavaScript (M2) | Runs unchanged on the phone after wave 0's checks | |
| The shared screens on a phone | Not built: the platform split is wave 1 | Yes, both simulators | NativeWind 5 on native (wave 0) |
| Keys in secure storage | Not built | Yes, and read with the Android phone locked | An iPhone, to see a locked iPhone read them |
| Reaching the hub: certificate, `Origin`, mDNS | Not built; the mDNS keys not on the hub | Yes, at the Mac's address, and on the Android phone on the home Wi-Fi with its own permissions | An iPhone for iOS's local network question; Android 17's permission if the phone in hand runs an older Android |
| Linking by deep link and typed code | Not built | Yes | |
| Linking by camera | Not built | The Android phone's camera; the emulator's virtual scene ‡ | An iPhone (no simulator camera ‡) |
| Restore from a phone | Not built | Yes, two hub processes on the Mac | Two real computers, in M2's step 3 manner |
| The pairing exchange (SRP, protocomm, setup messages) | Not built | Against the scripted board; the vectors once **ESP-IDF v6.1.1's installation** finishes | **The boards** (with the e-paper module and the pairing firmware) for the desk page; then S9: the Android half with the phone in hand, the iPhone half with **an iPhone** |
| The code on the e-paper | Not built | No | **The boards**; the e-paper module on the order list; M1b's platform layer; S9 for typability |
| `pair.prepare`, `pair.finish` | Not built | Yes | |
| Update over Bluetooth, app side | Not built | Against the scripted board and the bridge | UD's hub and firmware parts; **the boards**; S9's speed on the Android phone, then **an iPhone** |
| Notifications while open; the countdown screen | Countdown built (M2) | Yes | |
| Several hubs; app lock | Not built | Yes; real fingerprint or face on the Android phone | **An iPhone** for Face ID |
| Push decrypted on the phone | Not built | On the simulator by `xcrun simctl push` ‡ (S5); the Android service by RD 5's stand-in | **AS1** and **a Firebase project** (owner) for real APNs and FCM; the bundle id first (RD QP1) |
| Critical alerts | Not built | No | **The bundle id** (RD QP1), **AS1**, **AS3** (Apple's grant); **an iPhone** (S10); on Android the phone in hand, once FCM works |
| Disarm on the lock screen | Not built | S5 on the simulators; the Android phone locked, through the local relay | **An iPhone** (S10) |
| Home or relay | Not built | Against RD 11's local relay over `ws://`, from the simulators and the Android phone | The operated relay, which needs **the domain** (RD 14) |
| Presence | Not built | Simulated locations ‡; real geofencing on the Android phone | The product owner's rule; push (above); **an iPhone** |
| A build on a real iPhone | | | **AS7**: the owner signs Xcode into the account; **an iPhone** |
| A build on the Android phone | | Yes, now: no account needed ‡; USB debugging turned on in the phone's developer options ‡ | |

### What the first runs download, and from where

To tell the product owner once. Nothing of the owner's is sent; each is a download the build tools make.

| First run of | Downloads | From |
| --- | --- | --- |
| `bun install`, after the reviewer approves section 8 | The approved packages | The npm registry, Bun's default ‡ |
| `bunx expo prebuild` | Expo's project template for SDK 58, `expo-template-bare-minimum` (read in `@expo/cli`'s `prebuild/resolveTemplate.js`) | The npm registry |
| `bunx expo run:ios` (its `pod install`) | The CocoaPods spec index ‡; React Native 0.88.1's prebuilt iOS core, its dependencies and Hermes, as `react-native-artifacts` and `hermes` tarballs (read in React Native's `scripts/cocoapods/rncore.rb`, `rndependencies.rb` and `sdks/hermes-engine/hermes-utils.rb`); the sources of the other pods | The spec index from CocoaPods' CDN ‡; React Native's artifacts from Maven Central (`repo1.maven.org/maven2`) or React Native's mirror (`repo.reactnative.dev/maven2`), as read; other pods mostly from GitHub ‡ |
| `bunx expo run:android` (its first Gradle build) | The Gradle distribution named by the generated wrapper ‡; the Android Gradle plugin 9.2.1 and AndroidX libraries ‡; React Native's Android artifacts and other libraries ‡; **build-tools 37.0.0** (React Native asks for it; 35 and 36 are installed) | Gradle's distribution site ‡; Google's Maven repository ‡; Maven Central ‡; Google's SDK repository, installed by the Gradle plugin because the SDK's `licenses` folder is present ‡ |
| ESP-IDF, being installed now (approved), under `~/esp/esp-idf`; P3.2's vectors and the firmware need it | ESP-IDF v6.1.1 and its toolchain | Espressif ‡ |

Not a download, but part of the first build: **a development build allows cleartext `ws://` to a private or loopback address**, so the simulators and the Android phone can reach a relay run on this Mac (RD 11, F2). iOS: `NSAllowsLocalNetworking`, which every build declares for the hub ‡; Android: cleartext traffic turned on by our config plugin in development builds only. A release build refuses it three ways: the plugin does not apply it when `HSN_RELEASE` is set; the release check fails the build if the generated Android manifest allows cleartext; and the app's relay `Connect` refuses `ws://` when `__DEV__` is false (section 2).

## 12. Decided, and still open

### Decided

| Question | Decided | Rejected |
| --- | --- | --- |
| How the phone app is built | Development builds by Expo's local tools on this Mac | Expo Go (cannot load our modules); Expo's paid build service |
| Names and identifiers | `@hsn/deployment` (RD 2), read by `app.config.ts` | A file of the app's own |
| The URL scheme | `hsn`, fixed: `hsn://link/1`, `hsn://restore/1`, `hsn://pair/1`; never follows the product's name | A scheme in the configuration (boards draw `pair/1` codes in firmware) |
| Cleartext to a local relay | Development builds only, refused three ways in a release build | Allowing it in every build; no local relay testing on phones |
| Critical marking | Envelope A: the extension or service raises a push by itself; RD 5's envelope B only if S5 fails | Assuming B |
| Countdown replaced by its alarm | The phone removes the device's shown countdown when its alarm arrives | A collapse identifier on the wire (readable by Apple) |
| A presence offer's "Arm away" | Opens the app, which asks as any arming does | Arming from the notification (may need a confirmation) |
| Where the phone keeps keys | expo-secure-store, readable after first unlock, this device only | Readable only when unlocked (no lock-screen Disarm); kept in phone backups (contradicts D61's way of replacing a phone) |
| TLS to the hub at home (D132) | Carriage only: the hub's certificate accepted for home-network addresses; Noise proves the hub | Pinning the code's fingerprint; a plain `ws://` path |
| The hub socket and browse | `hub-net`; the socket part only if React Native's own WebSocket cannot be made to do it (wave 0) | react-native-zeroconf for the browse |
| Finding the hub at home | Last address, then the hub's own list, then mDNS with `app` and `aid` keys | Per-hub names (for browsers, RD 7) |
| `backup.key` | Any phone may ask; the epoch recorded only on `backup.keyHeld`; the current epoch in the snapshot; A8's | M2's rule, which can strand a phone |
| Old backup keys on a phone | Up to 16 epochs kept | Only the newest |
| Pairing's security (D133) | ESP-IDF protocomm security 2 (SRP6a), our TypeScript client, vectors from ESP-IDF's sources | Espressif's native libraries; Noise XXpsk3 with a short code |
| What travels in the pairing session | §10's setup messages, unchanged | A new message set for Bluetooth |
| Phone and hub during pairing (D133) | `pair.prepare` and `pair.finish` | Tunnelling setup messages through the hub as a link |
| Adding again a reset device | Keeps its row, with a new key | A new row |
| `site.wifi` | *Manage system*, from any client | Console only |
| The pairing code | 8 characters with a check character, 35 bits, 5 tries a 2-minute window; provisional until S9 | |
| Pairing and update services | Separate (D138) | One service |
| Update over Bluetooth | Opened by the hub's offer over LoRa; the phone serves Gets (UD 5) | A button hold |
| The Bluetooth library | react-native-ble-plx behind `BleCentral` | react-native-ble-manager; our own module (the fallback) |
| Testing without a phone | `bun test` with a scripted board, a bridge for the simulators, a written checklist, a Chrome desk page for real boards | Maestro (not being installed) |
| Channel version 2 | One, joint, frozen once; names' parts outside the first freeze | A version per design |
| Sessions across several homes | One open at a time | One per home |
| A code from another app | Shown and confirmed before linking | Linking at once |
| The QR code on a phone | Drawn with Views from `toqr`'s modules | react-native-svg |
| Fonts | Loaded at start by expo-font, the same names as the web | Embedded by config plugin |
| Navigation | Expo Router's `Slot` as on the web, with an Android back rule | A native stack on the phone only |

### Still open for the reviewer

Nothing: the scheme and the owner of `backup.key`'s fix are settled (`hsn`; A8).

### Questions for the product owner

1. **The bundle identifier and application id** (RD QP1): choose them now, so AS1 and AS3 can start; the critical-alert request is the longest wait.
2. **An iPhone, and the oldest systems to support.** The Android phone in hand covers S9's Android half; the iPhone half, Face ID, iOS's local network question and S10 need an iPhone (UD P8 recommends buying now). Which Android version the phone in hand runs decides whether Android 17's local network permission can be tried on it. Supporting Android below 12 means the location permission for Bluetooth scanning ‡; React Native allows down to Android 7 (API 24) and iOS 15.1.
3. **Approving the installs** of section 8 and the first runs' downloads (section 11).
4. **Presence when only some people opt in**: offer Away only when everyone in the household has opted in, or when every opted-in person has left?
5. **A home's name**: kept on each phone, or a hub setting everyone sees?
6. **Tablets**: in scope (the layout supports them)?
7. **If S5 shows the lock-screen Disarm cannot run in the background in time**: a Disarm that opens the app (one unlock), or a second implementation of the channel in Swift and Kotlin?
8. **A home Wi-Fi that changes after pairing**: is adding sirens and gateways again acceptable, or should a later milestone carry Wi-Fi details over the air?
9. **Keys not carried by a phone's backup** (this device only): a new phone is linked again. Confirm.
10. **Continuous integration on macOS runners**: free for a public repository ‡, metered otherwise ‡. Compile the phone builds there, or only on this Mac?
11. Two pieces of hardening beyond the architecture, not designed in (D124):
    - **Hide the app in the phone's app switcher.** Defends against someone seeing a link code or a restore page in the switcher or a screen recording. Costs a few lines per platform; the switcher shows a plain page.
    - **Ask for the face or fingerprint before showing a link code**, even with the app lock off. Defends against someone using an unlocked phone to link a device of their own. Costs one step each time a code is made.

### Proposed text for other documents (not edited here)

- **app-design.md**, a section "On a phone" after "Layout", holding section 2's eleven rules as written there, and in "Principles" rule 2: "A filled surface is used for four things only: the state field, notices, form inputs, and the camera's view."
- **protocol.md §10**, "Finding the hub": "…as `_hsn-hub._tcp`, with the TXT keys `id` (the hub identity of §9, 16 hex digits), `app` (the apps' port, decimal) and `aid` (the app identity, 26 characters of base32, m2-design.md section 5). Apps use `app` and `aid` only to choose where to try; the channel's handshake proves the hub."
- **protocol.md**, a new section "Pairing over Bluetooth", replacing the open point of §14 and the note at the top: the window and what opens it (unpaired boards only, in release builds); the advertising format; ESP-IDF protocomm over BLE in its own GATT layout, with security 2, the pairing code as the password and a fixed user name; the endpoints `proto-ver`, `prov-session`, `hsn-setup`; §10's Identify and Provision over `hsn-setup`, with the Bluetooth rule (release builds: Provision only while unpaired; never Erase or Set role); the 5-try stop; the code's format and the display's QR text `hsn://pair/1?c=…&d=…`. Exact values once wave 2b has pinned ESP-IDF's. Separate from the update service of the updates design.
- **stack.md**, "App": Tests: "`bun test` for the app's logic and screens, Playwright for the web build, a written checklist on the simulators (m3-design.md)", replacing "Expo's Jest setup"; Builds: "Development builds made locally with Expo's tools; no build service"; Keys and lock: add "readable after first unlock, this device only"; a row "Home-network connection on the phone: by address, TLS as carriage (D132); mDNS browse in `hub-net`, our Expo module"; Bluetooth: "react-native-ble-plx in a development build, behind `BleCentral` † (S9), for pairing and updates". "Pairing exchange" (Firmware): "ESP-IDF's protocomm with security 2 (SRP), the pairing code as the password, used directly, not through `network_provisioning` (hardware-notes.md); the phone's SRP client is ours, checked against vectors from ESP-IDF's sources (D133)."
- **build-plan.md**, "Needed later": the Apple row becomes "The paid Apple account exists. The bundle identifier, then AS1 and the request for the critical-alert entitlement (m4-design.md section 5), which takes time to be granted"; M3's title: "built on simulators first; real phones for S9".
- **architecture.md**, decisions: "D132. The phone reaches the hub on the home network by address and treats TLS there as carriage; the Noise session, with the hub's key pinned at linking, proves the hub. It never needs the per-hub name. Reason: the phone loads no code from the hub, and a pinned certificate would change with every new address or renewal." "D133. Pairing over Bluetooth runs ESP-IDF's protocomm with security 2 (SRP), the code on the e-paper as the password, and carries §10's setup messages; the hub provisions through the phone with `pair.prepare` and `pair.finish`. Reason: a short code needs a password-authenticated exchange against anyone in radio range (D124), and the board's setup code and the hub's provisioning serve USB and Bluetooth alike." O15's second half: "answered on the phone by storing the last armed state per hub (m3-design.md section 6; m4-design.md section 5)".

## 13. Gaps, contradictions and risks

### In other documents and the code

| Where | Gap or contradiction | Reading taken |
| --- | --- | --- |
| M2 5 ("the mDNS record gains an `app=8444` text field"), `hub/src/shell/advertise/mdns.ts` | Not built: the record has only `id`, the device-signing identity, on the device port; §10 names no key (the code's own SPEC-QUESTION) | Keys `app` and `aid` (section 2), H1 |
| M2 6 (`site.wifi` "MS (C ‡)") against D105 and AP0 | Setup "can also be done in the phone app", but the Wi-Fi details could not be set from it | Settled: *manage system* from any client (section 5) |
| `hub/src/core/upkeep/ops.ts`, `backup.key` | A fault: a phone that loses the reply can never fetch the key again | Settled: section 4's fix, A8 |
| stack.md, "Tests: Expo's Jest setup for the app" | The app's tests run under `bun test` (`app/test/`) | Proposed text above |
| stack.md, "Pairing exchange" | Names ESP-IDF's provisioning layer, which v6.0 moved out (UD 12; hardware-notes.md) | Protocomm directly (section 5) |
| M2 8's folder table (`qr.web.ts`, `qr.native.ts`, `keys.native.ts` in `platform/`) | The QR code is in `ui/qr.tsx` as raw SVG; `file-input.tsx`, `backup.tsx` and `notifications.tsx` use the DOM inside the shared `ui/`; `_layout.tsx` imports the browser client; `StoredClient` holds a `CryptoKey`. Right for M2's web build; the phone build cannot bundle until they are split | Wave 1, P5 and P2 |
| DS7 against UD 5 (D138) | DS7 says a 5 s press opens pairing; a paired release board must not open Bluetooth on a press | A paired release board opens nothing on the hold (section 5); DS7's text should say "on an unpaired board" |
| HD 9 | Said nothing of a chip the hub holds as reset | Settled: the row is kept (section 5) |
| HD 6's `usb_sent` | Named for USB; a phone's provisioning needs a link label | `bluetooth:<client>` (section 5) |
| build-plan.md, "Needed later" | The Apple account is listed as needed for M4; it exists now, and what waits is the bundle identifier | Proposed text above |
| E12 against DS7 | The display is drawn only at first boot and reset, so it cannot show the pairing window | The LED shows it |
| PR2, D47 | Wi-Fi details reach a device only at pairing: a new router means adding every siren and gateway again | Question 8 for the product owner |
| D63, stack.md ("expo-secure-store") | Nothing says the keys must be readable while the phone is locked, which D51's lock-screen Disarm needs; the library's default is not ‡ | After first unlock (section 2) |

### Where the sibling designs still do not fit this one

| Where | What does not fit | Proposed |
| --- | --- | --- |
| UD 5 refusals | `firmware.bluetooth`'s refusals (`held {…, keyChange}`, `notPaired`, `onTrial`, `noImage`, `busy`) are named in UD's reply but not yet placed in M2's `invalid`/`busy` error scheme | The joint step 0 owner places them in `errors.ts` |
| UD 5 ("pairing's `hsn-<4 hex>` name") | This design's pairing advertisement names itself `hsn-pair-<4 hex>` †, so it cannot be mistaken for an update window's `hsn-<8 hex>`; the phone filters by service UUID either way | UD's parenthesis follows this name; nothing else changes |
| RD 5 (S5's step 3) and section 6 | A presence offer's "Arm away" opens the app here, so only Disarm runs from a notification without opening it; RD 5 describes the background action for Disarm only, so it fits, but `actions: ["armAway"]` is then a button that opens the app | Noted; no change to RD |

### Risks

| Risk | What settles it |
| --- | --- |
| NativeWind 5.0.0-rc.1 is proven on the web only | Wave 0 renders every route on both simulators; a failure goes to the product owner |
| react-native-ble-plx under React Native 0.88's New Architecture ‡ | Wave 0 builds and loads it; S9 uses it; our own module is the fallback |
| Our SRP client is our own cryptography | ESP-IDF's vectors on every build; the Chrome desk page against ESP-IDF itself; a review by someone outside the project only if the product owner asks (D124, RD QS1) |
| Everything said here of protocomm security 2 is from memory ‡ | Wave 2b pins it from ESP-IDF v6.1's sources before P3.2 builds; waits for ESP-IDF's installation |
| SRP's 3,072-bit arithmetic in Hermes may be slow ‡ | Timed on the simulator in wave 2, on phones in S9 |
| The lock-screen Disarm needs the app's JavaScript to start in the background with the app closed ‡ | S5 on the simulators, S10 on phones; question 7 for the product owner |
| Apple may refuse the critical-alert entitlement, or take long ‡ | Asked as soon as the bundle id exists; Time Sensitive meanwhile (RD 5) |
| iOS's local network question cannot be asked or read ‡ | The explanation page before the first connection; `localNetworkDenied`; tried on a real iPhone |
| Android 17's local network permission once the target moves to API 37 | Declared and asked from the start |
| No iPhone yet and no boards yet, so S9 comes late | The Android phone in hand takes wave 1, the Android half of S9 when boards arrive, and much of S10 on Android; waves 1 and 2, the vectors and the Chrome desk page leave S9 only what a phone alone can show |
| One e-paper module on the order list | A second one, or the board's own panel in M6 |
| Accepting the hub's certificate without a check | Only for home-network addresses and `.local` names; a test that a public address is refused; never for the relay |
| Without a tool driving the simulators (Maestro is not being installed), a regression on a phone is found only when the checklist is run | Run before each wave is called done, on the simulators and the Android phone; `bun test` carries the logic |

### What this design is least sure of

- ESP-IDF's protocomm security 2 and its GATT layout as remembered; the exchange's shape stands, its details wait for ESP-IDF's sources.
- That react-native-ble-plx works under this React Native, and fast enough for firmware (S9).
- That NativeWind 5's release candidate renders the app on a phone as it does on the web.
- That the lock-screen Disarm can run JavaScript in the background in time (S5, S10).
