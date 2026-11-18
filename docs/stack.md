# Technology choices

Agreed 2026-11-12. Decision numbers refer to [architecture.md](architecture.md).

Rows marked † wait on a spike in [build-plan.md](build-plan.md). Library capabilities and version details are from memory and are confirmed when each piece is first set up; versions are pinned then.

## Whole repo

| Area | Choice | Why |
| --- | --- | --- |
| Layout | One repo with Bun workspaces: `firmware/`, `hub/`, `relay/`, `app/`, `packages/protocol/`, `hardware/` | The protocol is defined once and every part builds against it. |
| Language | TypeScript in strict mode with no `any`, for everything except firmware | One language for hub, relay and apps (D17). |
| Shared protocol package | `packages/protocol`: the LoRa packet codec, the app-to-hub messages as Zod schemas, the app encryption, and test vectors as JSON files | Hub, relay, apps and the command-line tool cannot drift apart. The C++ tests read the same vector files. |
| Validation | Zod 4 | Already used across the old repo. |
| Tests | Bun's own test runner for the hub, relay and protocol package; for the app, `bun test` for its logic and screens, Playwright for the web build, and a written checklist on the simulators ([m3-design.md](m3-design.md)) | Nothing extra to install; the app's tests already run under `bun test` (`app/test/`). |
| Format and lint | Prettier and ESLint | As in the old repo, and Expo's defaults. |
| Continuous integration | GitHub Actions | Hosted macOS, Windows and Linux machines build and test the installers for systems not on the desk. |

## Firmware

| Area | Choice | Why |
| --- | --- | --- |
| Core | Portable C++17, no heap, hardware behind interfaces | D3. Carried over from the old Zephyr core (about 3,600 lines). |
| Platform | ESP-IDF v6.1, pinned | D4. Espressif's own framework: deep sleep, Wi-Fi, Bluetooth and updates are all first-party. v6.1 is the current stable line; it runs the chip's AES hardware without heap use and can wake from deep sleep on a level per pin, which the door, button and cover inputs need ([hardware notes](hardware-notes.md)). |
| Host tests | doctest with CMake and CTest | The old tests use Zephyr's test framework, which leaves with Zephyr. doctest is one header with no dependencies. |
| LoRa driver | RadioLib or Semtech's own `sx126x_driver`, behind the core's radio interface † | To decide before the boards arrive. The research favours Semtech's driver: one function per radio command, no heap, and direct access to the channel-detection and receive-window settings the protocol depends on. RadioLib 8 changed its interface days ago, allocates per transfer unless told not to, and has a blocking scan with no timeout ([hardware notes](hardware-notes.md), section 4). |
| Device encryption | The PSA Crypto interface of the Mbed TLS that ships with ESP-IDF v6: AES-128-CCM with an 8-byte tag for packets, ECDSA P-256 to check firmware signatures. Behind a small interface in the platform layer | No extra library, it uses the chip's AES hardware, and the same Mbed TLS version builds on the Mac for host tests. v6 made PSA the public interface; the older `mbedtls_ccm_*` calls are private there ([hardware notes](hardware-notes.md)). |
| Bluetooth | NimBLE | The smaller of ESP-IDF's two Bluetooth stacks; only Bluetooth Low Energy is needed. |
| Pairing exchange | ESP-IDF's protocomm with security 2 (SRP), the pairing code as the password, used directly, not through `network_provisioning` ([hardware-notes.md](hardware-notes.md)); the phone's SRP client is ours, checked against vectors from ESP-IDF's sources (D133) | A reviewed way to turn a short typed code into a safe channel. Confirmed in the Bluetooth spike. |
| Updates | ESP-IDF's two-slot update with rollback, plus our own signature check against the hub's key | UP1–UP3. Secure Boot is not used: it fixes one publisher key, which D35 rules out (D143). |
| Storage | ESP-IDF's key-value flash store for keys and settings; sleep-retained memory for state between wakes | Wear-levelled and already there. |
| Link to the hub off LoRa | One kept-open WebSocket over Wi-Fi, using Espressif's WebSocket client, or USB serial with a small framing layer; both carry the same packets (D101) | One packet format on every path. The hub serves devices on one port and apps on a second, with HTTPS, so the installer opens two firewall rules (D101 as amended). The packets are already encrypted, so the WebSocket itself needs no TLS. |
| Finding the hub | mDNS | GW8; the old backend already advertises with it. |
| Display | A small driver for the chosen panel's controller, and a no-heap C QR code library | D85. |

LoRaWAN is not used: it needs a multi-channel gateway and a network server, and this system has one simple radio per gateway and its own hub.

