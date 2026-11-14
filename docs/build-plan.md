# Build plan

Last updated 2026-11-12. What has to be built, in order. Requirement numbers refer to [software.md](requirements/software.md), decisions and open items to [architecture.md](architecture.md), technology choices to [stack.md](stack.md).

## How the order was chosen

- Anything that takes time to arrive is ordered or applied for first: the development boards now, the custom board straight after the bench milestone.
- A spike runs before the work whose design it could change.
- While the boards are in the post, everything that needs no hardware is built, so the boards only have to prove it.

## Order today

The full list, with prices, sellers and the wiring table, is in [dev-board-choice.md](spikes/dev-board-choice.md). Prices and stock were read on 12 November 2026.

| Item | Quantity | For |
| --- | --- | --- |
| Olimex ESP32-S3-DevKit-LiPo: native USB socket, battery connector, every pin on headers | 4 (three roles and a spare) | M1b, all board spikes |
| Seeed "Wio-SX1262 for XIAO", pin-header version (part 113010003): the radio, wired to the pins we choose | 5 | M1b, range test |
| 868 MHz antennas with U.FL plugs, and two SMA pigtails with whip antennas | 4 + 2 | every radio; the gateway and the range walk |
| Breadboards and jumper wires | 8 and 4 packs | wiring radio to board |
| Door contacts, lever switches, piezo buzzers, a MOSFET output module | 2, 2, 4, 2 | sensor and siren roles |
| 32.768 kHz crystals with load capacitors | 5 | sleep-clock test with and without a crystal (S8) |
| Power profiler (Nordic Power Profiler Kit II) | 1 | sleep current and energy per report |
| 1.54 inch e-paper module (200×200, SPI) | 1 | pairing code display, M3 |
| LiPo cells with the Olimex connector, or a USB power bank | 2 | the range walk |

About £185 without the profiler and about £280 with it.

Needed later, and only the owner can get them:

| Item | Needed for |
| --- | --- |
| A real Android phone and a real iPhone | M3: simulators have no Bluetooth |
| A paid Apple developer account | M4: real push, and asking Apple for the critical-alert permission, which takes time to be granted |
| A product name and a domain | M4: relay address, app identifiers, per-hub names |

## Spikes

Reports are in [spikes/](spikes/).

| # | Question | Needs | When | What it decides |
| --- | --- | --- | --- | --- |
| S1 | Done: [report](spikes/S1-runtime.md). The hub runs on Bun (D94). Remaining checks: Windows and Linux x64 on hosted build machines, a background service at boot, a week-long run | Mac, hosted machines | before M2 | O7; installer tools |
| S2 | Done: [report](spikes/S2-radio-rules.md). EU and UK 868 MHz rules | desk | done | D104; channel plan in the protocol |
| S3 | Done and set aside: [report](spikes/S3-en50131-grade2.md). EN 50131 grade 2 is not targeted (D83) | desk | done | nothing |
| S4 | Done: [report](spikes/S4-per-hub-names.md); the certificate-warning check is [O12](spikes/O12-cert-warning.md), which passed in Chrome and Safari on the Mac. Still to run: Firefox and the phones | Mac, simulators | before M4 | O8, O12, RA12 |
| S5 | Push, part 1: a throwaway Expo app where a native extension decrypts a push and a Disarm action runs with the app closed, on the iOS simulator and Android emulator | Mac | while boards ship | O15; whether D32 and D51 hold as designed |
| S6 | Range at the property, and reply time through gateway and hub | boards | boards arrive | O10, O11; listen window, gateway count and placement |
| S7 | One gateway radio hearing both the fast and the slow setting | boards | boards arrive | O14; LR4 as designed, or one setting per site |
| S8 | Sleep current and energy per report on a development board (indicative only) | boards, profiler | boards arrive | battery estimates in the board document |
| S9 | Bluetooth: pairing exchange and firmware transfer speed from the Expo app to a board | real phone | start of M3 | pairing library, UP6 |
| S10 | Push, part 2: critical alert through silent mode and Disarm from a locked phone, on real phones | Apple account, real phones | start of M4 | O15 |
| S11 | WebGPU from a background service on each system | Mac, then each system | before M7 | O1 |

## M1a. Door to siren in software (while the boards ship)

