# Software requirements

Last updated 2026-11-18. Gathered from the old repo (`../home_security`) and the design discussion. Decisions referenced by D-number are in [architecture.md](../architecture.md).

**Starting point** says what exists in the old repo: a path means there is code worth carrying over or reading first, and *new* means nothing exists. Paths are relative to `../home_security/localServices`.

Items marked † are proposals that have not been explicitly agreed.

## 1. Firmware, all devices

| # | Requirement | Starting point |
| --- | --- | --- |
| FW1 | Portable C++17 core with no heap and no platform includes; all hardware behind interfaces | `deviceCode/zephyr/src/core` |
| FW2 | ESP-IDF platform layer for ESP32-S3: storage, pins, deep sleep, watchdog, Wi-Fi, LoRa, Bluetooth | new; `deviceCode/zephyr/src/platform/zephyr` shows the shape |
| FW3 | Core logic is built and tested on the host against fake hardware | `deviceCode/zephyr/tests/native_sim` (11 tests pass) |
| FW4 | Hardware watchdog that survives idle waits | old core starts an 8 s watchdog and then waits up to 60 s without feeding it |
| FW5 | Reset cause and last fatal error are stored and reported on the next contact | old core |
| FW6 | Bounded log buffer. Every failure path records an entry with a code; no error is discarded silently. Entries go to the hub as they arise over Wi-Fi and USB, and one at a time over LoRa for warnings and above, kept until the hub has them (D110) | old core, `log_ring` |
| FW7 | Bounded retries with back-off; no unbounded loops or recursion | old core, `retry_policy` |
| FW8 | Device reports its firmware version to the hub | new |
| FW9 | Core talks to the hub through a transport-neutral link with LoRa, Wi-Fi (one kept-open WebSocket) and USB serial implementations, all carrying the same packets (D101) | old core is tied to Wi-Fi and HTTP (`interfaces.hpp`, `device_core`) |

## 2. Door sensor

| # | Requirement | Starting point |
| --- | --- | --- |
| DS1 | Deep sleep by default; wake on door edge, button, cover tamper, USB plug-in or heartbeat timer | old core wakes on door and timer |
| DS2 | On wake, send one report and sleep again | old `main.cpp` sleeps a second time after each cycle; do not carry that over |
| DS3 | If the door changes while a report is in flight, send the new state before sleeping | `deviceCode/zephyr/src/roles/sensor` |
| DS4 | Heartbeat every 3 minutes by default; the interval arrives in the hub's reply and is stored | old core has a fixed `ping_interval_ms` |
| DS5 | Armed state arrives in the hub's reply and is stored across sleep (D8) | old core, over HTTP |
| DS6 | When the door opens while armed and no reply comes from the hub (gateway or hub down), the sensor buzzes for the stored countdown and then sounds its own alarm. That alarm lasts about 3 minutes while the sensor keeps trying the hub, and stops early when the hub answers "disarmed" or the button is pressed (D88) | old sensor role, stale-armed alarm |
| DS7 | Button: short press reports; about 5 s opens pairing for about 2 minutes on an unpaired board; about 15 s factory-resets | new |
| DS8 | While armed, a pairing hold does nothing and is reported. A factory-reset hold is reported and the sensor buzzes; the reset is refused if the hub answers and goes ahead if nothing answers through the 10 minutes of retries (D89) | new |
| DS9 | Cover tamper is reported immediately | new |
| DS10 | Telemetry in every packet: battery voltage, charging state, chip temperature. The voltage is measured before the radio transmits, not during, so the reading is not pulled down by the transmit current (D109) | old core sends temperature, voltage, frequency |
| DS11 | Low-battery warning by buzzer at the voltage the hub treats as 10%, and to the hub in every packet (D109) | new |
| DS12 | Every door change is sent at once. The buzzer starts when the hub's reply says an entry countdown has started, so it works even if the sensor's stored armed state is out of date (D23, D24, D71) | new |
| DS13 | While buzzing, the sensor keeps its radio listening and stops on a "disarmed" message from the hub; it stops by itself when the countdown ends (D24) | new |
| DS14 | This sensor's countdown length (D86) arrives in the hub's reply and is stored, like the heartbeat interval, for use when no reply comes (DS6) | new |

## 3. Siren