## Hub

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Bun | D94, from spike S1: about a third of Node's memory at rest and a smaller install, with every native add-on loading. |
| Web server | Hono, with plain WebSockets for live updates | Small, and it also runs on Node, which keeps D94's way back open. Socket.IO's own protocol adds nothing once every message travels inside our encryption. |
| Errors | `neverthrow` result types in the hub and relay. Our own code does not throw: anything from a library that can throw is wrapped where it is called, a lint rule requires every result to be used, and one top-level handler records whatever still escapes † | D110: no error is lost. Already used in the old backend, and readable by anyone who knows TypeScript. Effect was considered and set aside: it would enforce more, at the cost of a style few contributors know. The lint rule's support for the current ESLint is checked when the hub starts. The protocol package keeps its own small result type and stays dependency-free. |
| QR codes on the hub's console | `toqr` 0.1.1, pinned | A tiny encoder with no dependencies of its own, for the codes the hub prints (linking, restore). It only draws what the hub already holds; it sees no key the code does not carry. |
| Hub core | The alarm logic is a deterministic core like the firmware's: events and the current time go in, the new state and a list of decisions come out, and timers are data, not callbacks | Tests run days of hub time in milliseconds with an injected clock, with no framework. Every decision is a returned value, so recording it with its cause (D110) needs no extra plumbing. |
| Database | SQLite through Drizzle ORM and drizzle-kit migrations, on Bun's built-in SQLite | D15. Drizzle is already used in the old repo, and the built-in driver means no native add-on to rebuild. |
| Database writes | Grouped commits. State that must survive a power cut is written through at once: sending counters' resume points, alarm, countdown and armed state, pairing data, every door, cover, button and started report, and every warning or worse. Routine records, device readings and the replay windows of routine packets are committed together every five minutes. Write-ahead logging, compact rows and few indexes | D112, HB35. A Raspberry Pi's memory card is slow to commit and wears with writing, and a hub that committed every packet separately would do both badly. |
| App interface | Named request, reply and event messages defined with Zod in `packages/protocol`, carried over a WebSocket | The same messages work directly on the home network and through the relay, always inside the encrypted channel, so every request is authenticated by a device key (D61). |
| Device packets | Bun's built-in crypto for ECDSA and the AES block cipher; AES-CCM is our own short implementation on top of that block cipher | Bun has no AES-CCM. The implementation matched Node's built-in on 300 cases and the published test case (S1), and is checked against the firmware through the shared vectors on every build. |
| USB gateway | The `serialport` package | Loaded and listed ports under Bun on macOS and Linux (S1). Not yet tried with a real device. |
| Schedules | Timeout-based, carried over; time zones through the Temporal API, built in or polyfilled † | HB13, HB31. |
| Video worker | A separate process the hub starts and watches, shipped with its add-on files beside it | D21. ONNX Runtime and WebGPU cannot be packed inside Bun's single-file executable (S1). |
| Service and installer | launchd on macOS, systemd on Linux and Raspberry Pi, a Windows service; a `.pkg`, a `.deb` and a Windows installer † | D16, D29. The exact tools are chosen with the remaining checks in D94. |
| Command-line tool | TypeScript, using `packages/protocol` | D38. |

## App (phone and web)

| Area | Choice | Why |
| --- | --- | --- |
| Framework | React Native with Expo and Expo Router; the web app is its static web export, served by the hub | D93. |
| Data and state | TanStack Query and Zustand | Both already used in the old web app. |
| Forms | React Hook Form with Zod | Already used in the old web app. |
| Styling | NativeWind 5.0.0-rc.1 with `react-native-css` 3.1.0-rc.1, on Tailwind 4.1.12 (`tailwindcss`, `@tailwindcss/postcss`, `postcss` 8.5.33); the look is set in `app-design.md` | The product owner's choice after a trial (4.2.7 did not build under Bun's install layout). One set of class names styles phone and web, and on the web the styles are an ordinary stylesheet, which suits the hub's strict page policy. It is a release candidate that its authors tested on Expo 57: proven here on the web build only, not yet on a phone. The root `lightningcss` 1.30.1 override is its install requirement. |
| Fonts | `@expo-google-fonts/atkinson-hyperlegible-next` and `-mono` 0.4.1 | A typeface made for legibility, bundled with the app, so no font is fetched at run time. |
| Animation | `react-native-reanimated` 4.7.1 with `react-native-worklets` 0.13.1 | NativeWind 5 needs them for transitions; worklets is reanimated 4's runtime. |
| System colours | `expo-system-ui` 58.0.7 | Sets the root background, so nothing flashes before the first screen draws. |
| Text | i18next with translation files | D58. |
| Bluetooth | react-native-ble-plx in a development build, behind `BleCentral` † (S9), for pairing and updates | The established library; needs a real phone, since simulators have no Bluetooth. |
| Notifications | expo-notifications, plus a small native extension on each platform (Swift, Kotlin) that decrypts the push before it is shown † | D32: the relay must not be able to read alerts. O15. |
| Presence | Expo's location geofencing | D98. |
| Keys and lock | Keys in the phone's secure storage (expo-secure-store), readable after first unlock, this device only; app lock through expo-local-authentication | D61, D63. |
| Home-network connection on the phone | By address, TLS as carriage (D132); mDNS browse in `hub-net`, our Expo module | D132. |
| QR scanning | expo-camera | Linking and pairing. |
| Builds | Development builds made locally with Expo's tools; no build service | Expo Go cannot load our native modules ([m3-design.md](m3-design.md) section 2). |