| Piece | What it is | Requirements |
| --- | --- | --- |
| Protocol spec | Agreed: [protocol.md](protocol.md) | LR1–LR10, D71, D72, D104, D106 |
| Shared protocol package | Done: [`packages/protocol`](../packages/protocol). Packet codec, counters, USB framing and test vectors in TypeScript, with an independent verifier that rebuilds every vector from the spec using Node's own AES-CCM | LR1–LR3 |
| Firmware core | Done: the event loop, every hardware interface and the shared services, designed in [firmware-design.md](firmware-design.md). The old Zephyr core's behaviour and tests carry over as scenarios; its blocking code does not. The old watchdog and double-sleep bugs cannot occur by construction, and tests enforce it | FW1, FW3–FW9 |
| Packet codec and crypto (C++) | Done: [`firmware/core`](../firmware) and `firmware/platform/psa`. Written from the spec and vectors alone; passes every vector under Apple clang and GCC, with memory and undefined-behaviour checkers. Tests enforce no heap, no exceptions and no floating point in the core | LR1–LR3 |
| Sensor role | Done: [`firmware/roles/sensor`](../firmware/roles/sensor). Door, cover and button reports with retries, heartbeats in the hub's slots, countdown buzzer, local alarm when the hub does not answer, data-rate fall-back that goes round, factory reset, deep sleep. Tested over a simulated year | DS1–DS14, D88, D89, D109–D111 |
| Siren role | Done: [`firmware/roles/siren`](../firmware/roles/siren). Commands on both paths with duplicate drop, automatic stop, sounding resumed after a reset, reports on Wi-Fi and LoRa with pacing, urgent reports of a change | SR1–SR9, D73, D80, D111 |
| Gateway role | Done: [`firmware/roles/gateway`](../firmware/roles/gateway). Forwards every packet heard, sends the hub's packets at their moment, a queue of 16 with siren commands first, USB or Wi-Fi, status and interference reports. Load sweep to 50 sensors with nothing lost inside the gateway | GW1–GW6, GW8–GW11, D111 |
| Host tests | Done: each role's own scenario tests, and [`firmware/tests/system_roles`](../firmware/tests/system_roles), which runs the three real roles together: the armed-door chain, each lost path, two gateways, a day of load, a 30-door burst with 8 sirens, a faulty sensor, restarts and interference. It found two faults no single role's tests could: a sensor stranded on a data rate nobody listened at, and replies cut off at slower rates | FW3 |
| Minimal hub | Done: [`hub`](../hub), designed in [hub-design.md](hub-design.md). One pure step function over thirteen modules, the gateway and siren links over USB and WebSocket, the countdown per sensor, siren commands with repeats, every packet and decision recorded, and SQLite written in grouped commits measured against a budget for a Raspberry Pi, with the data held under 500 MB. Not yet tried on a real Pi, a real board's USB port or Windows (O18, HB35) | HB1, HB2, HB11, HB35, AL3, AL4, D86, D110, D112–D115 |
| Command-line tool | Done: `hsn`, over the hub's control socket. Arm, disarm, status, the log with `--follow`, adding a board over USB, site and device settings, moving the site's channel or rate | D38, PR5 |
| Simulated radio | Bench done: a scheduler for any number of simulated devices with drifting clocks, a shared radio medium, a test hub and a recorded timeline, in `firmware/platform/host`. Joined to the real hub in real time: `hsn_bench` runs the real roles on pseudo-terminals and [`tools/bench-bridge`](../tools/bench-bridge) carries the Wi-Fi links. In lockstep mode the bench drives the hub's clock, so the firmware's system tests, day-long ones included, run against the real hub in seconds (`bun run check:firmware:lockstep`): every case passes except two that need a site with two data rates (O14). That work found and fixed four hub faults, one of them a door report dropped when it came through a gateway session the hub had not yet confirmed | FW3 |

Done when: in the simulation, opening the armed door starts the buzzer and the siren role switches when the countdown ends unless the command line disarms first. **Met on 2026-11-13** by `bun run m1a`: the real hub, a sensor, a siren and a gateway added over USB, then the armed door through to the siren, a disarm inside the countdown, and the hub restarted inside the countdown, 25 checks in about 45 seconds.

## M1b. Door to siren on the bench (boards arrive)

| Piece | What it is | Requirements |
| --- | --- | --- |
| ESP-IDF platform layer | Pins, deep sleep, watchdog, storage, SX1262 driver, Wi-Fi, serial key setup | FW2, PR5 |
| Hardware contract tests | One small test suite run against both the simulator's fake hardware and the real drivers on a board, so the simulator is known not to promise what the hardware does not do | FW3 |
| Spikes S6, S7, S8 | Range, reply time, two settings on one radio, current | O10, O11, O14 |

