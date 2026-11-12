# Door Sensor Board v1 — Requirements

Draft, rewritten after the design discussion. The same board is also the gateway and the siren controller (architecture D49); this file describes it mainly as a door sensor, and E9–E11 cover the other two uses. Software requirements are in [software.md](software.md).

Figures marked *(datasheet)* were checked against published datasheets or distributor listings. Figures marked *(estimate)* or *(from memory)* have not been verified and are listed again under [Verify before schematic](#verify-before-schematic).

## Agreed design

| Topic | Decision |
| --- | --- |
| Form | One self-contained unit on the door frame. Reed switch on the board, magnet on the door. No wired contact. |
| Chip and firmware | ESP32-S3 with ESP-IDF, running the C++ core in `firmware/core` and `firmware/roles/sensor` behind an ESP-IDF platform layer. |
| Power | Rechargeable lithium cell, 18650 size or larger, charged over USB-C. Runtime matters more than size. |
| Events and heartbeats | 868 MHz LoRa on every sensor, to a gateway on the home network. Not dependent on the user's Wi-Fi router. |
| Updates | Over Wi-Fi when the sensor is in range. Over Bluetooth from the phone app for sensors that are not. |
| Pairing | Bluetooth Low Energy from the phone app, with a per-device code the unit creates and shows on its e-paper display (E12). |
| Antenna | Spring antenna fitted on every board, plus a connector for an external antenna (E10). Sensors normally use the spring; gateways use an external antenna. |
| Versions | One version for indoor and outdoor use: weather-sealed case on every unit. |
| Button | One sealed button for wake, pairing and factory reset, under a sliding cover watched by a tamper switch. |
| Alerts | Cover tamper and sensor silence send phone notifications. Only a door-open event on an armed system sounds the siren. |
| Extras | Small buzzer, status LED, spare header. No wall-removal detection. |
| Region | Europe and UK. |

## Functional requirements

| # | Requirement | Firmware hook |
| --- | --- | --- |
| F1 | Detect door open/closed from the on-board reed switch and wake from deep sleep on either edge | `read_door_state`, `sleep_until_event` |
| F2 | Send door events and heartbeats over LoRa and wait for the hub's reply, forwarded by the gateway | new transport behind `Transport` |
| F3 | Try a fast LoRa setting first and fall back to a slow one when there is no reply | new |
| F4 | Heartbeat every few minutes by default (3 minutes proposed), editable from the app and delivered in the hub's reply | `ping_interval_ms` |
| F5 | Button: short press wakes and reports; hold about 5 s enters pairing for about 2 minutes; hold about 15 s factory-resets | new |
| F6 | While armed, a pairing hold is ignored and reported. A factory-reset hold is reported and goes ahead only if the hub does not answer (architecture D89) | new |
| F7 | Cover tamper switch wakes the sensor and reports immediately | new; not in the core yet |
| F8 | Bluetooth pairing with a per-device code; Bluetooth is off outside pairing and update sessions | replaces serial provisioning for users |
| F9 | Firmware updates with two slots, signature check and automatic rollback, over Wi-Fi or Bluetooth | new |
| F10 | Small buzzer for pairing feedback, low-battery warning, the entry countdown, and a local alarm when armed and no reply comes from the hub, which the button stops (architecture D88) | `set_local_alarm` |
| F11 | One status LED, used only for short blinks | `status_led_blinks` |
| F12 | Report battery voltage, charging state and chip temperature | `read_telemetry` |
| F13 | USB-C for charging, flashing and serial console, with no USB-UART chip | |
| F14 | Hardware watchdog, and reset and boot access for recovery | `Watchdog` |
| F15 | Spare header: 3.3 V, ground, I²C, and one wake-capable pin | |

## Radio requirements

| # | Requirement | Value |
| --- | --- | --- |
| R1 | LoRa band | 868 MHz (EU/UK) |
| R2 | LoRa transmit power | 25 mW (14 dBm) radiated, antenna gain included (spike S2) |
| R3 | LoRa airtime | within 1% per hour on the sensor channels (spike S2). A 3-minute heartbeat on the slowest setting would use about 0.8%, so the heartbeat lengthens there. Replies arrive on 869.525 MHz (architecture D104) |
| R4 | LoRa link security | per-device key, authenticated encryption, replay protection |
| R5 | Acknowledgements | door events always; heartbeats only occasionally, to keep the gateway inside its own airtime limit |
| R6 | LoRa antenna | internal 868 MHz spring antenna, kept away from the battery and the Wi-Fi antenna |
| R7 | Wi-Fi and Bluetooth | from the ESP32-S3 module's built-in antenna, with the keep-out from its datasheet |

### Expected LoRa range (estimate)

From a link-budget calculation with a spring antenna in the sensor and a whip on the gateway. Not measured.

| Path | Range |
| --- | --- |
| Open ground, clear line of sight, gateway outside or at a window | 1–3 km |
| Gardens, trees, a few buildings | 300 m – 1 km |
| Both ends indoors, several walls | 100–300 m |

## Electrical requirements

| # | Requirement | Value |
| --- | --- | --- |
| E1 | Module supply | 3.0–3.6 V *(datasheet)* |
| E2 | Battery | one lithium-ion 18650 cell (3.0–4.2 V), in an on-board holder |
| E3 | Charging | from USB-C at about 500 mA; a unit left on USB keeps the cell as backup |
| E4 | Cell protection | over-discharge, over-current, short-circuit and reversed insertion |
| E5 | Regulator peak output | at least 500 mA, to cover Wi-Fi transmit peaks of roughly 350 mA *(from memory)* |
| E6 | Whole-board deep sleep current | 30 µA or less, door closed, on battery |
| E7 | ESD protection | on the USB data lines |
| E8 | Current measurement | a jumper in series with the battery for a power profiler |
| E9 | Runs from USB with no cell fitted | the same board is the gateway and the siren controller (architecture D49) |
| E10 | Antennas | every board ships with the spring antenna fitted and also has a connector for an external whip; only one is connected to the radio at a time. Preferred: a self-switching connector that disconnects the spring when a cable is plugged in (candidates: Samtec MMCX-SW, Delta MMCX switch jack, Hirose MS-151NB; price and stock unchecked). Fallback: an electronic RF switch controlled by firmware |
| E11 | Output add-on | the spare header can drive a small add-on board that switches 12 V to a sounder, for siren use |
| E12 | Display | a bare black-and-white e-paper panel of about 1.54 inch (200×200) on a flat-cable connector, driven on the LoRa SPI bus with its own drive circuit; it is updated only at first boot and factory reset (architecture D85) |

### Sleep current budget (door closed, on battery)

| Item | Current | Basis |
| --- | --- | --- |
| ESP32-S3 module in deep sleep | 7–8 µA | *(datasheet)* "as low as 7 µA" |
| Regulator | 2–4 µA | *(datasheet)* for the candidate part |
| LoRa module asleep | 1 µA | *(from memory)* |
| E-paper controller in deep sleep, or switched off | 0–1 µA | *(from memory)* |
| Cell protection circuit | 3 µA | *(from memory)* |
| Charger leakage from the cell | 1 µA | *(from memory)* |
| Door reed pull-up, 1 MΩ | 3.3 µA | calculated |
| Cover tamper pull-up, 1 MΩ | 3.3 µA | calculated |
| Battery sense | 1 µA | allowance |
| Capacitor leakage | 2 µA | *(estimate)* |
| **Total** | **about 24–28 µA** | |

### Battery life (estimate)

Assumes a 3,000 mAh cell with 2,700 mAh usable, 20 door events a day, 25 µA asleep, and cell self-discharge of about 2% a month. A report costs about 0.003 mAh on the fast LoRa setting and 0.007 mAh on the slow one, with the ESP32-S3 awake for about 0.2 s at 40 mA. None of this is measured.

| Heartbeat | Near the gateway (fast setting) | Far from the gateway (slow setting) |
| --- | --- | --- |
| Every 3 min | about 1.7 years | about 1.2 years |
| Every 5 min | about 2 years | about 1.5 years |
| Every 15 min | about 2.4 years | about 2.1 years |

Self-discharge is the largest single drain, so a bigger cell helps less than the capacity suggests.

## Proposed pin plan

The ESP32-S3-WROOM-1 module offers 36 usable pins *(datasheet)*, and this plan uses 27. GPIO0–21 can wake the chip from deep sleep, GPIO19 and 20 are USB, and GPIO0, 3, 45 and 46 are read at power-up to choose the boot mode *(ESP-IDF documentation)*. Analogue inputs on GPIO1–10 and the console on GPIO43 and 44 are *(from memory)*.

| GPIO | Use | Why this pin |
| --- | --- | --- |
| 0 | Boot select | boot-mode pin; test pad only |
| 1 | Battery voltage sense | analogue input |
| 2 | Door reed switch | wake-capable |
| 3 | Unused | boot-mode pin |
| 4 | Button | wake-capable |
| 5 | Cover tamper switch | wake-capable |
| 6 | USB power detect | wake-capable, so plugging in wakes the sensor |
| 7 | Charger status | |
| 8, 9 | Spare header, I²C | |
| 10 | LoRa chip select | |
| 11 | LoRa data out | |
| 12 | LoRa clock | |
| 13 | LoRa data in | |
| 14 | LoRa reset | |
| 15 | LoRa busy | |
| 16 | LoRa interrupt | wake-capable, so the radio could wake the chip later |
| 17 | Buzzer | |
| 18 | Status LED | |
| 19, 20 | USB data | fixed |
| 21 | Spare header | wake-capable, for a future motion sensor |
| 43, 44 | Serial console | fixed; test pads |
| 45, 46 | Unused | boot-mode pins |
| 38 | E-paper chip select | shares the LoRa SPI clock and data lines |
| 39 | E-paper data/command | |
| 40 | E-paper reset | |
| 41 | E-paper busy | |
| 35–37, 42, 47, 48 | Free | six pins; 35–37 are only free on a module without extra memory (PSRAM) |

No boot-mode pin carries a signal, and every input that must wake the chip sits on a wake-capable pin with room to spare.

## Part classes

Specific parts are chosen at schematic stage on price and quality. Only the ESP32-S3 is fixed.

| Part | Selection criteria | Rough cost seen |
| --- | --- | --- |
| ESP32-S3 module | WROOM-1 size; 8 MB flash for two firmware slots with Wi-Fi, Bluetooth and LoRa code; no PSRAM | |
| LoRa module | SX1262 class, 868 MHz, SPI | about $4–6 |
| LoRa antenna | internal spring or helical | about €1.50 |
| 3.3 V regulator | low sleep current, 500 mA or more | |
| Charger and cell protection | low leakage from the cell | |
| 18650 holder | on-board | |
| USB-C receptacle and ESD protection | USB 2.0 type | |
| Reed switch | on-board, closed when the magnet is present | |
| Button | tactile, sealed type | |
| Cover tamper switch | small lever or tactile switch | |
| Buzzer and driver | low-current piezo | |
| Status LED | | |
| E-paper panel | bare 1.54 inch black-and-white panel, SPI, partial refresh not needed; storage range covers outdoor use | about $3–4 per panel at small quantity; the exact panel is chosen, on price, when the board is designed |
| E-paper drive circuit and connector | inductor, transistor, diodes and capacitors from the panel's reference design, plus a 24-pin flat-cable connector | |

## Mechanical and manufacturing

- Two-layer, 1.6 mm FR4, components on one side where possible, 0603 or larger passives.
- Board length is set by the 18650 holder, about 80 mm.
- Button and cover tamper switch side by side near one edge, so one sliding cover serves both.
- Reed switch at the edge that faces the door.
- The two antennas at opposite ends, both away from the cell.
- The enclosure (weather-sealed, with a sliding cover over the button) is not designed yet.

## System context

- **Gateway:** this board, powered from USB with no cell, with an external antenna, on the home network by Wi-Fi or connected to the hub computer by USB (D44, D81). A high position or a window gives the best range.
- **Siren controller:** this board, always powered, with the 12 V add-on (E11) switching a separate sounder.
- **Hub:** receives sensor traffic from the gateway. A silent sensor or an opened cover raises a phone notification, critical when armed.
- **Phone app:** pairs sensors over Bluetooth and delivers updates to sensors out of Wi-Fi range.

## Verify before schematic

Found by the component research in [hardware-notes.md](../hardware-notes.md), and to settle before drawing the board:

- **Pins 15 and 16:** the plan puts LoRa busy and interrupt on GPIO15 and GPIO16, the only pins that can take a 32 kHz crystal. Heartbeat slots (architecture D108) rely on the sleep clock, so these two signals should move and the crystal footprint be kept as an option.
- **Transmit current:** an SX1262 module matched for +22 dBm draws about 90 mA at our +14 dBm, twice what the battery estimate below assumed. At the slowest setting that alone would empty the cell in under a year. Choose the sensor's radio matching for +14 dBm, or redo the estimate.
- **Wake inputs:** on the ESP32-S3 the older wake method uses one level for all pins. The door needs to wake on both opening and closing, so the firmware uses the per-pin wake that ESP-IDF v6.1 provides; confirm it on the development boards.
- **Development hardware:** chosen in [dev-board-choice.md](../spikes/dev-board-choice.md), which also proposes a revised pin plan for this board with GPIO15 and GPIO16 freed. Firmware pins come from a per-board table.
- **Radio module:** the Seeed Wio-SX1262 used on the development hardware is also sold bare, so it is a candidate for this board. A tuned amplifier setting is reported to bring a normal SX1262 module to about 55 mA at +14 dBm (unconfirmed; to measure with the profiler).

- LoRa range at the real property, with two LoRa development boards, before anything else.
- ESP32-S3-WROOM-1 pin table: analogue input and console pin numbers, and that every GPIO in the pin plan is exposed on the module.
- Wi-Fi transmit peak current and Espressif's supply sizing guidance.
- EU and UK 868 MHz limits: power, airtime, and whether a higher-power sub-band is worth using.
- Sleep and leakage currents of the chosen regulator, charger, protection circuit and LoRa module.
- Firmware size against flash size for two update slots.
- Energy per LoRa report and per Wi-Fi update, measured with a power profiler.
- If the product is sold: radio testing for the LoRa side and shipping rules for lithium cells.

## Suggested sequence

1. Range-test LoRa at the property with the development hardware chosen in [dev-board-choice.md](../spikes/dev-board-choice.md): an Olimex ESP32-S3 board wired to a Seeed Wio-SX1262 radio. The first milestone needs three.
2. Bring up the firmware on the same boards, and measure current.
3. Specify the 12 V add-on and how the siren controller is powered (architecture O6).
4. Draw the schematic in KiCad and run the electrical rules check.
5. Lay out the board, run the design rules check, and review renders.
6. Order five assembled prototypes.

## References

- ESP32-S3-WROOM-1 datasheet: https://www.espressif.com/sites/default/files/documentation/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
- ESP-IDF GPIO reference (ESP32-S3): https://docs.espressif.com/projects/esp-idf/en/release-v5.4/esp32s3/api-reference/peripherals/gpio.html
- Ebyte E22-900M22S LoRa module: https://ebyteiot.com/products/sx1262-868mhz-module-electronic-components-22dbm-wireless-transceiver-lora-gfsk-iot-long-range-7km-ebyte-e22-900m22s-spi
- Olimex LoRa antennas: https://www.olimex.com/Products/Components/RF/ANTENNA-LoRa-U.FL-PCB-/