| # | Requirement | Starting point |
| --- | --- | --- |
| SR1 | Always-powered ESP32-S3 controller (the common board, D49) that listens on LoRa and Wi-Fi continuously and switches a separate sounder (D42); a home can have any number of them (D41) | new; replaces the Pico relay |
| SR2 | Switches on and off only on a command from the hub, over LoRa through a gateway or over Wi-Fi (D7, D36) | old hub calls the relay's `/on` and `/off` over HTTP, `backend/src/alarmFuncs.ts` |
| SR3 | Commands are authenticated and protected against replay, as in LR2 | old relay accepts unauthenticated requests |
| SR4 | Every command is acknowledged with the resulting state; the hub retries until acknowledged | new |
| SR5 | The siren switches itself off after a configured time, even if the "off" command never arrives | old alarm role, auto turn-off |
| SR6 | Reports state and telemetry every 30 seconds over Wi-Fi, over LoRa at once when a Wi-Fi report fails, and over LoRa every few minutes as a check; the hub warns when one path is lost and reports the siren silent when both are (D52, D73) | old alarm role |
| SR7 | Also accepts commands over Wi-Fi. The hub sends each command on both paths at once; the siren acts on the first copy and discards the second by its counter (D36, D73, LR2) | new |
| SR8 | Paired and updated the same way as a sensor | new |
| SR9 | A short test can be started from the siren's settings page; there is no panic button (D65) | old app's test alarm with confirmation |

## 4. LoRa link

| # | Requirement | Starting point |
| --- | --- | --- |
| LR1 | Compact binary packets as defined in [protocol.md](../protocol.md): door event, heartbeat, tamper, button, siren command, siren report, disarmed notice, reply | new |
| LR2 | Per-device key, authenticated encryption, and a counter that rejects replays; encrypted end to end between device and hub, so the gateway cannot read or forge packets (D71) | new |
| LR3 | Door events, tamper and button reports and siren commands are always acknowledged and retried. A heartbeat carries the sensor's armed state and settings version; the hub replies only when they differ, and to every few heartbeats as a link check (D72) | new |
| LR4 | Fast setting first, slow setting when there is no reply; remember what worked | new |
| LR10 | One sensor channel per site in 868.0–868.6 MHz; hub replies and siren commands on 869.525 MHz; a device sends on one and listens on the other (D104) | new |
| LR11 | Heartbeats go out at moments the hub assigns per sensor, with a clock correction from the hub. Replies and siren commands use a faster data rate than the device sends at, chosen by the hub from signal margin, with a fall-back to the sending rate (D108) | new |
| LR5 | Sensor, siren and gateway each keep their regular traffic within the airtime limit for their band. Urgent traffic goes at once and is never held back, even past the limit; it is then spaced so a faulty device cannot fill the channel, and logged (D111) | new |
| LR6 | The hub's reply to a sensor carries armed state, heartbeat interval, countdown length, "countdown started" for door events, and an "update available" flag | new |
| LR7 | A sensor's radio is asleep whenever the sensor is asleep, except while it buzzes for a countdown (D24) | new |
| LR8 | The protocol carries a version number so new device types and fields can be added (D27) | new |
| LR9 | Capacity per gateway: about ten sensors at the slowest setting or thirty at the fastest, from the [gateway load simulation](../spikes/gateway-load.md); confirmed by the range test (O11) | new |

## 5. Gateway

| # | Requirement | Starting point |
| --- | --- | --- |
| GW1 | ESP32-S3 on the home network that listens on LoRa continuously | new |
| GW2 | Forwards each device packet to the hub, and the hub's replies and siren commands back over the air, fast enough to land in the sensor's listen window (O10) | new |
| GW3 | Holds no alarm logic and never answers a device on its own; it cannot read device traffic (D7, D71) | new |
| GW4 | Authenticates to the hub with its own key, received at pairing | new |
| GW5 | Reports signal strength per device, to help with placement | new |
| GW6 | Reports its own health; when the gateway goes silent the hub sends one notification naming it and the number of sensors that depend on it (D97) | new |
| GW7 | Updated over its link, Wi-Fi or USB, with the same update mechanism as sensors | new |
| GW8 | Finds the hub on the home network without manual configuration | `advertisementService` (UDP discovery) |
| GW9 | Several gateways can serve one hub; the hub counts a report heard by more than one gateway once, and replies through the first one that delivered it (D28) | new |
| GW10 | When connected to the hub computer by USB cable, talks to the hub over serial USB only; otherwise over Wi-Fi (D81) | old core has serial provisioning |
| GW11 | Measures the radio noise level between packets; the hub raises an always-on alert on sustained interference, critical while armed (D82) | new |

## 6. Firmware updates

