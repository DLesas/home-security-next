# Development hardware choice, and the radio module for +14 dBm

Desk research, 12 November 2026. Nothing was bought or measured. It answers two questions: which development hardware to buy for four units, and which radio module suits a sensor limited to +14 dBm. It was written after reading [sensor-board.md](../requirements/sensor-board.md), [hardware-notes.md](../hardware-notes.md) sections 3, 5 and 6, and [protocol.md](../protocol.md) section 2.

## Summary

- **Buy four Olimex ESP32-S3-DevKit-LiPo boards and five Seeed "Wio-SX1262 for XIAO" radio boards** (the pin-header version), and join each pair with ten jumper wires.
- This pair meets every "must" and more "wants" than any other option: native USB on its own USB-C socket, radio pins we choose, GPIO15 and GPIO16 free for a crystal, a battery connector with a charger, open schematics, and stock in the UK and the EU today.
- The radio on that board is the Seeed Wio-SX1262 module (SX1262, TCXO, U.FL socket). It is also sold bare, 11.6 × 11 mm, so the development radio can be the radio on our own board.
- Every all-in-one board fails on something that matters. Heltec V3, V3.2, Wireless Stick Lite V3 and Wireless Paper use a USB bridge. Heltec V4 adds a power amplifier and draws 290 mA at 14 dBm. LilyGO T3-S3 and the XIAO kit leave too few wake pins or no crystal pins. RAK3312 does not bring out GPIO15 and GPIO16.
- On +14 dBm: no SX1261-based module and no SX1262 module matched for +14 dBm was found on sale for 868 MHz. A normal +22 dBm SX1262 module measured about 55 mA at +14 dBm with a tuned amplifier setting (RadioLib's own test), against Semtech's 90 mA (default setting), 45 mA (dedicated matching) and 25.5 mA (SX1261).
- Cost: about £185 for four units with accessories, about £280 with a Nordic PPK2 power profiler. Prices and stock are snapshots read on 12 November 2026.

## How to read this

Every fact carries one label.

| Label | Meaning |
| --- | --- |
| **P** | Read in the primary source: the maker's page, schematic, datasheet or own repository, at the linked address. I read the text itself, or looked at the schematic drawing. |
| **P†** | Read in the primary source, but through a tool that fetches the page and answers questions about it. I did not see the raw text. Re-read before relying on a number. |
| **S** | From a secondary source: a reseller's description, community firmware, a community measurement. |
| **U** | Could not verify. |
| **calc** | Our own arithmetic or reasoning on labelled facts. Not a maker's statement. |

Prices are as shown by the seller on 12 November 2026. "In stock" means the seller's page or data feed said so at that moment. The Pi Hut prices are as listed (the shop normally shows prices with VAT; not confirmed). DigiKey UK prices exclude VAT **(P†)**.

## Recommendation: what to buy

### Core, for four units

| # | Item | Qty | Unit price | Where | Notes | Label |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Olimex **ESP32-S3-DevKit-LiPo** (PCB antenna version) | 4 | £13.00, in stock ([The Pi Hut][ph-olimex]); €7.95, in stock ([Olimex, Bulgaria][olimex]) | UK / EU | ESP32-S3-WROOM-1-N8R8. Two USB-C sockets. Headers fitted, same pinout as the Espressif DevKitC-1. | P |
| 2 | Seeed **Wio-SX1262 for XIAO**, Seeed part 113010003 (the pin-header version) | 5 (4 + 1 spare) | £5.10, in stock ([The Pi Hut][ph-wio]); $4.99 ([Seeed][seeed-wio-hdr]); £3.73, none in stock ([DigiKey UK][dk-wio-hdr]) | UK | The radio breakout. No antenna in the pack. Do not confuse it with the connector-only board inside the XIAO ESP32S3 kit. | P, P† |
| 3 | 868 MHz antenna with U.FL plug | 4 | £4.40, in stock ([The Pi Hut, iLabs flexible antenna][ph-ant]); or €3.95 ([Olimex ANTENNA-20CM-868MHZ-U.FL][olimex-rf]); or €1.20 ([Olimex PCB antenna][olimex-ant]) | UK / EU | One per radio. Never transmit without one. | P, P† |
| 4 | SMA to U.FL pigtail | 2 | £3.10, in stock ([The Pi Hut][ph-pigtail]) | UK | For an external whip on the gateway and for the range walk. | P |
| 5 | 868 MHz SMA whip antenna | 2 | about £5 | any | Not checked at a named seller. Check SMA against RP-SMA before ordering. | U |
| 6 | Half-size breadboard | 8 | £3.00, in stock ([The Pi Hut][ph-bb]) | UK | Two per unit. The board is too wide for one breadboard (reseller's note). | P, S |
| 7 | Jumper wires: 40 male-male, 30 female-male, 20 female-female | 1 + 1 + 2 packs | £3.50, £3.50, £1.50 ([M-M][ph-jw-mm], [F-M][ph-jw-fm], [F-F][ph-jw-ff]) | UK | Both kinds, because the gender of the radio board's headers was not verified. | P |
| 8 | Magnetic door contact (reed switch and magnet) | 2 | £3.60, in stock ([The Pi Hut][ph-reed]) | UK | Enough for the sensor and the spare. | P |
| 9 | Lever micro switch with wires | 2 | £2.90, in stock ([The Pi Hut][ph-micro]) | UK | Stands in for the cover switch. | P |
| 10 | Piezo buzzer PS1240 | 4 | £1.30, in stock ([The Pi Hut][ph-piezo]) | UK | Driven straight from a pin on the bench. | P |
| 11 | DFRobot Gravity MOSFET power controller (DFR0457) | 2 | £3.50, in stock ([The Pi Hut][ph-mosfet]) | UK | The siren output. Add a 10 kΩ pull-down on the control pin. Switching from a 3.3 V pin was not verified. | P, U |
| 12 | Waveshare 1.54 inch e-paper **module**, 200 × 200, black and white | 1 (later) | £10.10, in stock ([The Pi Hut][ph-epd]) | UK | Has its own drive circuit; pins VCC, GND, DIN, CLK, CS, DC, RST, BUSY at 3.3 V ([Waveshare][ws-epd]). Our own board will use a bare panel. | P |
| 13 | 32.768 kHz crystal, 12.5 pF, through-hole, for example ECS-.327-12.5-13X | 5 | £0.18, 13,714 in stock ([DigiKey UK][dk-xtal]) | UK | Listed ESR 35 kΩ; Espressif asks for 70 kΩ or less. | P† |
| 14 | Capacitors 18 pF and 22 pF, C0G; resistors 1 MΩ and 10 kΩ | 10 each | pennies | any | Crystal load, switch pull-ups, output pull-down. | U |
| 15 | Nordic **Power Profiler Kit II** (nRF-PPK2) | 1 | £80.17 before VAT, 1,608 in stock ([DigiKey UK][dk-ppk2]) | UK | Not stocked by The Pi Hut. Mouser's page timed out. | P† |
| 16 | LiPo cell with the Olimex connector, BATTERY-LIPO1400mAh | 2 | €5.95, in stock ([Olimex][olimex-bat]) | EU | Has its own protection. Or use a USB power bank for the first range walk. | P |

Totals **(calc)**: items 1 to 14 come to about £183 at The Pi Hut and DigiKey UK prices. The profiler adds £96 with VAT. Two cells add about €12.

### Optional

| Item | Qty | Price | Why | Label |
| --- | --- | --- | --- | --- |
| Seeed XIAO ESP32S3 & Wio-SX1262 kit | 1 | £11.20, in stock ([The Pi Hut][ph-kit]); £8.14 before VAT, 310 in stock ([DigiKey UK][dk-kit]) | Same radio module, native USB, antenna included. Seeed gives 14 µA deep sleep for the XIAO board alone ([wiki][seeed-xiao-wiki]). A low-sleep reference for spike S8 and a pocket-size node for the range walk. It needs its own pin table. | P, P† |
| Semtech SX1261MB2BAS shield (SX1261, 868 MHz, +14 dBm, crystal) | 1 | £26.08 before VAT, 2 in stock ([DigiKey UK][dk-sx1261]) | The only SX1261 hardware found on sale. Lets us measure 25.5 mA against 55 mA ourselves before choosing the sensor's radio. Jumper-wire it like the Wio board. | P† |

### Why this pair

| Need | How it is met | Label |
| --- | --- | --- |
| Native USB on a socket, as on our board | One USB-C socket ("USB-OTG1") is wired to GPIO19 and GPIO20. Olimex: "USB-C connected directly to native USB of ESP32-S3". | P ([schematic][olimex-sch], [page][olimex]) |
| Console that stays up while USB is under test | The second USB-C socket goes through a CH340X bridge to GPIO43 and GPIO44. | P ([schematic][olimex-sch]) |
| Radio pins we choose | The radio is a separate board on jumper wires. | P |
| GPIO15 and GPIO16 free | Header EXT1 pins 8 and 9, side by side. Nothing else is connected to them. | P ([schematic][olimex-sch]) |
| Battery and charger | LiPo connector, BL4054B charger at 100 mA, automatic switch between USB and battery. | P ([schematic][olimex-sch]) |
| Battery and USB sensing, as in F12 | Battery divider (470 kΩ / 150 kΩ) on GPIO6. USB 5 V divider (220 kΩ / 470 kΩ) on GPIO5. Both are fixed; there is no jumper. | P ([schematic][olimex-sch]) |
| Flash size | 8 MB flash, like the module planned for our board. The 8 MB PSRAM takes GPIO35 to 37. | P ([page][olimex], [schematic][olimex-sch]) |
| Open documents | KiCad files and PDF schematic on GitHub; certified open hardware. Seeed publishes the radio board schematic and the module datasheet. | P |
| Plain ESP-IDF | It is a stock WROOM-1 module with no vendor boot loader. | calc |

Things to know before relying on it:

- **Sleep current will not match our board.** Olimex states about 200 µA in deep sleep on battery: 7 µA for the module, about 50 µA for the SY8089 regulator and 50 to 150 µA for the CH340X **(P, [page][olimex])**. Our target is 30 µA. Spike S8 on this board is indicative only, as the build plan already says. The optional XIAO kit gives a second reading.
- **GPIO47 and GPIO48 have 2.2 kΩ pull-ups to 3.3 V, and GPIO10 has 10 kΩ** (for the pUEXT connector) **(P, [schematic][olimex-sch])**. A radio line that rests low on GPIO47 or 48 would waste 1.5 mA **(calc)**. The wiring below avoids them for the radio.
- **GPIO38 drives the board's LED** (lit when low) and **GPIO0 is the user button** **(P, [schematic][olimex-sch])**.
- The Pi Hut does not say which board revision it ships. The schematic read is Rev B, dated 16 May 2023. **U**
- The Olimex battery connector has a marked polarity ("Voltage & Polarity!!!" on the schematic). Cells from other shops may be wired the other way. **P / U**

If Olimex stock runs out, the Espressif ESP32-S3-DevKitC-1 takes the same wiring, because the header pinout is the same **(P, Olimex schematic note: "fully compatible")**. It has no battery connector. See the comparison table.

## Wiring

### Pin plan with GPIO15 and GPIO16 freed

sensor-board.md is not changed by this spike. The "proposed" column is a suggestion for it. The "development board" column is what to wire now. Firmware pins come from a per-board table, so the differences cost nothing.

| Function | sensor-board.md | Proposed for our board | Olimex development board | Why the development board differs |
| --- | --- | --- | --- | --- |
| 32 kHz crystal | — (15 and 16 used by the radio) | 15, 16 | 15, 16 | |
| LoRa chip select | 10 | 10 | 10 | |
| LoRa data out (MOSI) | 11 | 11 | 11 | |
| LoRa clock | 12 | 12 | 12 | |
| LoRa data in (MISO) | 13 | 13 | 13 | |
| LoRa reset | 14 | 14 | 14 | |
| LoRa busy | 15 | 47 | 18 | 47 has a 2.2 kΩ pull-up on the Olimex board |
| LoRa interrupt (DIO1) | 16 | 48 | 21 | 48 has a 2.2 kΩ pull-up on the Olimex board |
| LoRa RF switch enable | not in the plan | 42 | 42 | New. The Wio module needs it; other modules call it RXEN |
| Door reed switch | 2 | 2 | 2 | |
| Button | 4 | 4 | 4 | |
| Cover switch | 5 | 5 | 7 | 5 carries the Olimex USB-power divider |
| USB power detect | 6 | 6 | 5 | The Olimex divider is on 5 |
| Battery voltage sense | 1 | 1 | 6 | The Olimex divider is on 6 |
| Charger status | 7 | 7 | none | Not on a pin on the Olimex board |
| Spare I²C | 8, 9 | 8, 9 | 8, 9 | |
| Buzzer | 17 | 17 | 17 | |
| Status LED | 18 | 18 | 38 | The on-board LED; lit when low |
| Siren output (spare header) | 21 | 21 | 1 | 21 is taken by DIO1 on this board |
| E-paper chip select | 38 | 38 | 47 | 38 is the LED. Chip select rests high, so the pull-up on 47 does no harm |
| E-paper data/command, reset, busy | 39, 40, 41 | 39, 40, 41 | 39, 40, 41 | |
| USB data | 19, 20 | 19, 20 | 19, 20 (socket USB-OTG1) | |
| Console | 43, 44 | 43, 44 | 43, 44 (socket USB-UART1) | |

Notes on the proposal:

- GPIO47 and GPIO48 cannot wake the chip from deep sleep. Only GPIO0 to 21 can **(P, [hardware notes][hn] section 6)**. sensor-board.md wanted the radio interrupt on a wake-capable pin "so the radio could wake the chip later". In light sleep any pin can wake the chip **(P, [hardware notes][hn] section 6)**, and a battery sensor cannot leave the radio listening in deep sleep (4.6 mA) **(calc)**. If deep-sleep wake from the radio is still wanted, put DIO1 on GPIO21 and give up the spare wake pin.
- The power-up behaviour of GPIO21 and GPIO1 as outputs was not checked beyond what hardware-notes section 5 records. Keep the pull-down on the siren output. **U**

### Radio board to development board

Pin numbers are from Seeed's schematic for the pin-header board **(P, [schematic][seeed-wio-hdr-sch])**. Pin 1 of J1 is the net "D0", which goes to the small button on the radio board. Find it with a continuity test before wiring.

| Radio board pin | Net | ESP32-S3 GPIO | Olimex header pin | Note |
| --- | --- | --- | --- | --- |
| J2-3 | +3V3 | — | EXT1-1 (+3.3V) | The module takes up to 125 mA at +22 dBm ([datasheet][seeed-wio-ds]); the Olimex rail gives 600 mA |
| J2-2 | GND | — | EXT1-22 (GND) | |
| J2-1 | VIN | not connected | — | Goes to nothing on the radio board |
| J2-6 | LORA_SPI_SCK | 12 | EXT1-18 | |
| J2-4 | LORA_SPI_MOSI | 11 | EXT1-17 | |
| J2-5 | LORA_SPI_MISO | 13 | EXT1-19 | |
| J1-5 | LORA_SPI_NSS | 10 | EXT1-16 | |
| J1-3 | LORA_RST | 14 | EXT1-20 | 10 kΩ pull-up on the radio board |
| J1-4 | LORA_BUSY | 18 | EXT1-11 | |
| J1-2 | LORA_DIO1 | 21 | EXT2-18 | |
| J1-6 | LORA_RF_SW1 | 42 | EXT2-6 | Drive high while the radio is awake, low for sleep (see below) |
| J1-1 | D0 (button, 10 kΩ pull-up, pressed = low) | 4 | EXT1-4 | Optional. It can be the sensor's button |
| J1-7, J2-7 | not connected | — | — | |

Radio settings that follow from the module:

| Setting | Value | Label |
| --- | --- | --- |
| TCXO | Powered from DIO3 inside the module. Seeed gives a supply range of 1.7 to 3.3 V and says to keep it 200 mV below VCC. | P ([datasheet][seeed-wio-ds]) |
| TCXO voltage to program | 1.8 V. This is what Meshtastic uses for the same module. Seeed does not name one value. | S ([Meshtastic][mesh-xiao]) |
| Transmit/receive switch | DIO2 inside the module: "DIO2 HIGH = transmit mode; DIO2 LOW = receive mode". Use `SetDIO2AsRfSwitchCtrl`. | P ([datasheet][seeed-wio-ds]) |
| RF_SW pin | "External IO control internal gate RF switch". Meshtastic treats it as a receive-enable line. The level needed in sleep was not found. | P ([datasheet][seeed-wio-ds]), S, U |
| Sleep current | 1.62 µA | P ([datasheet][seeed-wio-ds]) |
| SPI lines | 22 Ω series resistors on clock, data and chip select | P ([schematic][seeed-wio-hdr-sch]) |

### Other parts

| Part | Connect | Note |
| --- | --- | --- |
| Door contact | GPIO2 to GND, with 1 MΩ from GPIO2 to 3.3 V | The value in the sleep budget. The internal pull-up would hide the real current |
| Cover switch | GPIO7 to GND, with 1 MΩ to 3.3 V | |
| Buzzer | GPIO17 to GND | |
| MOSFET module | Control pin to GPIO1, with 10 kΩ to GND | Siren role |
| Crystal | Across EXT1-8 (GPIO15) and EXT1-9 (GPIO16), one capacitor from each pin to GND | Solder the three parts onto a 2-pin socket and push it onto the header. Do not use breadboard rows |
| E-paper module | CLK to 12, DIN to 11, CS to 47, DC to 39, RST to 40, BUSY to 41, VCC to 3.3 V | Shares the radio's SPI bus, as on our board |
| PPK2 | Source mode into the LiPo connector, 3.7 to 4.2 V | Measures the whole board |

Crystal values: Espressif asks for ESR of 70 kΩ or less and load capacitors "according to the crystal's specification"; the bias resistor is normally left out **(P, [design guidelines][s3-hw])**. For a 12.5 pF crystal start with 18 pF on each side **(calc)**. Stray capacitance on a hand-built adapter will pull the frequency by some parts per million. That is still far better than the internal RC clock.

### Are jumper wires good enough?

| Fact | Label |
| --- | --- |
| The SX1262's SPI runs "up to 16MHz"; minimum clock period 62.5 ns. | P ([datasheet][sx-ds] section 8.2 and Table 8-1) |
| RadioLib's ESP-IDF layer defaults to 2 MHz. | P ([EspHal.h][rl-esphal-h]) |
| The radio board has 22 Ω series resistors on the SPI lines. | P ([schematic][seeed-wio-hdr-sch]) |
| The antenna signal never touches a jumper wire. It stays on the module and its U.FL socket. | P ([datasheet][seeed-wio-ds]) |
| At 1 to 2 MHz, 10 to 15 cm wires with a ground wire alongside are within normal practice. Keep them short and do not raise the clock. Not measured. | calc / U |

## Comparison of candidates

### Must-haves

| Candidate | ESP32-S3 | SX1262, 868 MHz | Native USB on a socket | Antenna connector | Schematic and pin map | Plain ESP-IDF | Buyable now, EU or UK |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Olimex ESP32-S3-DevKit-LiPo + Wio-SX1262 for XIAO** | WROOM-1-N8R8 **P** | Yes, 862–930 MHz **P** | Yes, own USB-C socket **P** | U.FL on the module **P** | Both published **P** | Yes **calc** | Yes. £13.00 + £5.10, both in stock **P** |
| Espressif ESP32-S3-DevKitC-1 + the same radio board | WROOM-1. N8 and N8R2 are end of life; N16R8 is current **P** ([guide][devkitc-ug]) | Yes **P** | Yes, own Micro-USB socket **P** ([guide][devkitc-ug]) | U.FL on the module **P** | Published **P** | Yes | Unclear. The Pi Hut: £30.30, out of stock **P**. DigiKey UK: N8R8 at £11.21, stock not readable; N8 and N8R2 obsolete **P†** |
| Seeed XIAO ESP32S3 + Wio-SX1262 kit | ESP32-S3R8, 8 MB flash **P†** | Yes **P** | Yes, the only socket; no bridge chip on the schematic **P** ([schematic][seeed-xiao-sch]) | U.FL **P†** | Published **P** | Yes **calc** | Yes. £11.20 in stock **P**; £8.14, 310 in stock **P†** |
| LilyGO T3-S3, SX1262 868 MHz | ESP32-S3FH4R2, 4 MB flash **P** ([doc][t3s3-hw]) | Yes **P** | Yes; USB-C lines go to the chip, no bridge on the schematic **P** ([schematic][t3s3-sch]) | SMA; LilyGO shows how to switch it to U.FL **P** | Published **P** | Yes **calc** | From China: $17.12, available. German warehouse: $21.62, not available **P** ([shop][t3s3-shop]) |
| LilyGO T3-S3 E-Paper, SX1262 868 MHz | ESP32-S3FH4R2, 4 MB **P†** ([wiki][t3s3-ep-wiki]) | Yes **P†** | Probably; the setting is "Hardware CDC and JTAG" **P†** | Not stated **U** | Schematic linked, not opened **U** | Yes **calc** | $23.61, available; origin not read **P** ([shop][t3s3-ep-shop]) |
| Heltec WiFi LoRa 32 V3 and V3.2 | ESP32-S3FN8 **P** ([hardware notes][hn]) | Yes | **No.** CP2102 bridge; USB pins only on the header **P** ([hardware notes][hn] section 5) | U.FL | Published | Yes | Not re-checked |
| Heltec WiFi LoRa 32 V4 | ESP32-S3R2 + 16 MB flash **P** ([datasheet][ht-v4-ds]) | Yes, 863–928 MHz **P** | Yes. Type-C data lines go to GPIO19 and 20 through 22 Ω; no bridge chip on the V4.3 sheet **P** ([schematic][ht-v4-sch]) | U.FL (IPEX 1.0) **P** | Published **P** | Yes **calc** | $17.90–27.50 at Heltec **P†**; EU stock not checked **U** |
| Heltec Wireless Paper | ESP32-S3FN8 **P†** ([page][ht-paper]) | Yes | **No.** "Onboard USB-UART bridge" **P†** | Not stated | Published | Yes | $19.90 **P†** |
| Heltec Wireless Stick Lite V3 | ESP32-S3FN8, 8 MB **P†** ([page][ht-wsl]) | Yes | **No.** "Integrated CP2102 USB to serial port chip" **P†** | U.FL **P†** | Published | Yes | $14.90 **P†** |
| RAKwireless RAK3312 + a WisBlock base | ESP32-S3, 16 MB flash, 8 MB PSRAM **P†** ([datasheet][rak3312]) | Yes ("H" version) **P†** | USB lines (GPIO19/20) go to the base board's socket; not stated in words **P† / U** | MHF4 (smaller than U.FL) **P†** | Pin tables yes; schematic is a picture only **P†** | Yes **calc** | $15.00 for the core, available **P** ([shop][rak-shop]); base board extra, price not read |
| DFRobot LoRaWAN ESP32-S3 board (DFR1195) | WROOM-1-N4, 4 MB **P** ([wiki][dfr1195]) | Yes, 850–930 MHz **P** | Not read **U** | U.FL **P** | Published | Yes | Not read **U** |

### Wants

| Candidate | Radio pins | GPIO15/16 free | TCXO and voltage | Module usable on our board | Battery and charger | Free pins | Deep sleep | Price per unit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Olimex + Wio board** | Ours to choose **P** | Yes **P** | Yes; 1.7–3.3 V range **P**, 1.8 V in use **S** | Yes, the same Wio-SX1262 **P** | Connector, 100 mA charger **P** | 1, 2, 4, 7, 8, 9, 10–18, 21, 39–42, 43, 44 free. 47 and 48 have pull-ups. 0 button, 5 and 6 dividers, 38 LED, 35–37 PSRAM, 3, 45, 46 boot pins **P** | About 200 µA; maker names the regulator and the USB bridge **P** | About £22.50 with antenna **calc** |
| DevKitC-1 + Wio board | Ours **P** | Yes; header J1 pins 8 and 9 **P** | Same module | Yes | None **P** | As above, plus 5, 6, 47, 48. 38 (v1.1) or 48 (v1.0) is the RGB LED **P** | Not published **U**. The sheet has a power LED, a CP2102N and an SGM2212 regulator **P** ([schematic][devkitc-sch]) | About £21, with the board price before VAT **calc** |
| XIAO ESP32S3 kit | Fixed: clock 7, MISO 8, MOSI 9, chip select 41, reset 42, DIO1 39, busy 40, switch 38 **S** ([Meshtastic][mesh-xiao]) | **No.** They are on the board-to-board connector, under the radio board **P** ([schematic][seeed-wio-b2b-sch]) | Same module | Yes | Pads and a 110 mA charger **P** ([schematic][seeed-xiao-sch]) | 1, 2, 3, 4, 5, 6, 43, 44 only **P†**. Three switches, buzzer and output fit. An e-paper then takes every remaining pin, console included **calc** | 14 µA for the XIAO alone **P†**; with the radio board, not stated **U** | £11.20 |
| LilyGO T3-S3 | Fixed: clock 5, MISO 3 (a boot pin), MOSI 6, chip select 7, reset 8, DIO1 33, busy 34 **P** | Yes, on the header; no crystal fitted **P** (schematic drawing, small print) | Not stated by LilyGO **U**; 1.8 V **S** ([Meshtastic][mesh-t3s3]) | Not identified **U** | 2 mm connector, 500 mA charger, no cell protection **P** | Header: 12, 15, 16, 35, 36, 38–42, 45–48, 43, 44. Wake-capable: only 12, 15, 16. With a crystal fitted, one wake pin is left for three switches **calc** | Not published **U** | $17.12 |
| LilyGO T3-S3 E-Paper | Fixed, as T3-S3 **P†** | **No.** E-paper chip select and data/command use them **P†** | Not stated **U** | — | Connector **P†** | Not listed **U** | Not published **U** | $23.61. Display is 2.13 inch, not 1.54 |
| Heltec V3 / V3.2 | Fixed, 8–14, not on headers **P** ([hardware notes][hn]) | No; a crystal is fitted **P** | Yes; 1.8 V **S** | — | Yes | See hardware-notes section 5 | 15 µA on battery, Heltec's figure **P** | Not re-checked |
| Heltec V4 | Fixed, 8–14, not on headers **P** | On two small pads, no crystal fitted **P** (schematic drawing) | 32 MHz oscillator fed from DIO3 **P**; voltage **U** | **No.** A KCT8103L amplifier sits behind the SX1262 **P** | Connector, about 540 mA charger, solar input **P** | Wake-capable on headers: 3 (boot pin), 4, 6, and 5 unless the revision uses it for the amplifier. GPIO2 and 7 control the amplifier **P** | Under 20 µA **P**. But 290 mA at 14 dBm on USB **P** ([datasheet][ht-v4-ds]) | $17.90–27.50 |
| Heltec Wireless Paper | Fixed **U** | **U** | **U** | — | Connector **P†** | **U** | 20 µA **P†** | $19.90. Display is 2.13 inch |
| Heltec Wireless Stick Lite V3 | Fixed, as V3 **S** | **U** | **U** | — | Connector **P†** | **U** | Page says "≤800uA" **P†**; a user reached 14–16 µA **S** ([hardware notes][hn]) | $14.90 |
| RAK3312 | Fixed: chip select 7, clock 5, MOSI 6, MISO 3, reset 8, busy 48, DIO1 47, switch power 4 **P†** | **No.** Not on the connector **P†** | Not stated **U** | — | On the base board | Through the base board only | 8–9 µA for the core **P†**; 112 mA at +14 dBm **P†** | $15.00 + base |
| DFRobot DFR1195 | Fixed: MISO 5, MOSI 6, clock 7, chip select 10, busy 40, reset 41, RXEN 42, DIO1 4 **P** | **No.** The screen uses them **P** | **U** | — | Connector, 300 mA **P** | 2, 3, 8, 9, 11–13, 43, 44 **P** | Not read **U** | Not read |

Verdicts **(calc)**:

- **XIAO kit**: passes every must and is the cheapest. It cannot take a crystal and has no pin to spare. Good as a second, small unit; not as the main bench.
- **LilyGO T3-S3**: passes every must. With a crystal on 15 and 16 it has one wake pin left on its headers, and the radio's MISO sits on a boot pin. Its 4 MB flash cannot hold the two-slot layout planned for 8 MB. EU stock was empty today.
- **Heltec V4**: the USB problem of the V3 is fixed. The added amplifier makes its transmit current and RF path unlike our board, and 28 dBm is above the 25 mW our sensors may radiate.
- **Heltec V3, V3.2, Wireless Stick Lite V3, Wireless Paper**: fail the USB must.
- **RAK3312, DFR1195, T3-S3 E-Paper**: no access to GPIO15 and GPIO16.
- **Waveshare, Elecrow, M5Stack**: no all-in-one ESP32-S3 + SX1262 868 MHz board from these makers turned up in the searches. M5Stack's 868 MHz LoRa module v1.2 is marked end of life **(S, search result)**. Their catalogues were not read page by page. **U**

### Radio boards and modules that could sit on jumper wires

| Board | Radio | Signals brought out | Connector | Antenna | Price, stock | Label |
| --- | --- | --- | --- | --- | --- | --- |
| **Seeed Wio-SX1262 for XIAO (113010003)** | Wio-SX1262: SX1262, TCXO on DIO3, switch on DIO2 | NSS, SCK, MOSI, MISO, RST, BUSY, DIO1, RF_SW, 3.3 V, GND, plus a button | Two 7-pin rows, 2.54 mm. Seeed: "Pin headers … no soldering needed" | U.FL | £5.10, in stock (The Pi Hut) | P ([schematic][seeed-wio-hdr-sch]), P† ([page][seeed-wio-hdr]) |
| Seeed Wio-SX1262 board inside the XIAO ESP32S3 kit | Same module | Same signals on a 30-pin board-to-board connector, and on two unpopulated 7-pin rows in a different order (J1: DIO1, BUSY, RST, NSS, RF_SW) | Board-to-board | U.FL | Only in the kit | P ([schematic][seeed-wio-b2b-sch]) |
| Waveshare Core1262-HF | SX1262, 32 MHz TCXO on DIO3, RF switch with TXEN and RXEN | ANT, RXEN, TXEN, DIO2, DIO1, CS, CLK, MOSI, MISO, RESET, BUSY, 3.3 V, GND | "castellated edge / solder holes, pitch 2.54mm", 19 × 22 mm; headers must be soldered on | U.FL or edge pad | $7.99 at Waveshare; not listed at The Pi Hut | P ([wiki][ws-core1262], [schematic][ws-core1262-sch]), P† ([shop][ws-core1262-shop]) |
| Waveshare Pico-LoRa-SX1262-868M | SX1262 | On Raspberry Pi Pico positions: BUSY GP2, CS GP3, CLK GP10, MOSI GP11, MISO GP12, RESET GP15, DIO1 GP20 | Pico sockets; also has a battery connector and charger | Not read | £14.00, in stock (The Pi Hut) | P ([wiki][ws-pico-lora], [shop][ph-pico-lora]) |
| Ebyte E22-900M22S | SX1262, TCXO, 850–930 MHz, 22 dBm, 14 × 20 mm | Pin list, pitch and TCXO voltage not readable on the maker's page | Solder-edge module. No Ebyte breakout with 2.54 mm pins was found | Not read | Not read | P† ([page][ebyte]), U |
| Heltec HT-RA62 | SX1262 | Pin list is a picture only | "1.27 spacing Stamp hole" | U.FL | $3.90 | P† ([page][ht-ra62]) |
| M5Stack Stamp LoRa-1262 | SX1262, 868–923 MHz, +22 dBm | SPI | 12-pin 0.5 mm flat-cable connector | IPEX-4 (smaller than U.FL) | £5.40, in stock (The Pi Hut) | S ([reseller page][ph-m5stamp]) |
| Semtech SX1261MB2BAS | **SX1261**, 868 MHz, +14 dBm, crystal | Arduino-style shield pins | Shield headers | Not read | £26.08, 2 in stock (DigiKey UK) | P† ([Semtech][sx1261mb2bas]), P ([shield list][smtc-shields]) |

The Waveshare wiki gives "Emitting current: 45mA@14dBm" for the Core1262 **(P, [wiki][ws-core1262])**. That is the same number as the datasheet's dedicated-matching row. The same page claims +22 dBm, and the datasheet says the +14 dBm settings make full power "sub-optimal or unachievable". Treat the 45 mA as copied, not measured. **calc**

## The radio module for +14 dBm

### What the datasheets say

SX1261/2 datasheet, Rev 2.2, December 2024, Table 3-6, 868/915 MHz **(P, [datasheet][sx-ds])**. This confirms the earlier research.

| Chip | Matching network | Output | Typical current |
| --- | --- | --- | --- |
| SX1261 | +14 dBm | +14 dBm, 3.3 V | 25.5 mA |
| SX1261 | +14 dBm | +10 dBm, 3.3 V | 18 mA |
| SX1261 | +14 dBm | +14 dBm, 1.8 V | 48 mA |
| SX1261 | "+14dBm / optimal settings" | +15 dBm, 3.3 V | 32.5 mA |
| SX1261 | "+14dBm / optimal settings" | +10 dBm, 3.3 V | 15 mA |
| SX1262 | +22 dBm | +22 dBm | 118 mA |
| SX1262 | +22 dBm | +20 dBm | 102 mA |
| SX1262 | +22 dBm | +17 dBm | 95 mA |
| SX1262 | +22 dBm | +14 dBm | 90 mA |
| SX1262 | "+20dBm / optimal settings" | +20 dBm | 84 mA |
| SX1262 | "+17dBm / optimal settings" | +17 dBm | 58 mA |
| SX1262 | "+14dBm / optimal settings" | +14 dBm | 45 mA |

- The SX1261 figures use the DC-DC converter for the whole chip. On the SX1262 the amplifier runs from the battery. **P**, Table 3-6 notes 1 and 3.
- The "optimal settings" need two things: "a dedicated matching / PA load impedance" and the `SetPaConfig` values of Table 13-21. For the SX1262 at +14 dBm: `paDutyCycle` 0x02, `hpMax` 0x02, `SetTxParams` +22. For the SX1261 at +14 dBm: `paDutyCycle` 0x04, `SetTxParams` +14. **P**, section 13.1.14.1.
- "These changes make the use of nominal power either sub-optimal or unachievable." A module matched for +14 dBm is not a +22 dBm module. **P**, Table 13-21 note.
- The SX1261 and SX1262 share one datasheet, one 24-pin package and one pin table (Table 2-1). One board-level link differs: pin 1 (VDD_IN) goes to pin 7 on the SX1261 and to pin 10 on the SX1262. **P**

### What a normal +22 dBm module does at +14 dBm

The datasheet does not say what a +22 dBm board draws when only the `SetPaConfig` values are tuned. Two sources fill the gap.

| Source | Finding | Label |
| --- | --- | --- |
| Semtech's own reference code for its +22 dBm SX1262 shields | Uses a different `SetPaConfig` for every output power. For +14 dBm: `power` 22, `pa_duty_cycle` 0x03, `hp_max` 0x02. So Semtech tunes the amplifier on the standard matching too. It gives no current for this setting; its current table still lists 89.3 mA at +14 dBm. | P ([table][lbm-pa], [code][lbm-bsp]) |
| RadioLib's power tests, December 2025: one SX1262 on a test board at 3.31 V, RF power read on a Rohde & Schwarz analyser, current on an INA219, ten readings per step | Set to 14 dBm with the usual fixed setting: 13.9 dBm out, 77.9 mA. With the tuned table: 14.1 dBm out, 55.3 mA. At 22 dBm both give 21.2 dBm and 126.9 mA. Which module was tested is not stated. | S ([log][pt-log], [method][pt]); averages are **calc** |
| RadioLib 8.0.0 | `SX1262::setOutputPower(power)` uses the tuned table by default. The entry for +14 dBm is `paDutyCycle` 1, `hpMax` 4, `SetTxParams` 20. | P ([SX1262.cpp][rl-sx1262]) |

So the four numbers to compare at +14 dBm are 90 mA (datasheet, default setting), about 55 mA (measured by RadioLib, tuned setting, normal module), 45 mA (datasheet, dedicated matching) and 25.5 mA (SX1261).

What that means per sensor report, transmit only, 25 bytes **(calc, airtime from [protocol.md](../protocol.md))**:

| Transmit current | SF7 (62 ms) | SF10 (412 ms) | SF12 (1,483 ms) |
| --- | --- | --- | --- |
| 90 mA | 1.6 µAh | 10.3 µAh | 37.1 µAh |
| 55 mA | 0.9 µAh | 6.3 µAh | 22.7 µAh |
| 45 mA | 0.8 µAh | 5.2 µAh | 18.5 µAh |
| 25.5 mA | 0.4 µAh | 2.9 µAh | 10.5 µAh |

Moving from a tuned normal module to a +14 dBm-matched SX1262 saves about 1 µAh per report at SF10. Moving to an SX1261 saves about 3.4 µAh. sensor-board.md budgets 7 µAh for a slow report.

### Modules on sale

| Kind | Found | Label |
| --- | --- | --- |
| SX1261-based SPI module, 868 MHz | None from the makers searched (Ebyte, NiceRF, Dorji, HopeRF, Lierda, Seeed, Waveshare, Heltec). Searches returned only SX1262 parts under those names. Absence is not proven. | U |
| SX1261 on a board | Semtech SX1261MB2BAS: 868 MHz, +14 dBm, crystal, shield format, £26.08, 2 in stock at DigiKey UK. An evaluation board, not a module for a product. | P† ([Semtech][sx1261mb2bas], [DigiKey][dk-sx1261]) |
| SX1262 module matched for +14 or +15 dBm | None found. | U |
| A site listing "sx1262/LLCC68/SX1261" modules at 22 and 33 dBm (Coral RF) | Seen in search results only; not opened. | S |
| +22 dBm SX1262 modules with a TCXO | Seeed Wio-SX1262: 11.6 × 11 × 2.95 mm, 12 pads, U.FL, sleep 1.62 µA, 125 mA at +22 dBm; £4.45 for one, £3.63 at 1,000, none in stock at DigiKey UK, 1,000 expected 18 January 2027. | P ([datasheet][seeed-wio-ds]), P† ([DigiKey][dk-wio-mod]) |
| | Ebyte E22-900M22S: 14 × 20 mm, 850–930 MHz. Price, pins and TCXO voltage not read. | P† ([page][ebyte]) |
| | Waveshare Core1262-HF: 19 × 22 mm, $7.99. Heltec HT-RA62: $3.90, 1.27 mm pads. | P, P† |
| | NiceRF LoRa1262, Dorji DRF1262T, Elecrow LR1262: named in search results, pages not opened. | S |

### Can one board take either?

| Route | Finding | Label |
| --- | --- | --- |
| Two modules with one footprint | No pair found: no low-power module exists to share a footprint with. | U |
| Chip on our own board | Possible. Semtech's shield PCB E449V01A carries an SX1261 (SX1261MB1CAS) and an SX1262 (SX1262MB1CBS, MB1DAS, MB1PAS). Same package, different matching parts, and the pin 1 link noted above. | P ([shield list][smtc-shields], [datasheet][sx-ds]) |
| | The cost is our own RF layout, matching and radio testing, which a certified module avoids. | calc |
| A different chip: Semtech LR1121 | It has both amplifiers in one chip: low-power path +14 dBm at 28 mA, high-power path +22 dBm at 118 mA, and +14 dBm on the high-power path at 50 mA. Semtech: "Integrated PA regulator supply selector to simplify dual power +15/+22dBm with a single board implementation". | P, read on a copy hosted by Waveshare ([datasheet Rev 2.0][lr1121-ds]) |
| | It is not an SX1262. It has its own command set, so the radio driver changes. LilyGO sells the T3-S3 with an LR1121. Whether a given LR1121 module wires both amplifier outputs was not checked. | P ([LilyGO docs][t3s3-lr1121]), U |

### What we suggest

- **Keep one +22 dBm SX1262 module on every board.** Use the tuned amplifier settings on the sensor. Measure the Wio-SX1262 at +14 dBm with the PPK2 as the first job of spike S8, and replace the 90 mA in the battery estimate with the result. **calc**
- **The development hardware uses the same module family** as this suggestion: the Wio-SX1262 on the breakout is the bare Wio-SX1262 part. **P**
- **Go to an SX1261 only if the measured battery life needs it.** That means a chip-down radio on our board, or an LR1121 module. The optional SX1261 shield shows what would be gained before committing. **calc**
- **The gateway keeps +22 dBm either way.** Replies on 869.525 MHz use it (protocol.md section 2).

## What could not be verified

| Item | Why | What to do |
| --- | --- | --- |
| Whether the Wio-SX1262 for XIAO arrives with headers soldered, and their gender | Seeed says "no soldering needed"; no drawing was read | Order both kinds of jumper wire |
| Physical position of J1 pin 1 on the radio board | Read from the schematic, not from the board | Continuity test from the button |
| RF_SW level needed in sleep, and the right TCXO voltage | Seeed gives a range, not a value; 1.8 V is from Meshtastic | Start at 1.8 V; check for `XOSC_START_ERR`; test receive with RF_SW low |
| Transmit current of the Wio-SX1262 at +14 dBm | No maker figure. The 55 mA is one community test on an unnamed module | Measure |
| Sleep current of the chosen pair | Olimex's 200 µA is for the bare board | Measure |
| Deep-sleep current of the DevKitC-1, the T3-S3 and the XIAO with its radio board | Not published | Measure if bought |
| Olimex board revision sold by The Pi Hut; fit of other makers' cells | Not stated | Check on arrival; buy Olimex cells |
| Stock of the Espressif DevKitC-1 at UK distributors | DigiKey's list showed no quantities; Mouser timed out twice; Farnell not tried | Check by hand if the Olimex board is not wanted |
| EU and UK stock of Heltec V4, T3-S3 E-Paper, RAK3312, DFR1195 | Only the makers' own shops were read | Not needed unless the choice changes |
| Ebyte E22-900M22S pins, TCXO voltage, sleep current, price, and any 2.54 mm breakout | The maker's page shows these on tabs the tool could not read. Still open from hardware-notes | Read the manual by hand before choosing the module for our board |
| An SX1261 module or a +14 dBm SX1262 module existing somewhere | Searches cannot prove absence | Ask Ebyte, NiceRF and Seeed sales if the SX1261 route is taken |
| Waveshare, Elecrow and M5Stack all-in-one boards | Searched, not browsed | Low value |
| T3-S3 header pin list | Read from a schematic drawing in small print | Check LilyGO's pin picture before buying |
| Heltec V3 prices; Wireless Paper and Wireless Stick Lite V3 schematics | Not opened; they already fail on USB | None |
| The DFRobot MOSFET module switching from a 3.3 V pin | Its page was not read in full | Test, or pick any logic-level MOSFET module |
| Jumper-wire SPI at 2 MHz | Reasoned, not measured | Watch for SPI errors; shorten wires |
| Facts marked P† | Read through a page-extraction tool | Re-read the page before a decision rests on one |

## Sources

Read on 12 November 2026.

[hn]: ../hardware-notes.md
[sx-ds]: https://semtech.my.salesforce.com/sfc/p/E0000000JelG/a/RQ000008nKCH/hp2iKwMDKWl34g1D3LBf_zC7TGBRIo2ff5LMnS8r19s
[sx1261mb2bas]: https://www.semtech.com/products/wireless-rf/lora-connect/sx1261mb2bas
[smtc-shields]: https://github.com/Lora-net/SWSD003/blob/master/libs/smtc-shields/sx126x/README.md
[lbm-pa]: https://github.com/Lora-net/SWL2001/blob/master/lbm_examples/radio_hal/sx126x_pa_pwr_cfg.h
[lbm-bsp]: https://github.com/Lora-net/SWL2001/blob/master/lbm_examples/radio_hal/ral_sx126x_bsp.c
[lr1121-ds]: https://files.waveshare.com/wiki/Core1121/LR1121_H2_DS_v2_0.pdf
[rl-sx1262]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX1262.cpp
[rl-esphal-h]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/hal/ESP-IDF/EspHal.h
[pt]: https://github.com/radiolib-org/power-tests
[pt-log]: https://github.com/radiolib-org/power-tests/blob/main/logs/compare_sx1262/rlb_2025_12_14_084954.log
[olimex]: https://www.olimex.com/Products/IoT/ESP32-S3/ESP32-S3-DevKit-Lipo/open-source-hardware
[olimex-sch]: https://github.com/OLIMEX/ESP32-S3-DevKit-LiPo/blob/main/HARDWARE/ESP32-S3-DevKit-LiPo_Rev_B/ESP32-S3-DevKit-LiPo_Rev_B.pdf
[olimex-bat]: https://www.olimex.com/Products/Power/Lipo-battery/BATTERY-LIPO1400mAh/
[olimex-rf]: https://www.olimex.com/Products/Components/RF/
[olimex-ant]: https://www.olimex.com/Products/Components/RF/ANTENNA-LoRa-U.FL-PCB-/
[seeed-wio-hdr]: https://www.seeedstudio.com/Wio-SX1262-for-XIAO-p-6379.html
[seeed-wio-hdr-sch]: https://files.seeedstudio.com/products/SenseCAP/Wio_SX1262/Wio-SX1262%20for%20XIAO%20V1.0_SCH.pdf
[seeed-wio-b2b-sch]: https://files.seeedstudio.com/products/SenseCAP/Wio_SX1262/Schematic_Diagram_Wio-SX1262_for_XIAO.pdf
[seeed-wio-ds]: https://files.seeedstudio.com/products/SenseCAP/Wio_SX1262/Wio-SX1262_Module_Datasheet.pdf
[seeed-xiao-wiki]: https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/
[seeed-xiao-sch]: https://files.seeedstudio.com/wiki/SeeedStudio-XIAO-ESP32S3/new-res/202003751_XIAO%20ESP32S3_v1.4_SCH_260226.pdf.pdf
[mesh-xiao]: https://github.com/meshtastic/firmware/blob/master/variants/esp32s3/seeed_xiao_s3/variant.h
[mesh-t3s3]: https://github.com/meshtastic/firmware/blob/master/variants/esp32s3/tlora_t3s3_v1/variant.h
[devkitc-ug]: https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html
[devkitc-sch]: https://dl.espressif.com/dl/schematics/SCH_ESP32-S3-DevKitC-1_V1.1_20221130.pdf
[s3-hw]: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32s3/schematic-checklist.html
[t3s3-hw]: https://github.com/Xinyuan-LilyGO/LilyGo-LoRa-Series/blob/master/docs/en/t3_s3_sx1262/t3_s3_sx1262_hw.md
[t3s3-sch]: https://github.com/Xinyuan-LilyGO/LilyGo-LoRa-Series/blob/master/schematic/T3_S3_V1.3.pdf
[t3s3-lr1121]: https://github.com/Xinyuan-LilyGO/LilyGo-LoRa-Series/tree/master/docs/en/t3_s3_lr1121
[t3s3-shop]: https://lilygo.cc/products/t3s3-v1-0
[t3s3-ep-wiki]: https://wiki.lilygo.cc/products/t3-series/t3-s3-e-paper/
[t3s3-ep-shop]: https://lilygo.cc/products/ts-s3-epaper
[ht-v4-ds]: https://resource.heltec.cn/download/WiFi_LoRa_32_V4/datasheet/WiFi_LoRa_32_V4.3.1_Datasheet.pdf
[ht-v4-sch]: https://resource.heltec.cn/download/WiFi_LoRa_32_V4/Schematic/HTIT-WB32LAF_V4.3.pdf
[ht-paper]: https://heltec.org/project/wireless-paper/
[ht-wsl]: https://heltec.org/project/wireless-stick-lite-v2/
[ht-ra62]: https://heltec.org/project/ht-ra62/
[rak3312]: https://docs.rakwireless.com/product-categories/wisblock/rak3312/datasheet/
[rak-shop]: https://store.rakwireless.com/products/wisblock-core-module-rak3312-lora-wifi-ble
[dfr1195]: https://wiki.dfrobot.com/dfr1195/
[ws-core1262]: https://www.waveshare.com/wiki/Core1262-868M
[ws-core1262-sch]: https://files.waveshare.com/upload/c/c1/CoreSX1262_Sch.pdf
[ws-core1262-shop]: https://www.waveshare.com/core1262-868m.htm
[ws-pico-lora]: https://www.waveshare.com/wiki/Pico-LoRa-SX1262
[ws-epd]: https://www.waveshare.com/wiki/1.54inch_e-Paper_Module_Manual
[ebyte]: https://www.cdebyte.com/products/E22-900M22S
[ph-olimex]: https://thepihut.com/products/olimex-esp32-s3-devkit-lipo-development-board
[ph-wio]: https://thepihut.com/products/wio-sx1262-for-xiao
[ph-kit]: https://thepihut.com/products/xiao-esp32s3-wio-sx1262-kit-for-meshtastic-lora
[ph-pico-lora]: https://thepihut.com/products/sx1262-868mhz-lora-node-module-for-raspberry-pi-pico
[ph-m5stamp]: https://thepihut.com/products/m5stamp-lora-module-sx1262
[ph-epd]: https://thepihut.com/products/eink-display-module-spi-1-54-200x200
[ph-ant]: https://thepihut.com/products/868-915mhz-flexible-ism-band-antenna
[ph-pigtail]: https://thepihut.com/products/interface-cable-sma-to-u-fl
[ph-reed]: https://thepihut.com/products/magnetic-contact-switch-sensor-for-arduino
[ph-micro]: https://thepihut.com/products/micro-switch-w-wire-three-terminals
[ph-piezo]: https://thepihut.com/products/piezo-buzzer
[ph-mosfet]: https://thepihut.com/products/gravity-mosfet-power-controller
[ph-bb]: https://thepihut.com/products/raspberry-pi-breadboard-half-size
[ph-jw-mm]: https://thepihut.com/products/rpi-premium-jumper-wires-male-male-75mm
[ph-jw-fm]: https://thepihut.com/products/jumper-wires-7-8-f-m-high-quality-30-pack
[ph-jw-ff]: https://thepihut.com/products/rpi-jumper-wires-10pk-female-female-150mm
[dk-ppk2]: https://www.digikey.co.uk/en/products/detail/nordic-semiconductor-asa/NRF-PPK2/13557476
[dk-kit]: https://www.digikey.co.uk/en/products/detail/seeed-technology-co-ltd/102010611/25835813
[dk-wio-hdr]: https://www.digikey.co.uk/en/products/detail/seeed-technology-co-ltd/113010003/26553860
[dk-wio-mod]: https://www.digikey.co.uk/en/products/detail/seeed-technology-co-ltd/114993390/25835823
[dk-sx1261]: https://www.digikey.co.uk/en/products/result?keywords=SX1261MB2BAS
[dk-xtal]: https://www.digikey.co.uk/en/products/result?keywords=32.768kHz%20crystal%20through%20hole%20cylindrical%2012.5pF
