# S5 part 1 — receiving a sealed push on the phone

Run on 2026-11-22 with local delivery only. The question in M4 §5 and M3 §6 is whether the phone can translate a sealed alert, choose its loudness and act on Disarm before the OS suspends it. The test account, identifier and app group use the deployment placeholders.

## Takeover inventory

| Inherited part | Purpose and disposition |
| --- | --- |
| `app/package.json`, `bun.lock`, `metro.config.js` | SDK 58 standalone app and Metro access to the repository protocol implementation (steps 1–5). |
| `App.js`, `index.js`, `src/random.js` | Category, permission and test-key setup, Expo registration, Android headless entry and Hermes random source (1–4). Removed the deep link that ran the extension class in the foreground. |
| `extension/NotificationService.swift`, `Info.plist`, `push-words.json` | Keychain lookup, CryptoKit opening, English text, level, category and matching countdown removal in the extension (1–3). Removed the remote sleep and allocation controls. |
| `app.config.js`, `plugins/with-hsn-push.js` | Placeholder identifiers, extension target, shared app group, localized resources and Android assets (1–5). Removed the second copy of the extension compiled into the app. |
| `modules/hsn-push/{index.js,package.json,expo-module.config.json}`, iOS podspec, `HsnPushModule.swift`, `HsnPushAppDelegateSubscriber.swift` | Expo discovery, test-only provisioning, native action delegate, background start, timing and delivered notifications (1–3, 5). |
| `src/background.js`, `src/disarm.js` | Action-to-JavaScript bridge and the real protocol's IK initiator carrying Disarm in message 1 (3–4). |
| Android Gradle file, manifest, `Push.kt`, `HsnPushModule.kt` | Native library, opener, channels, posting, cancellation, provisioning and OS inspection (4–5). |
| `HsnMessagingService.kt`, `StandInFcmReceiver.kt`, `DisarmActionReceiver.kt`, `DisarmTaskService.kt` | Message entry, local injection, action receiver and headless task (4–5). The inherited injector called a helper directly and could accept arbitrary provisioning. |
| `harness/vectors.ts`, `scene.ts` | Published vectors for local pushes (1–2), real hub/relay and loopback push stand-ins for action tests (3–4). Rebuilt the corrupt vector by flipping one ciphertext bit. |
| Generated `app/ios/`, installed packages and scratch logs | The inherited prebuild finished, CocoaPods reported 103 installed pods, and the earlier Release simulator build succeeded. Later prebuild output stopped at pod installation. The scene had reached an eight-second countdown and a refused **harness** Disarm. Its PID was gone. These are setup history. Generated projects, pods, packages and derived data are ignored. |

## 1. Does local delivery invoke the extension?

The iPhone 18 Pro ran iOS 27.0. The app group's earlier setup journal recorded a successful test-key write (status 0). Both an unmodified published countdown and its one-bit corruption reached SpringBoard. The OS delivery archive recorded “Open the app to see this alert.” for both at 09:56:13.138 and 09:56:13.251 UTC on the inherited installation. Neither produced an extension journal entry. The good vector should have named Front door. The persisted delivery record supplies the body independently of the extension. No tap or screenshot was possible: the bound device command returned `DEVICE_IN_USE` for another session, including after a 2,000 ms wait.

**Fails with simctl push.** Seeing the placeholder for the corrupt control alone cannot establish authenticated rejection. This simulator injection path did not dispatch the notification service extension. Apple also distinguishes service-extension support in remote delivery from local simulation. [Xcode release notes](https://developer.apple.com/documentation/Xcode-Release-Notes/xcode-14-release-notes)

### Repeat from the repository root

Use a checkout with the repository's normal locked dependencies available (including the protocol workspace's Noble and Zod packages). The standalone app has its own lockfile. The two generated native project directories belong to this spike. All commands below use the same shell.

```sh
ROOT=$PWD
SPIKE=$ROOT/spikes/s5-push
OUT=$(mktemp -d)
IOS=E0B22DB7-C3A1-4BA2-A3A8-0FA9DFF30AC4
APP=invalid.hsn.app.s5spike
export CI=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 COCOAPODS_DISABLE_STATS=true
cd "$SPIKE/app"
bun install --frozen-lockfile
node node_modules/expo/bin/cli prebuild --clean --platform ios --no-install
(cd ios && pod install)
xcodebuild -workspace ios/HSNS5.xcworkspace -scheme HSNS5 -configuration Release \
  -sdk iphonesimulator -destination "id=$IOS" -derivedDataPath "$OUT/dd" -jobs 4 build
xcrun simctl install "$IOS" "$OUT/dd/Build/Products/Release-iphonesimulator/HSNS5.app"
cd "$ROOT"
bun "$SPIKE/harness/vectors.ts" "$OUT/vectors"
bun test "$SPIKE/harness/vectors.test.ts"
```

With an available T3 session, open this app using the command returned by device_open for local and the iPhone ID. Allow notifications and finish Set up. The phone should report testKey 0. Leave the app. On the preconfigured simulator the authorization survived installation.

```sh
GROUP=$(xcrun simctl get_app_container "$IOS" "$APP" group.invalid.hsn.app.s5spike)
xcrun simctl push "$IOS" "$APP" "$OUT/vectors/v0.apns"
xcrun simctl push "$IOS" "$APP" "$OUT/vectors/changed-byte.apns"
python3 "$SPIKE/harness/delivered.py" "$IOS"
ls -l "$GROUP"/*.jsonl
```

The last two fields of the iOS 27 archive reader are interruption level and critical sound. Read the latest dated rows after SpringBoard persists them. The file format is specific to this simulator runtime.

A clean native prebuild, pod install and simulator build then succeeded with the standalone extension and bundled JS. The embedded executable was 303,824 bytes and both JSON resources were present. After reinstalling this build and repeating the pair, the two new OS records at 09:57:27.365 and .475 again held the placeholder, level 1, critical sound false. Only the app journal existed. Four injections across two builds, zero extension starts.

## 2. Can the extension choose loudness?

**Cannot be decided with local simulator delivery.** The built app's simulated entitlements included time-sensitive and omitted critical-alerts. Four pushes in one installation produced these OS delivery records. The extension's first instruction never journaled a start.

| Requested in | Requested level | UTC | Stored level | Stored critical sound |
| --- | --- | --- | ---: | --- |
| Extension only, uniform APS | Time Sensitive | 09:57:41.693 | 1 (active) | false |
| Extension only, uniform APS | Critical | 09:57:41.806 | 1 | false |
| Outer APS | Time Sensitive | 09:57:41.918 | 2 | false |
| Outer APS | Critical with critical sound | 09:57:42.026 | 3 | true |

The archive records the requested outer critical payload even without AS3. It does not measure audible interruption, entitlement enforcement on a signed device, or a rejection from an extension. There was no system answer to an extension-originated request because it never ran. The app's separate authorization button required the blocked device session. Envelope A versus B remains open. Use real delivery to an AS3-entitled client and compare the same decrypted alert with uniform and critical outer APS, including sound under silent mode.

```sh
for level in timeSensitive critical; do
  xcrun simctl push "$IOS" "$APP" "$OUT/vectors/$level.apns"
done
for level in time-sensitive critical; do
  jq --arg l "$level" '.aps["interruption-level"]=$l |
    if $l=="critical" then .aps.sound={"critical":1,"name":"default","volume":1} else . end' \
    "$OUT/vectors/v0.apns" | xcrun simctl push "$IOS" "$APP" -
done
python3 "$SPIKE/harness/delivered.py" "$IOS"
plutil -p "$SPIKE/app/ios/HSNS5/HSNS5.entitlements"
```