## Relay and push

| Area | Choice | Why |
| --- | --- | --- |
| Relay | TypeScript on Bun, Hono and plain WebSockets as the hub, `bun:sqlite` with Drizzle for hub presence, push tokens and names; one program with the roles relay, push, names and releases ([m4-design.md](m4-design.md)), protected as D142 says | Shares `packages/protocol`. One small service, as RA4 asks. |
| Relay scaling | Message routing and stored state sit behind two small interfaces: in memory and SQLite on a single server. To grow, hubs are first split across servers by hub identifier; a Redis publish/subscribe router and a shared database can replace the two implementations later | A hub and its few phones only ever talk to each other, so they can always share one server. A self-hosted relay must never need Redis (RA4). |
| Self-hosting | A Docker image and a plain executable | Docker is fine on a server; D37 concerns the hub only. |
| Push | Sent directly to APNs (HTTP/2, token authentication) and FCM (HTTP v1) by the operated push service, its own process and account, only over relay links on which a relay proved its key (D142); JWTs signed with `node:crypto`, no library | No third push company sees even the encrypted traffic (D59). Replaces the old system's use of Expo's push service. |
| Per-hub names | A DNS provider's interface to create each hub's name and prove ownership for its certificate † | D79, O8. |
| Hosting | One small server in the EU, from a host with always-on filtering of network floods, connections that may stay open for days, and the client's address passed through (D142, m4-design.md section 3); provider chosen at the relay milestone | The relay carries only small messages (D55), and what the operator runs is protected (D142). |

## Encryption in one place

| Link | Scheme | Why |
| --- | --- | --- |
| Device to hub (LoRa, Wi-Fi, USB) | AES-128-CCM with a per-device key and a counter | Smallest packets, hardware AES on the chip. |
| Firmware images | ECDSA P-256 signature by the hub's key | Checked by mbedTLS on the device with no extra library (D35). |
| Official releases | Publisher's Ed25519 signature, checked by the hub | D84. |
| App to hub, at home and through the relay | The Noise protocol (IK pattern: X25519, ChaCha20-Poly1305, SHA-256), built from the audited `@noble` libraries in `packages/protocol` and checked against the published Noise test vectors | A published, analysed handshake in place of one we invent. The same code runs in the hub, the browser and the phone, and the first message of a connection can already carry a request, which keeps a lock-screen Disarm to one round trip. |
| Hub to relay | TLS, and a Noise_XN handshake proving the hub's app key (D125); relays prove their own key the same way to the push service (D142) | D125, D142. |
| Push content | Sealed by the hub with a key each phone gives it in the app channel, ChaCha20-Poly1305, one padded size; decrypted on the phone by native code (D126) | The same primitives exist in Apple's and Android's own libraries. |
| Backups | ChaCha20-Poly1305 with the backup key | D53, D78. |
| Browser to hub | HTTPS on the per-hub name | D79. |

Using a JavaScript library for app encryption, and not the browser's built-in Web Crypto, means linking no longer depends on the browser treating the page as secure. HTTPS (D79) is still needed so that another device on the home network cannot alter the web app as it loads, but the fallback for routers that block the hub's name becomes simple (O12). The cost is that a browser's key is stored where page scripts can read it; the web app loads no outside scripts.

## Video (after the core system)

| Area | Choice | Why |
| --- | --- | --- |
| Motion models | TypeScript with WebGPU compute shaders, through Dawn's bindings † | D18; O1. A compute shader ran under Bun on the Mac's GPU in S1; running from a background service is still to prove. |
| Object and face detection | ONNX Runtime | D20. |
| Decoding | Bundled ffmpeg | CV8. |

## Hardware tools

| Area | Choice | Why |
| --- | --- | --- |
| Board design | KiCad | Free and open, matching the CERN-OHL-S licence (D30). |
| Current measurement | A power profiler on the battery jumper (E8) | The sleep and per-report figures in the board document are unmeasured. |

## Not used

Redis, PostgreSQL and Docker on the hub (D15), Python at run time (D17), Next.js and Socket.IO (replaced by the Expo web export and plain WebSockets), Electron (D16), Zephyr and CircuitPython (D4, D6), Expo's push service, LoRaWAN, and Secure Boot.
