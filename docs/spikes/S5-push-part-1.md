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

## 3. Closed-app Disarm and countdown replacement on iOS

**Cannot be decided on this simulator delivery path.** A newly linked test phone armed sensor 2 in a real hub process through a real loopback relay. An independent observer saw it armed. After the door opened at 09:58:56.384, the local push service reached its stand-in with the countdown in 8 ms and the alarm 7,998 ms after the countdown. The opened payloads both contained `actions: ["disarm"]`. The simulator accepted the original APS bodies. SpringBoard retained both placeholders at 09:58:56.561 and 09:59:04.528. No extension assigned a category, no countdown was removed, and there were zero phone action or IK reply samples. The 8 ms is the path to the stand-in. There is no iOS Disarm latency or observed OS budget. App-assisted removal of a delivered notification also needs a running app with access to an identifiable countdown. The occupied UI session precluded a separate app-side observation.

The harness now uses the same phone to arm the door and later request Disarm for “mine”. Its control is private files in a new run directory. It writes the spike credentials directly to the app group, logs only fixture states, forwards exactly the stand-in body and closes its processes. In a fresh shell, prepare the variables from step 1. Use Set up once the scene is ready to load its fixture into the shared keychain. Close the app via its device session before triggering the door.

```sh
bun "$SPIKE/harness/safe/scene.ts" ios "$IOS" "$OUT/ios-scene" >"$OUT/ios.log" &
SCENE=$!
# After ready exists and the app has been set up and closed:
touch "$OUT/ios-scene/door"
# Allow the eight-second countdown to finish for the replacement trial.
cat "$OUT/ios.log"
python3 "$SPIKE/harness/delivered.py" "$IOS"
touch "$OUT/ios-scene/finish"
wait "$SCENE"
```

For a delivery path that dispatches the extension, repeat in a fresh scene and tap Disarm before expiry. Compare the native action's tapMs and backgroundTimeRemaining, JS reply's disarmed array, outcome posting time and independent hub.arming event. Expo 58's NotificationCenterManager calls completionHandler immediately after dispatch to delegates. The spike includes a background task and a windowless React start for this case. Neither path executed in this iOS run.

## 4. Android with the app swiped away

**Passes for local data delivery on API 37.** In each of two fresh scenes I opened the bundled app, allowed notifications, displayed Recents and swiped its card away. Recents then showed Settings and the previous card. The spike had no PID immediately after dismissal. The stand-in sent only the sealed data field into Android's service resolver. The OS-created HsnMessagingService received it in a new process. Airplane mode was on, Wi-Fi was off, and the WebSocket used an adb reverse to the loopback relay.

The notification shade showed “Countdown: front” with Disarm. I tapped the actual action. Both runs started JS in the background and both IK replies reported sensor 2 disarmed. A separately linked observer saw that sensor go from armed to disarmed. The shade showed “Disarmed.” The device tool reported `press label="Disarm" left invalid.hsn.app.s5spike and foregrounded com.google.android.apps.nexuslauncher`; the screenshot, native action timestamp, reply and observer confirmed the background action. No second tap was needed in either run.

| Milliseconds from native action receipt, phone clock | DND on | DND off, fresh scene |
| --- | ---: | ---: |
| JS Disarm starts | 2,050 | 1,280 |
| WebSocket open | 2,338 | 1,588 |
| Hub message 2 | 2,342 | 1,596 |
| Companion sent | 2,374 | 1,629 |
| Successful reply to first | **2,420** | **1,678** |
| Outcome posted | **2,425** | **1,689** |

NotificationManager's action PendingIntent showed a **+30s0ms temporary allowlist**. React Native's task timeout was independently configured to 30,000 ms. Both outcomes landed inside those windows. The observed allowlist is specific to this emulator. We did not measure the OS killing an overrun or the interval from finger contact to receiver dispatch. In the first run the tap arrived near countdown expiry and the alarm appeared before the hub replied. In the second run the hub disarmed during the countdown.