Done when: opening the armed door on the bench starts the sensor's buzzer, and the siren board switches 30 seconds later unless disarmed from the command line; disarming stops the buzzer; the spike results are written down.

## M6. Hardware (starts as soon as M1b passes, runs alongside M2–M5)

Board manufacture and delivery take weeks and usually two rounds, so this starts early and the software continues on development boards.

| Piece | Source |
| --- | --- |
| Checks before the schematic: 12 V add-on and siren power, e-paper panel chosen on price | O6, [sensor-board.md](requirements/sensor-board.md) "Verify before schematic" |
| The board: schematic, layout, five assembled prototypes | [sensor-board.md](requirements/sensor-board.md) |
| 12 V siren add-on | O6 |
| Enclosures: sealed sensor case, gateway, siren controller | O6 |

## M2. Hub and the app's web build

| Piece | Requirements |
| --- | --- |
| Data model: users, permissions, devices, groups, modes, schedules, history | HB4, HB5, HB5a, HB7, HB29, HB32, D90 |
| Arming rules: modes and groups, open-door arming, countdown, alarm, siren choice, automatic stop, post-alarm rule, restart resume | AL1–AL11, HB30 |
| Device health: silence detection, tamper, low battery, siren paths, gateway silence, jamming | HB8–HB10, HB25, SR6, GW6, GW11 |
| Schedules as single actions, timing logic carried over | HB13, HB31, AL2, AL10, D87 |
| Notifications engine with categories | D75, D76, D92 |
| App messages and live updates inside the encrypted channel, every request authenticated | HB3, HB3a, HB14 |
| Linking of phones and browsers with keys, invites, removal | D61, D62, D99 |
| History and retention | HB15, HB24 |
| The app, web build: setup, linking QR code, modes, arming, groups, schedules, devices, history, users | AP0, AP1, AP4, AP5, AP7, D93 |
| Installer and background service for Windows, macOS, Linux, Raspberry Pi; sleep prevention; gateway discovery | HB18–HB21, HB28, GW8 |
| Backup, export, restore | HB22 |
| Hub updates | HB23 |
| Gateway over USB, added automatically | GW10, PR7 |

Done when: a fresh computer goes from installer to an armed house using the web app, and the M1 boards work against it.

## M3. Pairing and firmware updates (needs a real phone)

| Piece | Requirements |
| --- | --- |
| Spike S9 | |
| Bluetooth pairing on the devices and in the phone build, Wi-Fi details, factory reset | PR1–PR4, DS7, DS8, AP2 |
| Pairing code generation and e-paper display driver | PR6, D85 |
| Two-slot updates with trial boot and rollback | UP1, UP2 |
| Hub signing key, firmware store, rollout, holding updates for armed sensors | UP3, UP4, UP7–UP9, HB16, HB17 |
| Update over Wi-Fi | UP5, GW7, SR8 |
| Update over Bluetooth from the phone | UP6, AP3 |

## M4. Relay and push (needs the Apple account, name and domain)

| Piece | Requirements |
| --- | --- |
| Spike S10 | O15 |
| Relay service, end-to-end encrypted, self-hostable | RA1–RA4, RA7 |
| Push service to Apple and Google, with on-phone decryption | RA9, D77 |
| Hub-unreachable alerts | RA10, D96 |
| Per-hub HTTPS names, detection of routers that block them, and the direct-address fallback | RA11, RA12, O8, O12, D105 |
| Signed official releases fetched through the relay | UP4, D84 |
| Direct phone-to-hub connection with relay fallback, used later for video | D56 |

## M5. Phone-only features

The shared screens already exist from M2.

| Piece | Requirements |
| --- | --- |
| Several hubs, home or relay connection | AP8, RA5, RA8 |
| Notifications, critical alerts, Disarm button on the lock screen, countdown screen | AP6, AP9, AP9a, AP10 |
| Presence offers | AP11 |
| App lock | AP1a |

## M7. Cameras and video

CV1–CV10, after S11 (O1) and O3 are settled.

## Alongside

- Full licence texts (D30) and the App Store question (O4).
- Translation files from the first interface text (HB27).
- Continuous integration from M1a: host firmware tests, hub tests, the simulated chain, shared protocol test vectors.
