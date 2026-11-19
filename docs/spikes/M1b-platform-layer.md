# M1b: the platform layer for the ESP32-S3, compiled

Written 2026-11-19, with no board on the desk. It records the ESP-IDF platform layer of [build-plan.md](../build-plan.md) M1b and step 3a of [m3-updates-design.md](../m3-updates-design.md) section 10: what is built, what compiling it proves and what it does not, every fact marked ‡ that only a board can settle, and a bench checklist for the day the boards arrive. "FD" means a section of [firmware-design.md](../firmware-design.md), "HN" of [hardware-notes.md](../hardware-notes.md), "UD" of m3-updates-design.md, "§" of [protocol.md](../protocol.md). ‡ marks a fact stated from memory or a secondary source, as in those documents; (P) a fact read in the installed ESP-IDF v6.1.1 sources or a primary source a project document cites.

## Short answer

- **It builds.** One ESP-IDF v6.1.1 application holds all three roles, chosen at start-up by the role stored in flash (D103, FD 2). It is built from the very sources and CMake files the host builds (`firmware/core`, `firmware/roles`, `firmware/platform/psa`), and from a clean build folder it compiles with **no warnings at all**, ours or ESP-IDF's, in each of its three configurations.
- **It fits.** The image is **1,038,256 bytes (0xFD7B0)**, 28% of a 3.5 MB slot; the bootloader with rollback is **20,720 bytes (0x50F0)**, 37% free below the partition table at 0x8000. UD 2's table stands as written: nothing has to move. Internal RAM is 47% used.
- **The core's rules hold on the target**, checked on the libraries the Xtensa compiler made: C++17 with `-fno-exceptions -fno-rtti -Wframe-larger-than=512` and the host's whole warning set; no heap, exception or abort symbol (the repository's own check, now a step of every board build); no floating-point instruction or soft-float call in any of the 57 core and role objects.
- **A real image passes both stated layouts** (step 3a): the hub's own-build check (`hub/src/shell/firmware/layout.ts`) and the host bench's image check (`platform/host/src/test_image.cpp`) both accept it, read its version as 0.1.0 and its chip as 9, and both refuse it with a byte added, a byte cut, a byte flipped or the chip changed.
- **Nothing has run.** Every timing, current, level and wiring fact below is unproven until the bench checklist at the end is worked through.

## What is built

All under `firmware/platform/esp-idf/`, an ESP-IDF project. Nothing in the core, the roles, `platform/host`, `platform/psa`, `firmware/CMakeLists.txt` or the presets was changed: the core and roles are added to the ESP-IDF build by their own CMake files, so no addition there was needed.

| File | What it is |
| --- | --- |
| `CMakeLists.txt` | The project; `PROJECT_VER` (0.1.0) is the one source of the version, refused unless `MAJOR.MINOR.PATCH` with each part 0 to 255 |
| `partitions.csv` | UD 2's table exactly: `nvs` 0x9000 24 KB, `otadata` 0xF000 8 KB, `phy_init` 0x11000 4 KB, `ota_0` 0x20000 and `ota_1` 0x3A0000 of 3.5 MB, `spare` 0x720000 896 KB; no factory partition |
| `sdkconfig.defaults` | Every setting the platform depends on, each with its reason (below) |
| `sdkconfig.crystal`, `sdkconfig.bench` | Fragments added after the defaults: the 32 kHz crystal for spike S8; every radio event on the console for bring-up |
| `main/app_main.cpp`, `main/idf_component.yml` | The loop of FD 2 and the role switch with function-local statics; the two managed components, pinned |
| `dependencies.lock` | The component manager's lock: both components' hashes |
| `components/hsn_firmware/` | Wraps `hsn_core`, the three role libraries and `hsn_psa` (below); runs the core's symbol rule on each built library |
| `components/hsn_esp/` | The platform layer: one header and one source per piece |
| `…/include/hsn/esp/board.hpp` | Every pin and board value in one table: the Olimex ESP32-S3-DevKit-LiPo with the Wio-SX1262 wired as [dev-board-choice.md](dev-board-choice.md) says; compile-time checks that no GPIO is wired twice or on a pin the module keeps |
| `…/clock`, `watchdog`, `retained`, `nvs_storage`, `basics` | `Clock`, `Watchdog`, `RetainedMemory`, `Storage`, `Random`, `Power`, the boot facts and `BuildInfo` |
| `…/sx1262`, `radio` | Our SX1262 driver (no library, FD 10): the command layer over SPI, then `Radio` on it |
| `…/inputs`, `indicators`, `role_io` | The door, cover, button and power inputs; the buzzer and LED patterns; the battery and temperature; `SensorIo`, `SirenIo`, `GatewayIo` |
| `…/link_slots`, `usb_link`, `network_link` | The links' receive and send slots; the USB link; Wi-Fi, mDNS and the WebSocket |
| `…/event_queue`, `waiter`, `platform` | The one queue interrupts post to; the `Waiter` (light sleep, deep sleep, restart); the object that owns everything and builds `Hal` |
| `update/` | `FirmwareSlots` on ESP-IDF's partition and OTA calls (UD 2, step 3a's `platform/esp-idf/update/`), and the version parser with its compile-time checks |
| `bluetooth/` | F1's folder (m3-m4-plan.md): today only the seam, `bluetooth_link()`, which returns null |
| `.gitignore` | `build/`, `managed_components/`, `sdkconfig` (the repository's `.gitignore` names them too) |

### How the core is built for the board

`components/hsn_firmware` calls `idf_component_register`, then `add_subdirectory` on `firmware/core`, `firmware/roles` and `firmware/platform/psa`, including `firmware/cmake/options.cmake` for `hsn_firmware_library`. So the libraries inherit ESP-IDF's directory-level options (the Xtensa flags, `-Os`), and then:

| ESP-IDF does | So the wrapper |
| --- | --- |
| Adds `-std=gnu++26` (P, `tools/cmake/build.cmake`) | Adds `-std=c++17` after it; the compile commands show both, the last wins |
| Adds `-Wno-error=extra -Wno-unused-parameter -Wno-sign-compare -Wno-error=unused-*` before our options; CMake drops the second of two identical options, so the host's `-Wextra -Werror` would not undo them | Restores the host's strictness with differently spelled options that come last (`-Werror=extra -Wunused-parameter -Wsign-compare -Werror=unused-function …`) |
| Builds TF-PSA-Crypto 1.1.0 inside its `mbedtls` component as a target named `tfpsacrypto`, the very name `platform/psa` links | Lets `hsn_psa` link it, with ESP-IDF's hardware AES and SHA drivers |
| Puts its libc headers (which use `#include_next`) on `-I`, which `-Wpedantic -Werror` refuses | Gives `hsn_psa` the mbedtls component's include directories as system headers, through an imported target, as libc and the crypto headers are on the host; `hsn_psa`'s own code keeps every warning |
| — | Removes `HSN_PSA_FAULT_INJECTION` from `hsn_psa`: every PSA call is the call itself, and `fault_injection.cpp` compiles to nothing |

`platform.cpp` fails the build if ESP-IDF's PSA configuration lacks any algorithm or key type `hsn_psa` uses (CCM, SHA-256, ECDSA on P-256, HKDF, HMAC; AES, derive, HMAC and ECC public keys): one left out would otherwise fail only at run time. All are in TF-PSA-Crypto's defaults and `mbedtls/esp_config.h` removes none (P).

## What was checked, and how

| Check | Result |
| --- | --- |
| Clean build, default configuration (`rm -rf build sdkconfig`, `idf.py -B build build`) | Passes, 0 compiler warnings. Six CMake warnings, all ESP-IDF's own component validation (its Wi-Fi and supplicant components' private includes), none about our code: accepted |
| Clean builds with `sdkconfig.crystal` and with `sdkconfig.bench` (each its own folder and `sdkconfig`) | Both pass, 0 warnings. Images 0xFD7D0 and 0x105C00; bootloaders 0x5120 and 0x50F0 |
| Image and bootloader size (ESP-IDF's own `check_sizes.py` during the build) | Image 0xFD7B0 of 0x380000 (72% free). Bootloader 0x50F0 below 0x8000 (37% free) |
| Partition table | Compiled by ESP-IDF, and `gen_esp32part.py` decodes the binary back to the six rows of UD 2 |
| Compile flags (the build's `compile_commands.json`) | Core, roles and PSA: `-std=c++17` last, `-fno-exceptions -fno-rtti`, `-Wframe-larger-than=512`, the host's warnings with `-Werror`; no `HSN_PSA_FAULT_INJECTION` |
| No heap, exceptions or abort (`cmake/check_symbols.cmake` with the Xtensa `nm`) | All four libraries pass (core 338, sensor 114, siren 72, gateway 99 defined symbols). The same check run on ESP-IDF's mDNS library reports its `abort`, so it is not vacuous with this `nm`. It now runs as a step of every board build |
| No floating point (`objdump` of every archive member, the two members both named `setup.cpp.obj` extracted one by one) | 57 objects, no FPU instruction (`*.s`, `lsi`, `ssi`, `wfr`, `rfr`…) and no soft-float call (`__addsf3`, `__floatsidf`…). Disassembling the whole archive at once once showed an `lsi`: a decoding slip, the same bytes decode as `bgeu` and `mov.n` in their own object |
| The interrupt path in IRAM (the linked ELF's symbols) | `EspRadio::on_dio1`, `Inputs::on_edge`, `EventQueue::post_from_isr`, `EspClock::now_from_isr`, `esp_timer_impl_get_time`, `xQueueGenericSendFromISR` and ESP-IDF's `gpio_intr_service` all sit in `.iram0.text`, so a DIO1 edge is stamped while flash is busy |
| The retained block (the ELF's symbols) | 1,024 bytes at 0x50000004 and the breadcrumb at 0x50000000: RTC slow memory, in `.rtc_noinit` |
| Step 3a: the hub's own-build check on the real image (a scratch script calling `EspLayout` and `readEspHead`) | Passes whole and in pieces of 1, 7, 4,096 and 1,048,576 bytes; magic, chip 9, version "0.1.0". Refuses the image with a byte appended ("bytes after the image"), cut ("cut short"), flipped ("checksum is wrong"), and with chip 0 |
| Step 3a: the host bench's check (`check_test_image`, built in a scratch program against my scratch host build) | Accepts the image in a 3.5 MB slot of erased flash: length 1,038,256, version 0.1.0. Refuses the three damaged copies |
| esptool's own reading | 7 segments, the first DROM (holding the app description at offset 32), checksum and SHA-256 valid, "App version: 0.1.0", ESP-IDF v6.1.1 |
| Compile-time checks of the platform's own arithmetic (frequency words, timer steps, CAD codes, the version parser, the wiring table) | All pass. Ten mutants made in scratch copies (a wrong shift, rounding down, a wrong CAD code, a pin wired twice, a PSRAM pin, a wake input above GPIO21, and four faults in the parser) each fail the build; the unchanged headers compile. An earlier mutant that changed nothing showed a redundant test, which was removed |
| Formatting | clang-format over my 37 C++ files; `bun run format:firmware:check` passes over all 420. Prettier passes over the folder |
| The host build, untouched | The `role-sensor` preset's workflow, rebuilt in my scratch folder (no file under `firmware/build/` touched, the dependencies' downloaded sources reused, nothing fetched): `hsn_role_sensor_tests`, `role_sensor_sources`, `role_sensor_symbols` pass, 3 of 3; doctest 161 cases, 371,164 assertions |

The build used the checkout as it stood on 2026-11-19, other engineers' uncommitted changes to `firmware/core` and `firmware/platform/host` included.

## Each interface on the chip

| Interface | On the ESP32-S3 | What the design asked, and how it is met |
| --- | --- | --- |
| `Clock` | The RTC time (`esp_rtc_get_time_us`) read once at start-up, plus `esp_timer` from then on | FD 2: the RTC timer, through deep sleep. Reading the RTC takes up to a slow-clock cycle (P, `esp_rtc_time.h`), too slow for an interrupt; `esp_timer` is in IRAM and ESP-IDF moves it on by the RTC time slept after each light sleep (P, `sleep_modes.c`), and `esp_rtc_get_time_us` keeps its count across resets and calibration changes in RTC memory (P, `esp_clk.c`) |
| `Watchdog` | The task watchdog: ESP-IDF starts it with no task watched (idle tasks off, panic on timeout, 5 s); `start()` subscribes the main task | FD 6. Started first in `app_main`, before the platform starts (the bootloader's RTC watchdog is disabled by ESP-IDF just before `app_main`, P). See "The old faults" below |
| `RetainedMemory` | `RTC_NOINIT_ATTR` arrays in RTC slow memory | FD 5. Not `RTC_DATA_ATTR`: start-up code clears RTC bss on every reset but a deep-sleep wake (P, `cpu_start.c`), which would lose the siren's sounding state after a watchdog reset (SR5). The core checks the block's CRC on every boot |
| `Storage` | NVS, namespace `hsn`, one blob per `StoreKey` named `kNN`, `nvs_set_blob` then `nvs_commit` | FD 5: whole or nothing (NVS keeps the old value until the new one is whole, P), durable on return, ≤ 256 bytes. `erase_all_but_role` erases key by key, so the role is never absent. `CONFIG_NVS_FLASH_VERIFY_ERASE` on (one image serves battery boards too). Wi-Fi keeps its settings in RAM, so it never writes NVS. Wear: see "Findings" |
| `Random`, `Power` | `esp_fill_random`; the USB 5 V sense pin | FD 3 |
| `Radio` | Our driver: commands over SPI2 at 2 MHz, NSS by hand, BUSY waited for before each transfer and bounded; DIO1 rising edge in IRAM stamps the time and posts; the main task reads and clears the IRQ | FD 3, HN(a) 13. The fixed §2 settings and every HN 3 workaround (TCXO then full calibration, image calibration 863–870 MHz, DIO2 as RF switch, TX clamp after each cold start, the 500 kHz bit before each transmit, the IQ bit, the timer fix after each timed receive, a sleep between a receive timeout and a CAD). Sync word read back after writing (HN(a) 20). Stop on preamble or on header, the symbol timeout, continuous or timed receive, `GetRssiInst` for the noise, `GetPacketStatus` for RSSI and SNR, warm sleep, `recover()` by the reset pin. Starting an operation puts the chip in standby and clears every IRQ, so the one it replaces raises no event |
| `Link` (USB) | The chip's USB Serial/JTAG port (the Olimex USB-OTG1 socket), the core's `encode_frame` and `FrameDecoder`; a reader and a writer task | §10. Byte-clean: the console is on UART0 (the CH340X socket) and ESP-IDF's secondary console on this port, on by default, is off (P, `esp_stdio/Kconfig`). `up` means a computer is attached (start-of-frame packets, `usb_serial_jtag_is_connected`) |
| `Link` (network) | Wi-Fi station, `mdns_query_ptr("_hsn-hub", "_tcp")` with the TXT `id` compared with the paired identity, then `esp_websocket_client` to `ws://<address>:<port>/device`; a worker and a sender task | §10, FD 3, HN(a) 46–47: the client's own reconnect off, a ping every 15 s and down after 15 s without a pong, messages over the buffer put together by offset, a failed join, lookup or handshake is one `down` |
| `Waiter` | One FreeRTOS queue; an `esp_timer` alarm at each deadline; `esp_light_sleep_start` and `esp_deep_sleep_start` | FD 2–3, below |
| `SensorIo`, `SirenIo`, `GatewayIo` | The inputs, ADC1 with curve-fitting calibration through the board's divider, the chip's temperature sensor, LEDC for the piezo, GPIO for the LED and the siren's output | FD 3. The siren's output is set low before it becomes an output, and a 10 kΩ resistor holds it low through every reset |
| `FirmwareSlots` | `esp_partition_erase_range`, `_write`, `_read` on the slot `esp_ota_get_next_update_partition` names; `esp_ota_set_boot_partition`; `esp_ota_mark_app_valid_cancel_rollback`; `esp_ota_mark_app_invalid_rollback` (which does not restart, P) | UD 2. `running()` reads `PENDING_VERIFY` as on trial, and reads both `otadata` copies (sequence and CRC) to report a rollback the way the host's fake bootloader does: the newest intact entry names the other slot, `INVALID` or `ABORTED`. `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` on |
| `UpdateCrypto`, `KeyImport`, `PacketCipher` | `hsn_psa` on ESP-IDF's Mbed TLS 4.1 | The paired key is loaded from the pairing record at start-up and imported into the packet cipher and the update crypto together by `PsaKeyImport` (key_import.hpp). ESP-IDF calls `psa_crypto_init` at start-up; `hsn_psa` calls it again, harmlessly (firmware/README.md) |
| `Hal::bluetooth` | Null | The seam in `bluetooth/` (below) |

### The waiter

- **Awake** (a siren, a gateway, a sensor on USB power): it blocks on the queue, an `esp_timer` alarm posting at the deadline, so a deadline is met to the timer, not to a tick. `CONFIG_FREERTOS_HZ=1000` as well.
- **Light sleep** (a sensor on its cell): the timer at the deadline, DIO1 armed high, each input armed at the level it does not have. The pins' edge interrupts are disabled while their level wakes are armed and restored after, so a level never interrupts in a storm. Light sleep is not taken while external power is present (the USB port stops in light sleep and may not come back, P, ESP-IDF's Kconfig help for `USJ_NO_AUTO_LS_ON_CONNECTION`), while the network link is in use, or while the buzzer or LED plays; the wait is then awake.
- **Deep sleep**, in FD 3's order: the WebSocket closed and Wi-Fi stopped, the radio put in cold sleep before NSS and the RF switch are held, the buzzer and LED off, the timer and each wake input armed at the level the pin does not have (`esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown`, whose level is kept per pin on the S3 in v6.1, P, `sleep_modes.c`), the inputs read again, and an input event returned instead of sleeping when one changed (HN(a) 27). An input still settling is waited for awake first.
- **Restart**: the USB and network links get at most 200 ms together to finish sending, then `esp_restart`.
- **Events**: a DIO1 edge becomes at most two radio events (`header_seen`, then `rx_done` or `rx_crc_error`); a second edge waits while a radio event is unreturned, so the radio's one receive buffer is never overwritten under the core. A link packet's slot is freed at the next wait, after `handle()` has returned. Inputs are debounced (20 ms ‡) and stamped with their first edge; the interrupt posts one message per input until the main task takes it, so a bouncing contact cannot fill the queue and push out a DIO1 message.

### The old faults, impossible by construction

- **Feeding from elsewhere.** `EspWatchdog::feed` is the only `esp_task_wdt_reset` in the platform, and the core's `Runner` its only caller. No other task is subscribed, so the Wi-Fi, WebSocket, mDNS and link tasks could not keep the main task's timer alive even if they reset it.
- **A long wait hiding a hang.** The waiter never waits past the Runner's slice (2 s) except in deep sleep; a hang in a driver or in the wait itself never returns to the Runner and is not fed.
- **Double sleep.** `esp_deep_sleep_start` is called in one place, the waiter's deep sleep, and never returns (it is `noreturn`, P); the chip resets on wake, so the loop's iteration that sleeps is its last. Nothing else in the firmware sleeps.

### Choices made where the designs are silent

| Point | Choice | Why |
| --- | --- | --- |
| One application or one per role | One, the role from flash | FD 2 and D103 say so; "each role builds" means the one image holds all three |
| The radio's power settings | +14 dBm with Semtech's reference setting for +22 dBm boards (duty 0x03, hpMax 0x02, +22); any other power the full setting (0x04, 0x07) at the power asked | dev-board-choice.md; spike S8 measures the current |
| Debounce and the input's time | 20 ms ‡, stamped with the first edge | No design gives one |
| Buzzer and LED patterns | Countdown 100 ms each second; alarm 400/100 ms; chirp 50 ms; low battery three 60 ms; reset warning 200/300 ms; LED short 100 ms, pairing 500/500, fault 100/100 | No design gives them (`indicators.hpp`) |
| `confirm()` with nothing on trial | Does nothing and succeeds, as the host's fake does | ESP-IDF refuses a board still as first flashed, `otadata` blank ("Running firmware is factory", P, `esp_ota_ops.c`) |
| `reject()` with nothing to go back to | `HalError::invalid`, as the fake | ESP-IDF answers `ESP_ERR_OTA_ROLLBACK_FAILED`, or `ESP_FAIL` with `otadata` blank |
| A brown-out | `BootKind::other_reset` | `events.hpp` lists it there |
| Which inputs are wired | Button and external power always (setup-only mode wakes on them); door for the sensor; cover for the sensor and siren | A pin left floating on another role's board would raise events |
| Timeouts on the network | Wi-Fi join 15 s ‡, mDNS lookup 3 s ‡, WebSocket network timeout 10 s, buffer 1,100 bytes | None given; the core times retries after a `down` |
| The platform's own log codes | 0x4001 a link dropped a packet for want of a slot, 0x4002 the queue was full | FD 4 reserves 0x4xxx for the platform; FD 3 asks for link overflow to be "counted in a log" |
| A cell "fitted" on a siren or gateway | Reads at least 3,000 mV ‡ | The Olimex board has no cell-sense pin |

## What compiling proves, and what it does not

**It proves:** the platform implements every `hal/` interface as declared (the compiler checks every override and the `Hal` layout); the core, roles and PSA compile for the S3 under their own rules and stay free of heap, exceptions and floating point; the image, bootloader and partition table fit UD 2's layout; a real v6.1.1 image matches what the hub and the bench assume; every ESP-IDF call used exists in v6.1.1 with the arguments given; the interrupt path links into IRAM; the platform's own arithmetic is right where it is checked.

**It does not prove** anything that needs electrons: that the radio answers, that any SX1262 opcode or argument from memory is right, that a packet goes between two boards, that the timing, levels and polarities are as assumed, that deep sleep draws what it should, that the watchdog resets, that rollback rolls back, that Wi-Fi joins and the hub is found, or that the USB port is clean. No platform code has a test that runs: there is nothing to run it on. The build plan's hardware contract tests (one suite against both the fakes and the real drivers) are not written: they need a board to mean anything, and are the first thing to add on the bench.

## Facts marked ‡, each to settle on the bench

| # | Fact | Where | How to settle it |
| --- | --- | --- | --- |
| 1 | The SX1262 opcodes and arguments from memory: SetStandby 0x80, SetTx 0x83, SetPacketType 0x8A, SetRfFrequency 0x86, SetModulationParams 0x8B, SetPacketParams 0x8C, SetDioIrqParams 0x08, GetIrqStatus 0x12, ClearIrqStatus 0x02, GetRxBufferStatus 0x13, SetBufferBaseAddress 0x8F, WriteBuffer 0x0E, ReadBuffer 0x1E, WriteRegister 0x0D, ReadRegister 0x1D, Calibrate 0x89 (0x7F), CalibrateImage 0x98, SetRegulatorMode 0x96, SetPaConfig 0x95 (deviceSel 0, paLut 1), SetTxParams 0x8E (ramp 0x04), ClearDeviceErrors 0x07; LoRa packet type 0x01, 125 kHz code 0x04, 4/5 code 0x01; the frequency word f × 2^25 / 32 MHz | `sx1262.hpp` | Check each against the SX1261/2 datasheet Rev 2.2 section 13 before the first run; then the first boot's "radio ready" (the sync word reads back) and step 4 |
| 2 | TCXO 1.8 V (code 0x02) and a 5 ms start | `board.hpp` | Boot log without "radio did not configure"; device errors clear after calibration |
| 3 | The Wio module takes the DC-DC regulator | `board.hpp` | If configuration or transmit fails, set `radio_dcdc` false (LDO) |
| 4 | The RF_SW line low in sleep, high while awake | `board.hpp`, `sx1262.cpp` | Step 4 receives at both levels; then current in sleep |
| 5 | BUSY falls within 10 ms of a command, 20 ms of a reset, cold wake or calibration; NRESET low for 200 µs is enough | `sx1262.cpp`, `radio.cpp` | Boot log; a logic analyser on BUSY |
| 6 | A header error without RxDone ends the packet, reported as `rx_crc_error` | `radio.cpp` | A deliberately weak or colliding packet on the gateway's console |
| 7 | The board's RSSI offset is 0 dB | `board.hpp` | Compare the gateway's noise and RSSI with a known source |
| 8 | Door, cover, button and power levels: open door high, open cover high, button low when pressed, USB power high | `board.hpp` | Step 2's input lines on the console |
| 9 | The battery reading through the 470 kΩ / 150 kΩ divider at 12 dB attenuation is accurate enough; a cell is "fitted" above 3,000 mV | `role_io.cpp`, `board.hpp` | A bench supply on the LiPo connector against a meter; with no cell, read what the charger's output gives |
| 10 | The PS1240 is loudest near 4 kHz | `board.hpp` | Listen; try 2.7 to 4.5 kHz |
| 11 | Light sleep stamps radio and input events at the wake; the wake latency is small against the 20 ms heartbeat margin (§8) | `waiter.cpp`, `inputs.cpp` | A logic analyser on DIO1 and a spare pin toggled at the wake (O10, S8) |
| 12 | A pin's level wake works while its edge interrupt is disabled | `waiter.cpp`, `inputs.cpp` | Step 5: the door wakes a light-sleeping sensor |
| 13 | Output levels hold in light sleep (NSS high, RF_SW, LED) | — | Current and behaviour in step 6 |
| 14 | NSS held high and GPIO42 (a digital pad) held low through deep sleep by `gpio_hold_en` and `gpio_deep_sleep_hold_en` | `sx1262.cpp` | Step 6: the radio's sleep current; a scope on NSS |
| 15 | RTC slow memory keeps the retained block through a watchdog reset and a software reset; the RTC counter keeps counting through them (HN(b)) | `retained.hpp`, `clock.hpp` | Step 7's resets: the siren resumes sounding (SR5); Started shows no `clock_reset` |
| 16 | The chip's ROM may print on the USB port at reset | `usb_link.hpp` | Watch the native port across a reset; the hub's decoder should drop it as one bad frame |
| 17 | The USB port shows Espressif's vendor number 0x303A | — | `hsn usb list` |
| 18 | Closing the WebSocket and stopping Wi-Fi takes under 500 ms; a Wi-Fi join under 15 s; mDNS answers within 3 s with SRV, TXT and an address | `waiter.cpp`, `network_link.cpp` | Step 3 on the console |
| 19 | The WebSocket client's `pingpong_timeout_sec` reports a dead hub within 15 s | `network_link.cpp` | Stop the hub with a siren connected and time the "network link down" line (§7) |
| 20 | An NVS write takes under 500 ms and a slot sector erase under 400 ms (FD 3, UD 2) | — | Time them on the board (UD step 3b) |
| 21 | `esp_ota_set_boot_partition` refuses an image that fails `esp_image_verify` (P in `esp_ota_ops.h`); rollback after any reset on trial (P in the OTA guide, HN 7) | `update/` | Step 7 |
| 22 | The task watchdog counts during light sleep (FD 10) | — | Hang a test image in light sleep; the 2 s slices are right either way |
| 23 | 8 KB of main-task stack and 3–4 KB for each platform task are enough | `sdkconfig.defaults`, link sources | The boot log prints the main task's high-water mark; check after a day's run |
| 24 | A countdown's buzzer costs about 30 mA for its 30 s (the chip stays awake while a pattern plays) | `indicators.hpp` | Step 6, S8 |
| 25 | The temperature sensor reads within a few degrees | `role_io.cpp` | Against a thermometer |
| 26 | A gateway transmit "at a given time" lands within ±1 ms (O10): the esp_timer alarm, the queue, and the SPI commands before SetTx | `waiter.cpp`, `radio.cpp` | A logic analyser on DIO1 of the sending gateway against the hub's requested time |

From the designs, untouched here and still open: the image size with NimBLE (UD 2 estimated 1.5 MB in all; today's 1.0 MB has no Bluetooth), P-256 verification time, Wi-Fi throughput, and the 32 kHz crystal's start-up on the hand-built adapter (S8).

## Findings for the reviewer

1. **The repository's firmware format sweep reaches ESP-IDF build output.** `format:firmware:check` and `format:firmware` in `package.json` run clang-format on every `*.[ch]pp` under `firmware/platform`, which now includes this project's `build/`. A fresh configure writes CMake's `CMakeCXXCompilerId.cpp` into every build tree (four of them here), which fail the check. I removed those generated files from my build folders (the builds do not need them after configuring) so the check passes today, but the next fresh configure brings them back. The fix is outside my folders: add `-not -path '*/build/*' -not -path '*/managed_components/*'` to both `find` commands.
2. **NVS wear is about three times the design's count.** FD 5 counts one 32-byte entry per write. A blob costs a blob-index entry, a data-chunk entry and one entry per 32 bytes (P, the NVS guide's entry structure), so the 5-byte resume point costs 3. For the gateway's 7,500 writes a year that is about 22,500 entries, about 36 erases of each page a year instead of 12: still far inside any NOR rating. Storing the small records as integers would meet the count, at the price of two entry types per key and an order of writes that a power cut can get wrong; I kept blobs.
3. **The platform's link buffers are larger than FD 10 counts.** Each link has 4 receive slots and 4 send slots of 1,024 bytes, and the USB link 2 KB of framing: about 18 KB, against FD 10's 4 KB. Internal RAM is still 47% used (DIRAM 160,731 of 341,760 bytes).
4. **Light sleep on this chip is narrower than FD 3 says.** FD 3 has light sleep woken by "link activity". The USB port does not run in light sleep, so the waiter stays awake while external power is present, which also covers FD 7's sensor-on-USB rule. A sensor updating over Wi-Fi does not light-sleep while its network link is in use.
5. **`FirmwareSlots` on ESP-IDF differs from the fake in two places, now matched.** See "Choices made" (`confirm` and `reject` with blank `otadata`). The rollback reading copies the fake's: the newest intact `otadata` entry names the other slot and is `INVALID` or `ABORTED`; ESP-IDF's `esp_ota_get_last_invalid_partition` alone would keep reporting an old failure after a later good update.
6. **UD 2's table stands.** The bootloader with rollback fits below 0x8000 with 37% to spare, so nothing has to move; the image leaves 72% of a slot.
7. **The stated image layout is confirmed for v6.1.1.** Both the hub's and the bench's checks accept a real image; the first of its 7 segments is DROM and holds the app description, as both assume.

## For the Bluetooth and display engineer

- **The seam.** `bluetooth/include/hsn/esp/bluetooth.hpp`'s `bluetooth_link()` returns the `Link*` that `EspPlatform` puts in `Hal::bluetooth`; today it returns null. Make the `bluetooth` folder a real component (it is already in `EXTRA_COMPONENT_DIRS`) and return your link. `sdkconfig.defaults` has `CONFIG_BT_ENABLED=n`: turn on NimBLE there. ESP-IDF's `protocomm` component is in the tree.
- **The waiter knows only USB and network today.** Post your link's events into `EventQueue` as `link_up`, `link_down` and `link_packet` with `index` `LinkKind::bluetooth`, and add your link to `EspWaiter::absorb`, `slots_of`, `light_sleep_allowed` (no light sleep while advertising or connected, ‡) and `deep_sleep` (stop Bluetooth before deep sleep, FD 3). `LinkSlots` and `SendSlots` are reusable as they are; keep each packet one write or notification (UD 5).
- **The SPI bus is shared.** The radio is a device on `SPI2_HOST`, NSS by hand, and holds the bus (`spi_device_acquire_bus`) for each whole command. The bus is started without DMA and with 64-byte transfers (`Sx1262Bus::begin`); an e-paper frame (5,000 bytes at 200 × 200) needs DMA or chunking: change the bus to `SPI_DMA_CH_AUTO` with a larger `max_transfer_sz` there, and the radio keeps working (it already sends in 64-byte pieces). Do not hold the bus long: the radio's commands wait for it.
- **The pins** are in `board.hpp`: e-paper CS 47, DC 39, reset 40, busy 41, with CLK 12 and DIN 11 shared with the radio; `wiring_is_sound` checks any pin you add against the rest.
- **Room.** The image is 1.0 MB of a 3.5 MB slot; the size tool shows the S3's fixed 16 KB IRAM region full, which is normal on the S3 (further IRAM code goes into DIRAM, 53% free).
- **Interrupts.** The GPIO interrupt service is installed with `ESP_INTR_FLAG_IRAM`: any handler you add with `gpio_isr_handler_add` must be `IRAM_ATTR`.

## Bench checklist

In order; each step says what to do and what should be seen. Paths are from the repository's root. Before any power: wire each board as [dev-board-choice.md](dev-board-choice.md) "Wiring" says, fit an antenna to every radio (never transmit without one), fit the 10 kΩ pull-down on the MOSFET module's control pin, and keep the jumper wires short with a ground wire alongside.

The Olimex board has two USB-C sockets: **USB-OTG1** is the chip's own USB, the link the hub uses (and a flashing port); **USB-UART1** is the CH340X to UART0, the console. Connect both while bringing a board up. The hub opens every port with Espressif's vendor number by itself, so stop it while flashing.

### 1. First flash (each board)

1. `. ~/esp/esp-idf/export.sh`, then `cd firmware/platform/esp-idf` and `idf.py -B build build` (for steps 4 and 5 on the gateway, build with `-B build/bench -DSDKCONFIG=build/bench/sdkconfig -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.bench"` to see each radio event).
2. `ls /dev/cu.*`: the USB-OTG1 port is a `usbmodem…` name; the CH340X a `wchusbserial…` or `usbserial…` one ‡.
3. `idf.py -B build -p /dev/cu.usbmodem… erase-flash`, then `idf.py -B build -p /dev/cu.usbmodem… flash`.
   **Seen:** esptool writes four regions, 0x0 bootloader, 0x8000 partition table, 0xF000 `otadata` (blank), 0x20000 the image, each "Hash of data verified". If the port will not enter download mode, hold the board's BOOT button (GPIO0) while pressing RESET ‡.

### 2. First boot log

1. `idf.py -B build -p /dev/cu.wchusbserial… monitor` (115,200 baud), then press RESET.
2. **Seen:** ESP-IDF's bootloader prints v6.1.1 and a partition table of exactly six rows (`nvs` at 0x9000 … `spare` at 0x720000) and loads the app from 0x20000. Then three lines of ours:
   - `hsn: board olimex-esp32-s3-devkit-lipo+wio-sx1262, firmware 0.1.0 (development), chip <12 hex digits>`
   - `hsn: role 0, reset cause 1, woken by 0x00, radio ready, key none (not paired)`
   - `hsn: main task stack left <n> bytes, free heap <n> bytes (least <n>)`: write the numbers down (‡ 23).
3. Any `… did not start` line names the piece that failed. `radio NOT ANSWERING` or `radio did not come out of reset (BUSY stays high)`: check RESET, BUSY, NSS and power to the radio. `sync word reads back …`: MOSI and MISO swapped, or the SPI mode. `radio did not configure`: try LDO (`radio_dcdc` false) or another TCXO code (‡ 2, 3).
4. Press the radio board's button and plug and unplug USB power: **seen** `hsn.waiter: button active` / `inactive` and `external_power …` lines; if the polarities are reversed, change `board.hpp` (‡ 8).
5. Leave it a minute: **seen** no task watchdog message and no reset (a board with no role on USB power waits awake for setup messages).

### 3. Roles and pairing over USB

1. Start the hub: `bun hub/src/shell/main.ts --data /tmp/hsn`; use `HSN_DATA_DIR=/tmp/hsn bun hub/cli/hsn.ts …` for each `hsn` command below.
2. `hsn usb list`: **seen** each board's USB-OTG1 port (‡ 17).
3. `hsn site wifi --name <network> --password -` (the siren needs it; a gateway on USB does not).
4. Board A, the gateway, stays on the hub computer's USB: `hsn usb add /dev/cu.usbmodem… --name gateway1 --role gateway`. **Seen** on its console: a restart, then `role 3 … key loaded` and `hsn.waiter: usb link up`; `hsn status` shows the gateway connected.
5. Board B, the siren: `hsn usb add … --name siren1 --role siren`, then power it from a USB charger. **Seen:** `role 2 … key loaded`, then within seconds `network link up` (Wi-Fi joined, the hub found by mDNS, the WebSocket open; ‡ 18).
6. Board C, the sensor: `hsn usb add … --name door1 --role sensor`, then unplug USB and power it from a LiPo cell (polarity marked on the Olimex connector).

### 4. The radio's first packet between two boards

1. With the gateway on the bench build (step 1.1) and its console open, power the sensor.
2. **Seen** on the gateway: `radio header_seen` then `radio rx_done … 30 bytes, rssi … dBm, snr …` (the sensor's Started, §2: 30 bytes), and on the hub, `hsn log --follow` shows door1's Started through gateway1 and the reply sent. With the sensor's console on its CH340X port: its `radio tx_done`, then an `rx_done` of 32 bytes (the reply) inside its listen window. The console cable powers the board from USB, so a sensor with it attached never deep-sleeps, by design (whether GPIO5 senses that socket's 5 V as well as USB-OTG1's is to be seen ‡).
3. At one metre expect RSSI around −40 to −60 dBm and a positive SNR. Nothing heard: check the frequency, the antennas, the RF_SW level (‡ 4) and the opcodes (‡ 1).

### 5. Door to siren: M1b's "done when"

1. `hsn sensor set door1 countdown=30`, then `hsn arm`.
2. Open the door (take the magnet away). **Seen:** the sensor's console `door active`; its buzzer beeps once a second (the countdown pattern); `hsn log` shows the countdown started.
3. Wait. **Seen:** about 30 s after the opening the siren's output switches on (the MOSFET module's LED, or 3.3 V on GPIO1); `hsn disarm` turns it off and stops the sensor's buzzer.
4. Again, but `hsn disarm` within the 30 s. **Seen:** the buzzer stops and the siren never switches.
5. Note the time from opening to the first beep and from the countdown's end to the siren's output. Then write down spike S6, S7 and S8's results as the build plan asks.

### 6. Deep-sleep current, with the power profiler

1. Sensor board, both USB cables unplugged (USB power keeps the chip awake by design, and the CH340X draws milliamps).
2. The Nordic PPK2 in source mode at 3.9 V into the LiPo connector (mind the polarity).
3. **Seen:** a boot, the Started transmission and its reply window, then deep sleep. The floor on this board is about 200 µA (Olimex: its regulator and the CH340X; the chip's own 8 µA is lost in it, dev-board-choice.md). Record the floor, the charge of one heartbeat (every 3 minutes) and of one door report, and the transmit current at +14 dBm (S8's first job: 90, 55 or 45 mA, dev-board-choice.md).
4. Open and close the door while it sleeps: each change wakes it and is reported, the time from the change to the transmission measured on the profiler's trace (HN(a) 33; ‡ 12, 14).
5. Repeat with the 32 kHz crystal fitted across GPIO15 and GPIO16 and an image built with `sdkconfig.crystal`; compare heartbeat timing over a few hours (S8, HN(a) 31).

### 7. Rollback

1. Build a second version: change `PROJECT_VER` in `firmware/platform/esp-idf/CMakeLists.txt` to `0.1.1` and build into its own folder, `idf.py -B build/v011 -DSDKCONFIG=build/v011/sdkconfig build`; put the version back afterwards.
2. `hsn firmware add firmware/platform/esp-idf/build/v011/hsn_firmware.bin --own --version 0.1.1`, `hsn firmware list` for its number, then `hsn rollout start <image> --pilot siren1`.
3. Watch the siren's console: the download, the restart, and `firmware 0.1.1` in the boot log. **Before it confirms** (it confirms once a hub packet opens, seconds after Wi-Fi is up), press the board's RESET button.
4. **Seen:** the bootloader boots 0.1.0 again; our boot log says `firmware 0.1.0`; the hub records the rollback with 0.1.1 as the failed version (Started's fields), and `hsn rollout status` shows the rollout paused.
5. Again with the Wi-Fi access point switched off before the restart: 0.1.1 cannot reach its hub, rejects itself at its 5-minute trial deadline, and 0.1.0 runs again.
6. On the sensor: while it runs an image on trial the profiler shows it never deep-sleeps until it has confirmed (UD 2).
7. Reset a siren while it sounds for an alarm: it resumes sounding for the time left (SR5, ‡ 15).

## Installed and downloaded, and from where

- Nothing installed. ESP-IDF v6.1.1 at `~/esp/esp-idf` and its tools under `~/.espressif` were already there (approved 2026-11-18).
- ESP-IDF's component manager fetched exactly two components from `https://components.espressif.com/`, pinned in `main/idf_component.yml` and locked in `dependencies.lock`: `espressif/esp_websocket_client` 1.8.0 (component hash `dc00233af846f3a744ada283a300e0d586040aadc3ee67361645ecdce4523672`, esp-protocols commit `70bf122f`) and `espressif/mdns` 1.15.1 (hash `2fa43caa78cc170842255bc7bf71f306bc815cae12e9496bfb12372423019ac7`, commit `587888b4`). Neither depends on another managed component. They sit in `managed_components/`, ignored by git.
- The host check reused the TF-PSA-Crypto, doctest and nlohmann/json sources already downloaded under `firmware/build/role-sensor/_deps/`, read only, with `FETCHCONTENT_FULLY_DISCONNECTED`.

## How to repeat the checks

- Build: as in step 1.1; the crystal and bench variants as there and in step 6.5. The symbol rule runs in every build ("Checking hsn_core for heap, exception and abort symbols").
- Floating point: extract each member of the four `.a` files under `build/esp-idf/hsn_firmware/` (`xtensa-esp32s3-elf-ar xN <n> …` for the two named `setup.cpp.obj`) and search `xtensa-esp32s3-elf-objdump -d` of each for FPU mnemonics, and `xtensa-esp32s3-elf-nm -u` for soft-float helpers.
- The hub's check: a script calling `EspLayout` and `readEspHead` from `hub/src/shell/firmware/layout.ts` on `build/hsn_firmware.bin`. The bench's: a program calling `hsn::host::check_test_image` on the image padded to a slot with 0xFF.

## F1 Bluetooth and e-paper

This section records the ESP32-S3 build and host checks. The peripheral, display, phone connection, radio timing and current still need the bench. The QR encoder is 235 lines and the panel driver is 145 lines, counted in their implementation files.

### What is built

| File | What it does |
| --- | --- |
| `bluetooth/CMakeLists.txt` | Builds the ESP-IDF peripheral, caps protocomm logging and hooks the installed salt serializer and GAP start. |
| `bluetooth/include/hsn/esp/bluetooth.hpp` | Owns the shared peripheral, core update link, callback mailbox and receive slots. |
| `bluetooth/bluetooth.cpp` | Starts and stops each service, serves authenticated setup on the main task and sends atomic update frames through NimBLE. |
| `bluetooth/include/hsn/esp/pairing_logic.hpp` | Declares the portable pairing, advertising, hold, MTU and salt rules. |
| `bluetooth/pairing_logic.cpp` | Builds the Crockford code, display text, URL and advertising fields, and advances the hold timer. |
| `bluetooth/pairing_srp.hpp` | Declares ownership of Security 2 salt and verifier buffers. |
| `bluetooth/pairing_srp.cpp` | Calls ESP-IDF's SRP generator, checks the actual salt length and retries truncated draws. |
| `display/include/hsn/esp/epaper.hpp` | Declares the SPI panel, refresh stages and fixed frame buffer. |
| `display/epaper.cpp` | Sends the panel commands and polls BUSY with a deadline. |
| `display/include/hsn/esp/display_label.hpp` | Declares the display's durable label and its refresh state. |
| `display/display_label.cpp` | Gets boot entropy, stores the code and records successful panel sleep. |
| `display/include/hsn/esp/pairing_bitmap.hpp` | Declares the fixed-size bitmap and QR APIs used by the board and host. |
| `display/pairing_bitmap.cpp` | Packs the QR and three lines of 5×7 glyphs into the panel frame. |
| `display/qr.cpp` | Encodes the board's byte-mode QR and selects the same mask as the phone. |
| `components/hsn_esp/CMakeLists.txt` | Compiles the display from its own folder and links ESP-IDF's boot entropy support. |
| `components/hsn_esp/include/hsn/esp/platform.hpp` | Owns the peripheral and display beside the existing radio and links. |
| `components/hsn_esp/src/platform.cpp` | Wires the link into the HAL and starts the label and services in order. |
| `components/hsn_esp/include/hsn/esp/waiter.hpp` | Owns setup-only button timing and tracks Bluetooth receive generations. |
| `components/hsn_esp/src/waiter.cpp` | Services panel and BLE deadlines, routes update events and overrides sleep while work remains. |
| `components/hsn_esp/src/sx1262.cpp` | Enables DMA and a 5,000-byte maximum transfer on the common SPI2 bus. |
| `sdkconfig.defaults` | Enables one NimBLE peripheral connection, Security 2 and a preferred ATT MTU of 517. |
| `firmware/core/include/hsn/device/services/setup.hpp` | Adds a private path-aware entry for the adapter. |
| `firmware/core/src/device/setup.cpp` | Applies the Bluetooth setup rules through the shared message and storage implementation. |
| `firmware/tests/CMakeLists.txt` | Registers `hsn_f1_tests` with the portable board sources. |
| `firmware/tests/f1/pairing_test.cpp` | Checks the protocol vectors, pixel layout, advertising, update MTU limits, salt and timing edges. |
| `firmware/tests/f1/bluetooth_setup_test.cpp` | Checks the core's Bluetooth Identify, Provision and command refusals. |
| `firmware/tests/f1/qr_fixtures.hpp` | Holds ten public app-generated matrices, including every special check symbol. |
| Root `package.json` | Excludes ESP-IDF build output and managed components from the two firmware formatter commands. |

### Decisions and evidence from source

- **Button and LED.** DS7 wins over the design's “any press.” Ordinary boot leaves Bluetooth off. Setup-only mode logs a short press. A five-second hold starts a two-minute window while the button is down. The existing pairing LED uses 500 ms on and 500 ms off. A continuous hold through 15 seconds closes Bluetooth, erases the setup records and restarts. An unpaired device has no home to consult. The paired sensor still receives the original button events for DS8 and D89. Its M1a role requests a pairing blink on a disarmed release even though the peripheral stays off. The waiter ends that cue before waiting again. The role can still request light sleep for its obsolete two-minute pairing timer.
- **Roles and persistence.** D103 gives a factory-blank board role 0. The first image uses “Role unset” until USB Set role finalizes the label, using the same code. A valid stored role is required to advertise or accept Bluetooth Provision. The display record lives in NVS at the ESP adapter's `kff` key, which the existing erase walks. On accepted Provision, erasing the setup record removes the stored code and the physical image stays. On factory reset, the next boot creates and draws a new code. The RNG is fed by `bootloader_random_enable` before ADC or RF initialization, as required by the installed header. An incomplete refresh stays pending across a power cut.
- **Radio and panel.** The dev-board list identifies a Waveshare 1.54-inch monochrome SPI module and leaves the revision open. The driver targets the SSD1681-based V2 ‡. SPI2 uses `SPI_DMA_CH_AUTO`. ESP-IDF's `spi_master.c` keeps the programmed transaction length and uses an aligned bounce buffer for unsuitable DMA buffers. The SX1262 still clocks the same 64-byte chunks and short tail, at the same speed, with manual NSS held for each command. The panel transfers one 5,000-byte bitmap in about 10 ms of clock time at 4 MHz ‡. After reset, software reset, or refresh it returns to the waiter between 20 ms BUSY polls with a 12 s timeout. The bus is free between polls, DIO1 and inputs still enter the queue, and the waiter returns to the Runner on its two-second slice even when the core requested deep sleep. The Runner remains the watchdog's only feed path.
- **QR and label.** The packed image uses QR version 3, error correction L, matching the app's `toqr` default for the 38–40 byte URLs. The 29×29 modules use four physical pixels each. The 16-pixel quiet zone on every edge yields a 148×148 pixel QR field and leaves room for text. The pairing characters are 15×21 pixels in a 5×7 face at 3× scale. Role and chip suffix use 2×, and “Add it in the app.” uses 1×. Scan reliability and typing under the cover are S9 measurements ‡.
- **Pairing carriage and lockout.** `protocomm_nimble.c` sets General Discoverable and BR/EDR Unsupported flags and one complete 128-bit UUID in the advertisement. It sets the Complete Local Name in the scan response and accepts optional manufacturer data, which is absent here. It has no service-data field. We use its stock formatter. Our GAP start gate prevents its automatic restart at expiry, after the fifth mismatch or after Provision. Write the `hsn-pair/1` label to `proto-ver`, then read the plain frozen `PairVersion` JSON, as the phone client already does. Security 2 runs on `prov-session` and only authenticated setup reaches the core. The security event and a later FIFO marker are delivered before the host can handle another proof. A wrong proof returns ESP-IDF's ATT 0x04 without creating a board proof. Failure to synchronize the two event tasks closes the window. The fifth lets that write finish, then closes on phone disconnect or after a 500 ms grace ‡. An accepted Provision ends the window and preserves up to 10 s for the encrypted result to be read ‡. The current phone reads and closes before calling the hub's `pair.finish`. ESP-IDF's proof comparison uses `memcmp`; its source was used as installed. Protocomm debug logs are compiled out, including in the bench configuration.
- **Salt length.** The stock generator writes its buffer in minimal big-endian MPI form and computes the verifier over that size. Its public function returns the verifier length but omits the salt length. A GNU linker wrapper captures the first `esp_mpi_to_bin` length while the generator runs, using task-local state. A truncated draw is discarded before indexing or reading it at the required length. The wrapper targets ESP-IDF v6.1.1's observed call order. The code is passed to the generator from the display record; the pairing service holds only the salt and verifier.
- **Update.** The board advertises by its paired address with the update UUID. A phone negotiates MTU first and subscribes to TX. The link publishes MTU minus three before posting `up` and routes single `0xF2` frames in both directions. The Link accepts 182 bytes at an MTU of 185, and 514 at 517. Below 185 it reports the real payload but refuses frames. The core's `UpdateService::session_up` owns the user-visible refusal and still needs the integration change to turn this into an immediate status with the reason. After local disconnect the link gives an already queued Done up to 200 ms ‡ before teardown. A following core `connect`, as after a wrong tag, opens the same update window again with a new connection.

### F1 checks without a board

The original images and link maps give the baselines. All three new configurations were built in empty directories under `build/f1-verified` using ESP-IDF v6.1.1. Image percentages use the 3,670,016-byte OTA slot. DIRAM is static use out of 341,760 bytes. Default DIRAM increased by 34,916 bytes. The runtime heap cost of an open service is a bench measurement.

| Configuration | Image before | Image after | Slot used | DIRAM before | DIRAM after | Bootloader after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Default | 1,038,256 B | 1,271,680 B | 34.65% | 160,731 B | 195,647 B | 20,720 B |
| 32 kHz crystal | 1,038,288 B | 1,271,712 B | 34.65% | 160,715 B | 195,631 B | 20,768 B |
| Bench logging | 1,072,128 B | 1,305,936 B | 35.58% | 161,238 B | 196,154 B | 20,720 B |

Fixed IRAM is 16,384 bytes used before and after. All three linked ELFs place the DIO1 handler, input handler, queue and timestamp ISR callees, and GPIO dispatcher in `.iram0.text`. The repository's board symbol check passes in each configuration for `hsn_core` and all three roles. It reports 340 defined core symbols and 114, 72 and 99 for sensor, siren and gateway respectively, with no heap, exception or abort references.

There were zero emitted compiler warnings. NimBLE's inline `_os_mbuf_trailingspace` narrows a pointer difference to its u16 buffer length. The conversion warning is suppressed in the NimBLE includes only. I accepted the six existing ESP-IDF component-validation CMake warnings and one CMake author warning for `CMP0225` in the bootloader's ExternalProject. Kconfig also reports warnings and deprecation notes in ESP-IDF's own files.


`hsn_f1_tests` uses the portable implementation linked into the board executable. The matrices were generated in a scratch Bun script with `qrMatrix(formatBoardQr({code, chipId}))`, with public test secrets from `pairing-code.json` and the check-symbol cases. The script wrote each 29-module row as a bit string. The C++ tests compare each module and every pixel in the QR area. The lower text area has a pixel snapshot. The two scan responses use 15 and 14 bytes respectively, and each advertisement uses 21 bytes.

For the verifier check, a scratch host program used the same installed TF-PSA-Crypto and C source files as the vector harness. macOS link flags lack GNU `--wrap`, so the two source files were compiled in scratch with the serializer symbol redirected by macros to the same wrapper and the real implementation. Six `hsn` rows in `pairing-srp.json` matched byte for byte on both the first good draw and recovery from a prefixed zero-leading draw. This covers the board's credential generation with the installed crypto. NimBLE GATT long operations, the ATT error on air, event ordering and mobile interoperability still need the bench.

The final F1 host target passed 10 cases and 38,164 assertions under ASan and UBSan. The protocol pairing package passed 102 tests, and `bun run verify:vectors` ran 1,758 checks with zero mismatches. `bun run check:own F1` delegated to the firmware checks, and `bun run format:firmware:check` passed on the latest checkout.

The full host-debug run in the private build directory passed 24 of 26 CTest entries. `hsn_tests` initially failed the same-version update reset and the vector inventory. After rebuilding on the current checkout, the full `hsn_tests` entry passed. The system lockstep's DR2 case hit the real hub's 60 s response timeout once and passed an isolated rerun. The repository-wide `bun run check` passed type checking, lint and formatting, then reported 6,414 tests passed, 56 skipped by existing conditions and four failures. The failures were the `check-own` TypeScript project list and three hub same-version rollout assertions. The two hub test files passed all 104 tests on a later run. The separate vector command passed.

The 23 source mutations ran only in scratch builds, one at a time. The failing tests covered check digit, display dash, URL escape, QR field polynomial, quiet zone, module size, text position, advertising flags, pairing name, update address byte order, zero-leading salt, truncated salt, salt retries, both button thresholds, two-minute expiry, connected extension, fifth mismatch, MTU floor, frame boundary, Erase, Set role and paired Provision.

### F1 bench checklist

1. **Identify the panel before powering it.** Read the module and flex markings and the controller documentation. Confirm SSD1681 V2 ‡ and wire CS 47, D/C 39, reset 40, BUSY 41 and shared SCLK 12/MOSI 11. **Expected result.** reset polarity and duration, BUSY high during work, correct command/argument sequence, 4 MHz transfers and idle ESP activity, verified with a logic analyzer. If the module has another controller, use its command table before running the refresh.
2. **Flash and configure the role.** Use the original checklist and set each board's role over USB. **Expected result.** a single full refresh for a configured blank board, correctly oriented QR and readable role, chip suffix and instructions. Measure BUSY through reset, refresh and sleep at the available temperatures ‡. Verify the 12 s timeout with BUSY held high and continued input/radio handling and watchdog feeds. Record the roughly 10 ms frame bus occupancy ‡ and verify SX1262 command/IRQ timing with the radio selected and the panel chip-select high.
3. **Check the controls on cell power and on USB.** Press and release before five seconds. Then hold past five seconds, keeping the button down. **Expected result.** a log only on an unpaired short press. At about five seconds the LED starts its 500/500 ms rhythm and the pairing service appears with the correct chip suffix. Release and time two minutes, then repeat with a connected phone spanning expiry. The connection continues until it leaves, and no new advertisement follows. Hold through 15 seconds from a fresh boot. **Expected result.** the window closes, the board restarts and refreshes with a different display code. Verify that an armed paired sensor reports its ignored pairing hold and follows the D89 reset/refusal path.
4. **Type the code.** With the display under the cover, have three people unfamiliar with the board read and type its code. **Expected result.** each gets it on the first try ‡, including a board whose check symbol needs the app's alternate keyboard. Do not save the displayed code in the results.
5. **Scan the QR.** Scan at arm's length in different light on Android and iOS. **Expected result.** the camera accepts the code ‡ and the phone selects the board by suffix then checks the full chip ID in `proto-ver`. Use two colliding suffixes if available.
6. **Pair through to first contact.** Try the desk page and both phone platforms, including a reduced ATT MTU. **Expected result.** the phone writes and reads `proto-ver`, completes SRP, gets Identify and an encrypted Provision result, and disconnects. The board restarts. The hub marks it contacted after LoRa, Wi-Fi or USB per role. Confirm the 10 s result grace and restart after client disconnect ‡. Try Erase and Set role inside the encrypted session before Provision. Both writes are refused.
7. **Try five wrong codes.** Each proof is written with response. **Expected result.** writes one to five get ATT 0x04 and the board gives no new proof. A BLE trace shows the fifth error before termination and no renewed pairing advertising ‡. Reopen by holding for five seconds and repeat a correct pairing.
8. **Transfer an actual update.** Offer one from the hub, then scan, connect, negotiate, and subscribe from Android and iOS. **Expected result.** only the update service and the paired address, MTU at least 185, then Hello, Open, Gets/Data, Done and shutdown. Record iOS MTU and throughput ‡ and Android's negotiated MTU after requesting 517. On the phone that paired the board, check rediscovery of its changed GATT service after teardown ‡. Confirm that the phone can send a full 514-byte value in one write at MTU 517 ‡. Compare throughput at 185 and 517, test an undersized MTU and check the final reason after core integration. Try one bad Open, reconnect, and verify completion with a good one. Use notifications and writes-without-response, drop and resume once, and check that the 200 ms Done grace reaches the phone before disconnect ‡.
9. **Measure current and task headroom.** Log current and internal heap in idle, advertising, pairing, update, both services after teardown, and in sleep. **Expected result.** the board returns to the off-state current after each service and the heap returns to a stable floor after repeated cycles ‡. Measure high-water marks for the 6 KB NimBLE host task and 8 KB main task while doing a real SRP handshake or full update ‡.
10. **Remove power.** With the panel in deep sleep, remove both cell and USB. **Expected result.** the image remains, including after a subsequent paired reboot ‡. Make sure the code no longer pairs the board. Measure panel deep-sleep current and check for unintended power from SPI pins ‡.