| # | Requirement | Starting point |
| --- | --- | --- |
| UP1 | Two firmware slots; a new image runs on trial and is confirmed only after it reaches the hub | new |
| UP2 | Automatic rollback when the trial image fails or the watchdog fires | new |
| UP3 | Images are signed with the hub's own key; a device accepts only images signed by the hub it is paired with, and receives that key at pairing (D35) | new |
| UP4 | Official releases arrive through the relay connection, signed with the publisher's key; the hub checks it before signing with its own key. The owner can also load their own build (D84) | new |
| UP5 | Sensor in Wi-Fi range: told an update exists in its LoRa reply, joins Wi-Fi, downloads from the hub | new |
| UP6 | Sensor out of Wi-Fi range: updated from the phone app over Bluetooth | new |
| UP7 | No update below a battery threshold | new |
| UP8 | Roll out to one device first, then the rest | new |
| UP9 | An approved update is held for each sensor until that sensor is disarmed, and the app reminds the user when a sensor stays armed. Gateways and sirens update one at a time, never during a countdown or alarm (D91) | new |

## 7. Pairing

| # | Requirement | Starting point |
| --- | --- | --- |
| PR1 | Phone app pairs a device over Bluetooth using the code shown on the unit's display (PR6) | new |
| PR2 | Pairing delivers the device identity, its key, the hub's firmware signing key, and Wi-Fi details: required for sirens and for gateways not on USB, optional for sensors (D47) | old core has serial provisioning, `provisioning`, `provisioning_session` |
| PR3 | Bluetooth is off outside pairing and update sessions | new |
| PR4 | Factory reset erases keys and settings, and the hub is told by a button report sent just before erasing | new |
| PR5 | Serial provisioning stays for development | old core |
| PR6 | The device creates its pairing code on first boot and after a factory reset, and shows it as text and a QR code on its e-paper display; the phone app scans the QR code or the user types the code (D85) | new |
| PR7 | A new or factory-reset gateway plugged into the hub computer by USB is added automatically, without a click or Bluetooth, and the app shows that it was added. Other boards, and gateways of another hub, are left alone (D100) | new |
| PR8 | One firmware image serves all three roles; each board stores its role and reports it when pairing (D103) | new |

## 8. Hub

