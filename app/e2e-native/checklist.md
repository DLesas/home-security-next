# Pairing and firmware updates on a simulator

Use an unsigned development build and a separate Metro port. Select the simulator in T3 Code and use its bound agent-device command for app actions and screenshots. The fixture runs a real hub with temporary data and listens for the Bluetooth bridge on loopback. The fixture never prints a board's code: with the code field focused, `type <role>` types that board's code and `wrong <role>` types a wrong code of valid format, through the bound device command and without printing either.

- `holdoff <role>` holds back that board's first contact with the hub after it is paired, until `release <role>`, so the page waiting for it can be left and come back to.
- `dropearly` drops the update's connection just after the board's first Hello reaches the phone, before the board accepts Open (`drop` drops after Data frame 30).
- `slow <ms>` delays each crossing by that many milliseconds each way (`slow` alone: 20), to watch the transfer's progress or cancel it while it is sending.
- No command ends a pairing window early: the scripted board has no public way to, so wait its two minutes with no phone connected. As on a real board, no scripted board's pairing window is open until its button is held: `hold <role>` holds it for 5 seconds, `hold <role> 15000` resets it.

## Start

1. In one terminal, set `HSN_P4_DEVICE` to the bound agent-device command and run `bun app/e2e-native/pairing-run.ts`. Its default bridge port is 8787. Keep this terminal open for fixture commands.
2. Start Metro for the installed development build with `EXPO_PUBLIC_HSN_BLE_BENCH=ws://127.0.0.1:8787`, `CI=1`, `EXPO_NO_TELEMETRY=1` and `EXPO_OFFLINE=1`. For the earlier build and install workflow, see [P0 phone build](../../docs/spikes/P0-phone-build.md). The placeholder iOS build may stop at secure storage without a signed app entitlement. Record that separately from any run using a temporary storage fixture.
3. Open the app from the device panel. Enter `link` in the fixture, accept the link and allow the local network. The fixture opens the link without printing it.

## Pair

| Action                                                                                  | Observe                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter `hold siren`, then open Devices → Add a device → Siren.                           | The instruction says to hold the button under the cover for about 5 seconds until the light shows. The code stays on the display. `hold siren` is that 5-second hold: without it no board is found.                 |
| Find the device, allow Bluetooth if asked, and select the siren if several are listed.  | The app shows the role and firmware from the board before offering to scan or type its code.                                                                                                                        |
| Focus the code field, enter `type siren`, and check it. Name the siren and add it.      | The code check and the name page appear. The app waits for contact. The fixture authenticates to the hub as the scripted siren. The app shows “Siren added” and the device appears in Devices.                      |
| Enter `hold sensor`, then `qr sensor` from outside the pairing flow.                    | Opens the pairing route and finds the sensor by the QR's chip ID. Check its code and add it. Its first sensor packet goes through the fixture gateway to the hub.                                                   |
| On the camera page, check the explanation or the device's permission state.             | The iOS simulator shows “No camera”. On a phone with a camera, permission is explained before Apple's or Android's prompt, and the view has a quiet typing alternative.                                             |
| On an unpaired board, type a valid-format wrong code five times.                        | The first four refusals say how many tries are left. The fifth says to hold the button for about 5 seconds until the light shows. Enter `hold <role>`, tap “The light is showing”, and use the same displayed code. |
| With every matching board off or after two minutes without a connection, find a device. | No device is found. The page gives the hold instruction and says to keep the phone close.                                                                                                                           |
| During a check, enter `off <role>`. Use `on <role>` and `hold <role>` to try again.     | The app describes what happened and gives a recovery.                                                                                                                                                               |

## Update

1. Pair the sensor and wait for “Door sensor added”. Enter `plan`. The fixture stores a signed own-build image and reports that its sensor cannot use Wi-Fi through the gateway.
2. Open the sensor's details. Under Firmware update, choose “Update with this phone”. Allow Bluetooth if asked. Watch the signed image download, then read the wake instruction and its tamper warning.
3. Enter `slow` to make the transfer progress visible. Enter `wake` so the sensor asks the hub over the fixture gateway. Choose “Find the sensor”. The fixture receives the hub's genuine Bluetooth offer and the app serves the file through the bridge.
4. Observe “Sent” after the board verifies the file. The fixture then models the sensor's successful trial restart so the real hub can publish “Updated to 1.4.0” for the first plan. Each later `plan` offers a new version to the paired sensor.
5. On a fresh update, enter `drop` before `wake` to drop the connection after Data frame 30. Choose “Carry on” within 30 seconds. On another run, cancel while sending and check that the connection closes. `normal` removes the fixture's transport faults.

Use the Bun suites for frame loss and repetition, corruption, MTU and deadline boundaries and hub refusal cases. The bridge cannot establish real Bluetooth, camera use or transfer speed. Release check:

```sh
bun app/e2e-native/release-check.ts /tmp/hsn-release
```

For Android, use `Medium_Phone_API_37.0` and set `ANDROID_HOME` to `$HOME/Library/Android/sdk` if it is unset. Forward the installed app’s Metro port with `adb reverse tcp:8081 tcp:<Metro port>` and the bridge with `adb reverse tcp:<bridge port> tcp:<bridge port>`. The run script sets these forwards. Pass `--clear` to the run script when you want to clear the Metro cache.

The two platforms can run side by side on different bridge and Metro ports on the same Mac. For example, use bridge **8878** and Metro **8081** on iPhone, and bridge **8879** and Metro **8082** on Android. Set `HSN_P4_BRIDGE_PORT` for both the fixture and the run script in each session, and use the matching bridge URL when starting Metro by hand. Android’s forwards for this example are `adb reverse tcp:8081 tcp:8082` and `adb reverse tcp:8879 tcp:8879`.

Older standalone Safari smoke runs are bench diagnostics. The phone fixture above uses the real handshake.

Enter `quit` to stop its bridge, gateway and hub and remove its temporary data. Stop the Metro process you started.