**Replacement.** In run 1 the countdown was shown for hub/device 2. The alarm handler found one matching delivered countdown. The OS changed from countdown ID 100002 to alarm ID 200002, and the shade showed “Alarm: front”. The published test pair for device 7 independently replaced ID 100007 with 200007. Its one-bit corrupt control journaled decryptFailed and posted nothing.

**Do Not Disturb.** The alarm channel had importance 4 (HIGH), category alarm and alarm audio usage. At setup its persisted canBypassDnd was false despite the app asking for true. The priority filter was 2. With alarms permitted in the mode, the countdown's record had mIntercept=false and the shade marked it Alerted. The ordinary notification had mIntercept=true. With alarms disabled and no channel exception, both alarm records settled at mIntercept=true while remaining posted. Enabling only “Alarms and countdowns” under the mode's allowed apps changed both to false at the same importance. These are OS interception decisions. Acoustic output was not measured. The channel exception, alarms filter, DND and connectivity were restored to their original settings. [Android's channel API](https://developer.android.com/reference/android/app/NotificationChannel#setBypassDnd(boolean))

### Repeat

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk" JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ADB="$ANDROID_HOME/platform-tools/adb"
cd "$SPIKE/app"
node node_modules/expo/bin/cli prebuild --clean --platform android --no-install
(cd android && ./gradlew --no-daemon --max-workers=4 :app:assembleRelease -PreactNativeArchitectures=arm64-v8a)
# Use the serial reported by device_open for Medium_Phone_API_37.0.
ANDROID=emulator-5554
"$ADB" -s "$ANDROID" install -r android/app/build/outputs/apk/release/app-release.apk
cd "$ROOT"
```

Use the command returned by device_open to open the app, allow notifications, open app-switcher, and swipe its centered card up. Confirm it is gone. Use the same command for settings, including airplane on and Wi-Fi off. The bundled release configuration enables run-as specifically for this fixture. The app's private provision file travels over stdin. Capture only new phone journal rows per trial.

```sh
N=$("$ADB" -s "$ANDROID" shell run-as "$APP" cat files/app.jsonl | wc -l)
bun "$SPIKE/harness/safe/scene.ts" android "$ANDROID" "$OUT/android-scene" >"$OUT/android.log" &
SCENE=$!
# Once $OUT/android-scene/ready exists, pull down the notification shade and trigger the door.
touch "$OUT/android-scene/door"
# Tap Disarm on the countdown, or let the alarm replace it and tap its Disarm.
"$ADB" -s "$ANDROID" shell dumpsys notification --package "$APP" | \
  rg 'NotificationRecord\(|"Disarm" ->|mIntercept='
"$ADB" -s "$ANDROID" shell run-as "$APP" cat files/app.jsonl | tail -n +$((N+1)) >"$OUT/phone.jsonl"
python3 "$SPIKE/harness/check-disarm.py" "$OUT/phone.jsonl" "$OUT/android.log"
touch "$OUT/android-scene/finish"
wait "$SCENE"
```

For the DND controls use Settings → Modes → Do Not Disturb. Toggle Alarms under “Alarms & other interruptions”, then the single channel under Apps → Selected apps (gear) → Add apps → HSN S5. Repeat the dumpsys inspection after ranking settles. The following delivers the published countdown, refusal control and alarm without an active scene or any token. Set up in the app once to store the public vector key.

```sh
for f in v0 changed-byte v1; do
  "$ADB" -s "$ANDROID" shell am broadcast --receiver-foreground \
    -n "$APP/expo.modules.hsnpush.StandInFcmReceiver" -a invalid.hsn.s5.FCM \
    --es h "$(jq -r .h "$OUT/vectors/$f.apns")"
done
"$ADB" -s "$ANDROID" shell run-as "$APP" cat files/app.jsonl | tail -10
```
