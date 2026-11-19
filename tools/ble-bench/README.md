# tools/ble-bench: scripted Bluetooth boards

Simulators have no Bluetooth and no boards are on the desk, so the phone's pairing and update code talks to scripted boards here (m3-design.md section 5, "Building and testing without a real phone"). Three ways in, each behind the frozen `BleCentral` (`app/src/platform/ble.ts`):

| Way | For | Entry |
| --- | --- | --- |
| In process | `bun test` of the app's pairing and update code (P4) | `BleAir`, `ScriptedCentral`, `ScriptedBoard` from `@hsn/ble-bench` |
| The bridge | the app in the iOS simulator or the Android emulator | `src/bridge/main.ts`, and `bridgeBleCentral` (`@hsn/ble-bench/client`) in a development build |
| The desk page | a real board, from Chrome on this Mac | `http://127.0.0.1:8787/desk` |

The two browser pages (`pages/`: the simulators' smoke run and the desk page) have a TypeScript project of their own (`pages/tsconfig.json`, with the DOM's types), kept out of the root project so the DOM's `WebSocket` does not replace Bun's there; check it with `tsc -p tools/ble-bench/pages/tsconfig.json`.

## In a test

```ts
const clock = new ManualClock();            // or realClock
const air = new BleAir(clock);
const board = placeBoard(air, new ScriptedBoard(clock, { role: Role.Siren, chipId }));
const phone = new ScriptedCentral(air, { maxMtu: 185 });   // an iPhone-like phone
air.faults = { latencyMs: 15, dropAfter: nthFrame(TransferKind.Data, 30) };
await clock.advance(120_000);               // a pairing window's end, at once
```

- **Boards.** `ScriptedBoard` is a sensor, a siren or a gateway: the pairing window and its advertising (protocomm's service UUID, no service data, the name `hsn-pair-<4 hex>`), protocomm's endpoints and framing as ESP-IDF's NimBLE transport handles them, the code and its five tries, the setup messages with Bluetooth's rule, the Wi-Fi details kept as bytes, the result and the restart (`events.provisioned`); and once paired, `offerUpdate` (the hub's action 3) opens the update service, whose device side is the firmware's own (`boards/update-service.ts`, checked frame for frame against the firmware's host bench). `board.statuses` is what it would send over LoRa.
- **Security.** A scripted board runs protocomm security 2 by default (`boards/security2-server.ts`: SRP6a's server and AES-256-GCM with security2.c's counter), so the app's real `setupSessionOpener` pairs with it. `standInSecurity` is a **test stand-in, not security 2** (the code in the clear), kept for the older transport and setup tests with `openStandInSession` as its phone end; a board must be made with `security: standInSecurity` to use it. `unjoinedSecurity` refuses everything.
- **Faults.** `Faults` on the air or per board: latency, a slow board, a drop after any crossing, lost, repeated and corrupted writes and notifications, refused connects; on the central, Bluetooth's state and MTU limit and Android's or iOS's scan reports; on the board, `powerOff` (it vanishes), `storageFails`, `restartBeforeResult`, a second `ScriptedCentral` for a second phone.
- `ScriptPhone` is the bench's own phone for an update (the firmware's `ScriptPhone` in TypeScript), not the app's `FirmwareServer`.

## The bridge, for the simulators

`bun tools/ble-bench/src/bridge/main.ts [--port 8787] [--smoke]` serves the boards, with security 2, on `ws://127.0.0.1:8787` only (the iOS simulator shares the Mac's loopback; the Android emulator reaches it with `adb reverse tcp:8787 tcp:8787`). It prints one JSON line per event and takes commands on standard input (`src/bench.ts`). `app/e2e-native/` has the harness, the run scripts and the checklist.

**Choosing it in the app (P4's selector).** Only like this, so a release bundle never collects it (`test/release.test.ts` enforces the form; `app/e2e-native/release-check.ts` searches the release bundles):

```ts
let central: BleCentral = blePlxCentral();
if (__DEV__ && process.env.EXPO_PUBLIC_HSN_BLE_BENCH !== undefined) {
  const { bridgeBleCentral } = require("../../../tools/ble-bench/src/bridge/client.ts");
  central = bridgeBleCentral(process.env.EXPO_PUBLIC_HSN_BLE_BENCH);
}
```

The client refuses by itself where `__DEV__` is false, and any address not on this Mac.

## Comparing with the firmware

`test/fixtures/firmware-transcripts.json` is what the firmware's real `UpdateService` (with the sensor role, on its host bench, served by its `ScriptPhone`) sent in five scenarios. To make it again, from the repository's root, with the firmware's dependencies already fetched by a `host-debug` build (nothing is downloaded):

```sh
D=$PWD/firmware/build/host-debug/_deps B=<a scratch folder>
cmake -S tools/ble-bench/firmware-transcript -B $B -G Ninja -DCMAKE_BUILD_TYPE=Release -DHSN_SANITIZE=OFF \
  -DFETCHCONTENT_FULLY_DISCONNECTED=ON -DFETCHCONTENT_SOURCE_DIR_TFPSACRYPTO=$D/tfpsacrypto-src \
  -DFETCHCONTENT_SOURCE_DIR_DOCTEST=$D/doctest-src -DFETCHCONTENT_SOURCE_DIR_NLOHMANN_JSON=$D/nlohmann_json-src
cmake --build $B --target ble_bench_transcript
$B/ble_bench_transcript > tools/ble-bench/test/fixtures/firmware-transcripts.json
node_modules/.bin/prettier --write tools/ble-bench/test/fixtures/firmware-transcripts.json
```

Remake it whenever `firmware/core/src/device/update*.cpp` changes; `test/firmware-compare.test.ts` then shows any frame the two no longer agree on.

## The desk page

`http://127.0.0.1:8787/desk` in Chrome: type the board's code, choose the board, and it reads `proto-ver`, opens Security 2 using the protocol package's `setupSessionOpener` through `pages/desk-security.ts`, sends Identify and, if pasted, a Provision from the hub. With no board, or no Web Bluetooth, it says so and sends nothing.