| # | Requirement | Starting point |
| --- | --- | --- |
| HB1 | Accept device updates relayed by a gateway | `backend/src/express/routes/Sensors.ts`, `Alarms.ts` take direct HTTP only |
| HB2 | Authenticate devices and gateways by their own keys (LR2, GW4) | old hub trusts an `X-Device-ID` header, `backend/src/utils/deviceIdentification.ts` |
| HB3a | No passwords: linked devices prove themselves with their own key, tied to a user; the browser on the hub computer is trusted locally; invites are one-time and expire after 24 hours (D99); devices can be removed (D61, D62) | new |
| HB3 | Authenticate every request on every API route and on the live connection | old hub has none and allows any origin |
| HB4 | Accounts and permissions in the data model from the start; each linked phone belongs to a named person, and every person has every permission while user management is off (D13, D61) | new |
| HB5 | Permissions per user (D33). Per sensor and per camera: *manage* (arm, disarm, settings) and *view history*. Global: *manage users* and *manage system* (add and remove devices, hub settings, modes, schedules). User management appears only when switched on in settings (D13) | new |
| HB5a | A user can switch to a mode only if they can manage every sensor the switch would arm or disarm; history and alerts show only devices the user may view | new |
| HB6 | No debug routes in a release build | old hub mounts `/api/v1/debug` |
| HB7 | Store per device: battery, charging, tamper, firmware version, signal strength, which gateway heard it | `backend/src/redis/doorSensors.ts` has temperature, voltage, frequency |
| HB8 | Heartbeat interval editable per sensor and passed down in replies; the silence timeout follows it | `expectedSecondsUpdated`, `backend/src/microDeviceTimeoutMonitor.ts` |
| HB9 | Sensor or siren silence sends a phone notification, critical when armed; it does not sound the siren (D9) | old timeout monitor marks the device unknown |
| HB10 | Cover tamper and ignored long presses send a phone notification (D9) | new |
| HB11 | Only an open door on an armed sensor sounds the siren (D7), after the entry countdown in AL3 | old hub sounds it at once |
| HB12 | Siren automatic stop, and the post-alarm rule in AL9; no cooldown timer | `backend/src/alarmTimeoutManager.ts` |
| HB13 | Schedules: each entry is one action at one time (switch to a mode, or arm or disarm a group or sensor), recurring or one-time, timeout-based, with an execution log (D87). A door open at arming time arms when it closes (AL7), so no retry loop is needed | `backend/src/scheduleManager.ts` for the timing logic; its arm-and-disarm pairs are not carried over |
| HB14 | Live updates to connected apps after every state change | `backend/src/express/socketHandler.ts` |
| HB15 | An audit record in the database of every packet received from and sent to each device (decoded, with time, path, gateway and signal), every rejected packet and why, every decision the hub takes with its cause, and every device log entry. A flood of rejected packets is recorded as counts per source and minute, so it cannot fill the disk (D110) | PostgreSQL tables in `backend/src/db/schema`: `sensorUpdates`, `alarmUpdates`, `eventLogs` |
| HB16 | Store firmware images and track each device's version and update state | new |
| HB17 | Create and store each device's key at pairing | new |
| HB18 | One TypeScript service with an embedded SQLite database; no Redis, PostgreSQL or Docker (D15) | old hub is seven Docker services |
| HB19 | Native installer per operating system that registers a background service and opens a setup page; needs no manual network setup (D16) | new |
| HB20 | Starts at boot with no one logged in, and restarts after a crash | new |
| HB21 | Warns at setup when the host is a laptop or on battery, which can still sleep when the lid closes or power fails (D64) | new |
| HB22 | Scheduled encrypted backup of the database to a chosen folder, export on demand, and restore on a new hub without re-pairing devices (D53). The hub creates the backup key and gives it to each phone when it is linked (D78, D99) | new |
| HB23 | Hub updates are approved by the user, installed beside the running version, switched with a short restart, and rolled back if the new version fails to start; never during a countdown or alarm (D54) | new |
| HB24 | History retention: events 1 year, heartbeat readings 30 days, both adjustable (D57) | old hub keeps everything |
| HB25 | A sensor is reported silent after a number of missed heartbeats chosen per sensor from its measured packet loss, from 3 to 8, keeping false alerts below one a year for the site; a sensor losing more than a fifth of its packets is shown as having a poor link (D107). Sirens are reported silent after 2 missed reports at a 30-second interval (D52, D73) | `backend/src/microDeviceTimeoutMonitor.ts` |
| HB26 | No data leaves the home by default; crash reports are opt-in (D59) | new |
| HB27 | All interface text is in translation files; English first (D58) | new |
| HB28 | The installer stops the hub computer from sleeping while the service runs (D64) | new |
| HB29 | Sensors have no building or room; they are organised by the user's groups (D70) | old system's `buildings` table is not carried over |
| HB30 | Countdown deadlines and alarm state are saved as they change. After a restart the hub reads each siren's state, sounds the sirens for any countdown that ran out while it was down, and does not re-trigger a sounding alarm (D80) | new |
| HB31 | Schedules follow the hub's local time zone, daylight saving included | old schedule logic |
| HB32 | Armed state is held per sensor; modes, groups and schedules change it as described in D74 | old hub arms per sensor |
| HB33 | The hub turns each battery voltage into a percentage from a table for the fitted cell, and warns the users who can view a device when its battery reaches 10%. The warning is raised once on the way down and clears when the battery is back above 15% (D109) | new |
| HB34 | Every error on the hub is caught and recorded in the event log with its origin and severity; none is swallowed. An error nothing caught is recorded before the process exits, and the restart and its cause are recorded when the hub comes back (D110) | old `eventLogs` with a system origin and four severities |
| HB35 | The hub without cameras runs well on a Raspberry Pi 4 or 5 (D112). It keeps to a stated budget of memory, processor time and bytes written to storage per day, each measured on a real Pi before release †. What it stores stays within 500 MB of disk at the default retention (D57), for the largest site the protocol allows. Database writes are grouped: only state that must survive a power cut is written through at once (sending counters' resume points, alarm and countdown state, pairing data); every door, cover, button and started report and every warning or worse are also written at once; routine records, device readings and the replay windows of routine packets are committed together every five minutes | new |

## 9. Remote access

| # | Requirement | Starting point |
| --- | --- | --- |
| RA1 | The hub opens an outbound connection to a relay; the user opens no router ports and creates no third-party account (D12) | new |
| RA2 | Traffic between app and hub is encrypted end to end; the relay cannot read or alter it | new |
| RA3 | A default relay address is built in, and a setting points the hub at a self-hosted relay (D12) | new |
| RA4 | The relay is one small service that a user can run on their own server | new |
| RA5 | The app uses the hub directly when on the home network and the relay otherwise | `mobileApp2/lib/networkDetection.ts` (endpoint priorities) |
| RA7 | The system works fully on the home network with the relay unreachable | old system is local-only |
| RA8 | A phone is linked by scanning a QR code or typing a code shown by the hub, which exchanges keys; further phones are invited from a linked one (D34) | new |
| RA9 | Push notifications go from the hub through the relay to Apple's and Google's push services, with content the relay cannot read (D32). Pushes always pass through the operated push service, also for self-hosted relays (D77) | old system calls Expo's push service, `eventService` |
| RA10 | When a hub has been out of contact for 3 minutes, the relay tells its phones that the hub cannot be reached and alerts will not arrive, and tells them again when it returns. The alert breaks through silent mode only when the phone last saw the home armed, decided on the phone. A hub restarting for an update announces it first, and no alert is sent (D64, D96). Notifications raised while the hub was cut off are sent when the link returns, each saying when it happened and that it was delayed (D102) | new |
| RA11 | Each hub gets an HTTPS name with a real certificate, pointing at its home-network address, so other browsers on the home network can use the web app (D79, O8) | new |
| RA12 | The hub checks whether the home router's name lookups block its own name (DNS-rebinding protection) and, if so, tells the user in the phone app and on its local page. It shows how to add a router exception where one exists, and offers its direct home address over HTTPS with a certificate the browser warns about until the user trusts it; the hub keeps that certificate. The web app uses no service worker, which Chrome refuses on such a page (O12). Web traffic never goes through the relay (D79, D105) | new |

## 10. Apps

Two apps (D31): a phone app for iOS and Android, and a web app served by the hub on the home network for setup and management. There is no desktop app and no web app through the relay. Both are built from one React Native (Expo) codebase: Bluetooth, push, presence and the app lock exist only in the phone build; first-time setup and everything else are in both (D93, D105).

| # | Requirement | Starting point |
| --- | --- | --- |
| AP0 | First-time setup runs in the web app, which shows the QR code that links the first phone, or in the phone app after linking with the code the installer prints (D62, D105) | `webapp` (Next.js), for behaviour only |
| AP1a | Optional app lock using the phone's fingerprint or face check; notification actions do not ask for it (D63) | new |
| AP1 | Link to a hub by code (D61); modes, arm, disarm, groups, schedules, device list, history | `mobileApp2`, `webapp` (no sign-in) |
| AP2 | Bluetooth pairing flow (phone only) | new |
| AP3 | Bluetooth firmware update for out-of-range sensors (phone only) | new |
| AP4 | Show battery percentage, signal strength, firmware version and tamper state per device (D109) | new |
| AP5 | Edit the heartbeat interval | new |
| AP6 | Notifications for countdown, alarm, tamper, device silent, low battery, gateway offline, siren path lost, hub cannot be reached (D96), arm and disarm, and updates (D75) | old system pushes warning and critical events through `eventService` |
| AP7 | User management with per-sensor and per-camera permissions, hidden until switched on (D33) | new |
| AP8 | The phone app can hold several hubs (D28) | new |
| AP9 | Critical alert on countdown and on alarm that breaks through silent mode (D92), with the Disarm button for every user who may disarm that sensor; it stops the siren and disarms every sensor that user may manage (D51, D76) | new |
| AP9a | Notifications cover the sensors the user can view. Countdown, alarm, tamper, device silent while armed, siren silent and hub offline cannot be turned off; the other categories can, per phone (D69, D75) | old event service pushed warning and critical events |
| AP10 | Entry countdown shown in the app with a disarm button | new |
| AP11 | Presence, opt-in per person: the phone works out leaving and arriving by itself and tells the hub only that. When everyone has left the hub offers Away, and on arriving while armed it offers Disarm; nothing changes without a tap (D25, D98) | new |

## 11. Cameras and video

Built after the core system works (D14).

| # | Requirement | Starting point |
| --- | --- | --- |
| CV1 | Read network cameras, stream live view to apps, and record clips with time before and after an event | `cameraIngestion` (TypeScript) |
| CV2 | Motion detection with MOG2, KNN and simple differencing behind one strategy interface, with zones and a minimum area | `motionDetection/src/detection` (Python, OpenCV) |
| CV3 | MOG2 and KNN are implemented in TypeScript and run on the GPU as WebGPU compute shaders (D18) | new; the old GPU path is NVIDIA-only OpenCV |
| CV4 | A CPU implementation of the same models is used when no GPU is available (D19) | new |
| CV5 | The TypeScript models are checked against masks produced by OpenCV on recorded clips, within a tolerance | new |
| CV6 | Object detection runs an ONNX model through ONNX Runtime, on the GPU where available, and only when motion is detected (D20) | `objectDetection` (PyTorch, Ultralytics) |
| CV7 | Face detection and recognition run as ONNX models | `videoProcessing/faceDetector`, `faceRecognition` |
| CV8 | Video decoding uses a bundled ffmpeg, with hardware decoding where available | new |
| CV9 | Video runs in its own process, supervised by the hub; only events reach the hub, and video load cannot delay the alarm path (D21) | old system passes every frame through Redis |
| CV10 | No Python, Redis or Docker at run time (D17) | new |

## 12. Arming and alarm behaviour

| # | Requirement | Starting point |
| --- | --- | --- |
| AL1 | Sensors belong to groups; modes each arm a chosen set of groups; a single sensor can still be armed by hand (D22). Two modes are fixed: Away arms every sensor and Disarmed arms none; all others are made by the user (D90) | old hub arms per sensor, with buildings |
| AL2 | A schedule entry targets a mode, a group or a single sensor and does one thing: switch to the mode, arm, or disarm (D45, D87) | `backend/src/scheduleManager.ts` (lists of sensors) |
| AL2a | Each group lists which sirens sound for it; by default every siren sounds. A sensor in several groups sounds the sirens of all of them; a sensor in no group sounds every siren (D41, D74) | old hub sounds every alarm in the building |
| AL2b | A door opening while disarmed is logged only (D46) | old hub |
| AL3 | An armed door opening starts an entry countdown on the hub, 30 seconds by default and set per sensor, where zero sounds the siren at once (D86); disarming within it cancels the alarm and sends the sensor a "disarmed" message; otherwise the siren sounds. Another door opening during a countdown does not restart it, and closing the door does not cancel it (D23, D24, D40) | new |
| AL3a | The "door opened" notification carries a Disarm button (D40) | new |
| AL3b | There is no exit countdown (D39) | new |
| AL4 | The countdown runs on the hub, counted from when the door opened as the report states, and does not depend on hearing from the sensor again. A report that arrives late is handled as in D106 (D23) | new |
| AL5 | On alarm: siren on, critical alert to every user who can view that sensor, linked cameras record once cameras exist (D26, D76) | old hub: siren and push |
| AL6 | The siren stops by itself after a set time, 5 minutes by default and adjustable, and the system stays armed (D26, D40) | `backend/src/alarmTimeoutManager.ts` |
| AL7 | Arming with a door open: the user is told which door and asked; on continue the rest arm now and the open door arms when it closes (D50). A schedule does the same without asking and sends a warning | old schedule retry logic |
| AL7a | Countdown and alarm notifications carry one Disarm button that stops the siren and disarms every sensor that user may manage (the whole house while user management is off), and works while the phone is locked (D51, D76) | new |
| AL8 | Every arm, disarm, countdown and alarm is recorded with who or what caused it | old `scheduleExecutions` and event logs |
| AL9 | After the siren stops by itself, everything stays armed; the door that set it off is ignored until it closes, then arms again (D67) | old 30 s cooldown in `alarmTimeoutManager.ts` |
| AL10 | A manual disarm during a scheduled armed period lasts until the next schedule entry runs (D68, D87) | new |
| AL11 | A Disarm ends an alarm only when every sensor that set it off is then disarmed; otherwise the sirens run on to their automatic stop. Only a person's Disarm does this: a scheduled disarm never ends a countdown or an alarm (D117). A second door opening during a countdown or alarm adds the sirens of its groups (D95) | new |
| AL12 | Arming with a low battery: when a mode, group or sensor being armed includes a sensor at 10% battery or below, the user is told which and asked before it goes on. A schedule arms anyway and sends a warning (D109) | new |

## 13. First milestone

Door to siren on the bench (D38): a sensor board reports over LoRa to a gateway board, the hub on a Mac applies the entry countdown and commands a siren board over LoRa. Arming and disarming come from a command-line tool. No apps, accounts, relay, updates or pairing; device keys are set over serial. Needs three ESP32-S3 + SX1262 868 MHz development boards. Also measures reply timing through the gateway (O10). The work is listed in [build-plan.md](../build-plan.md).

## Not in scope yet

A desktop app, a web app through the relay, a keypad or tag reader, window and motion sensors, and SMS or email alerts to outside contacts.
