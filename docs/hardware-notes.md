# Hardware and platform notes for firmware review

Researched on 12 November 2026 for the ESP32-S3 + SX1262 firmware (sensor, siren controller, gateway). It answers eight questions with facts a reviewer can check the firmware against. It was written after reading [protocol.md](protocol.md) and [requirements/sensor-board.md](requirements/sensor-board.md).

## How to read this

Every fact carries one label.

| Label | Meaning |
| --- | --- |
| **P** | Read in the primary source during this research: a datasheet, vendor documentation or an official repository, at the linked address. |
| **P-calc** | My own arithmetic or reasoning on figures read in a primary source. The inputs are verified; the result is not a vendor statement. |
| **S** | From a secondary source: a forum, a community firmware, a third-party repository. |
| **U** | Could not verify. Treat as unknown until measured or read. |

Source text was read as files where possible (raw repository files, PDF text), not through summaries. Version-specific facts name the version they were read at.

## Findings that change the plan

| # | Finding | Section |
| --- | --- | --- |
| 1 | The current stable ESP-IDF is v6.1. It ships Mbed TLS 4.1, where `mbedtls/ccm.h` and `mbedtls/ecdsa.h` are private headers. The supported interface is PSA Crypto. | 1, 2 |
| 2 | On ESP-IDF v5.5.6 the ESP32-S3 hardware AES path allocates heap memory for every AES block. On v6.1 it does not, by default. | 2 |
| 3 | RadioLib 8.0.0 came out on 7 November 2026 and breaks the 7.x interface. It allocates heap on every SPI transfer unless `RADIOLIB_STATIC_ONLY` is set. | 4 |
| 4 | protocol.md says channel activity detection takes "about two symbols: 2 ms at SF7, 66 ms at SF12". Semtech measured 2.7 ms and 93 ms for two symbols, and recommends four symbols from SF9 up: 39 ms at SF10, 159 ms at SF12. | 3 |
| 5 | An SX1262 at +14 dBm draws 90 mA with the normal +22 dBm matching. The 45 mA figure needs a different matching network. | 3 |
| 6 | The pin plan puts LoRa busy and interrupt on GPIO15 and GPIO16. Those are the only pins that take a 32 kHz crystal. The Heltec board has that crystal fitted. | 5, 6 |
| 7 | The Heltec V3 uses a CP2102 USB-UART bridge. Its native USB pins are not wired to the socket. The hub will not see Espressif's USB vendor number. | 5, 7 |
| 8 | On the ESP32-S3, `ext1` wake uses one level for all pins. ESP-IDF v6.1 adds a deep-sleep GPIO wake with a level per pin; v6.0.3 and v5.5.6 do not have it. | 6 |

---

## 1. ESP-IDF

### Releases

| Fact | Label | Source |
| --- | --- | --- |
| Latest releases: v6.1 (27 Aug 2026), v6.0.3 (2 Sep 2026), v5.5.6 (16 Oct 2026), v5.4.4 (17 Apr 2026). | P | [ESP-IDF releases][idf-rel] |
| The "stable" documentation address resolves to v6.1. | P | [stable docs][idf-stable] |
| Each minor release is supported for 30 months: 12 months "Service" (recommended for new projects), then 18 months "Maintenance" (high-severity and security fixes only). | P | [support policy][idf-support] |
| v5.2.x is marked end of life in Espressif's version feed. | P | [idf_versions.json][idf-json] |
| `stack.md` says "ESP-IDF, current stable release, pinned". Today that means v6.1. `sensor-board.md` links the v5.4 GPIO reference. | P | repo docs |

### Support status on 12 November 2026

| Line | First release | Latest | Service ends | End of life | Label |
| --- | --- | --- | --- | --- | --- |
| v6.1 | 27 Aug 2026 | v6.1 | about Aug 2027 | about Feb 2029 | P-calc |
| v6.0 | 20 Mar 2026 | v6.0.3 | about Mar 2027 | about Sep 2028 | P-calc |
| v5.5 | 21 Jul 2025 | v5.5.6 | ended about Jul 2026 | about Jan 2028 | P-calc |
| v5.4 | 4 Jan 2025 | v5.4.4 | ended about Jan 2026 | about Jul 2027 | P-calc |

Dates are release date plus 12 and 30 months. Espressif publishes the exact dates only as a chart image, which was not read.

### Mbed TLS version shipped

Read from `include/mbedtls/build_info.h` at the commit each ESP-IDF tag pins.

| ESP-IDF tag | Mbed TLS | Fork commit | Label | Source |
| --- | --- | --- | --- | --- |
| v6.1 | 4.1.0 | `a2b32072` | P | [build_info.h][mbed41-ver] |
| v6.0.3 | 4.1.1 | `ce3f3485` | P | [build_info.h][mbed411-ver] |
| v5.5.6 | 3.6.7 | `2b96dd8e` | P | [build_info.h][mbed36-ver] |
| v5.4.4 | 3.6.5 | `ffb280bb` | P | [espressif/mbedtls][mbed-fork] |

Espressif uses its own fork of Mbed TLS with patches for hardware routines. **P**, [Mbed TLS guide][idf-mbedtls-doc].

### What the v6 line changes for this project

| Change | Label | Source |
| --- | --- | --- |
| "ESP-IDF v6.0 upgrades to MbedTLS v4.x and adopts the new PSA Crypto API". Legacy `mbedtls_*` crypto calls "may no longer compile". | P | [v6.0 notes][idf-v60] |
| `psa_crypto_init()` must run before any crypto call. ESP-IDF calls it during normal start-up. | P | [v6.0 notes][idf-v60] |
| Default C++ standard is gnu++26. Default libc changed from Newlib to Picolibc. Minimum CMake 3.22, Python 3.10. | P | [v6.0 notes][idf-v60] |
| `esp_deep_sleep_enable_gpio_wakeup` was renamed `esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown`. In v6.1 it is available on the ESP32-S3 for GPIO0–21. | P | [v6.0 notes][idf-v60], [soc_caps.h v6.1][soc-caps-61] |
| `wifi_provisioning` left ESP-IDF and became `network_provisioning` in idf-extra-components. `protocomm` stays. Security versions 0 and 1 are off by default. This touches the Bluetooth pairing plan in `stack.md`. | P | [v6.0 notes][idf-v60] |
| The USB host component and esp-mqtt left the core. The WebSocket client and mDNS were already outside it. | P | [v6.0 notes][idf-v60] |
| v6.1 changed the stored format of some PSA persistent keys. The project does not plan to use them. | P | [v6.1 notes][idf-v61] |

---

## 2. Mbed TLS on ESP-IDF

### AES-CCM interface

| Fact | Label | Source |
| --- | --- | --- |
| **Mbed TLS 3.6.7 (ESP-IDF v5.5.6).** Public header `mbedtls/ccm.h`. Calls: `mbedtls_ccm_init`, `mbedtls_ccm_setkey`, `mbedtls_ccm_encrypt_and_tag`, `mbedtls_ccm_auth_decrypt`, `mbedtls_ccm_free`, plus the streaming set `mbedtls_ccm_starts`, `_set_lengths`, `_update_ad`, `_update`, `_finish`. | P | [ccm.h 3.6.7][mbed36-ccmh] |
| **Mbed TLS 4.1 (ESP-IDF v6.x).** The same header now lives at `mbedtls/private/ccm.h`. Espressif's migration guide says to avoid headers under `mbedtls/private/`; they "may change without notice". | P | [fork tree 4.1.0][mbed41-tree], [migration guide][idf-mig-sec] |
| On 4.1 the public calls are `psa_import_key`, `psa_aead_encrypt`, `psa_aead_decrypt`. The algorithm for this protocol is `PSA_ALG_AEAD_WITH_SHORTENED_TAG(PSA_ALG_CCM, 8)` with key type AES. | P | [crypto.h][mbed41-cryptoh], [crypto_values.h][mbed41-values] |
| The built-in PSA AEAD code is a wrapper around the same `mbedtls_ccm_*` functions. | P | [psa_crypto_aead.c][mbed41-aead] |

### Nonce and tag lengths

| Fact | Label | Source |
| --- | --- | --- |
| Nonce: 7 to 13 bytes. Code check: `iv_len < 7 \|\| iv_len > 13` is rejected. | P | [ccm.c 3.6.7][mbed36-ccmc] |
| Tag: 4, 6, 8, 10, 12, 14 or 16 bytes. Zero is allowed only in the CCM* calls. Code check: `tag_len == 2 \|\| tag_len > 16 \|\| tag_len % 2 != 0` is rejected. | P | [ccm.c 3.6.7][mbed36-ccmc] |
| PSA accepts CCM nonces of 7 to 13 bytes. Its default CCM nonce length is 13. | P | [psa_crypto.c][mbed41-psac], [crypto_sizes.h][mbed41-sizes] |
| The protocol's 13-byte nonce and 8-byte tag are valid on both versions. | P-calc | above |
| The tag comparison is constant-time (`mbedtls_ct_memcmp`). On a failed check the output buffer is zeroised and `MBEDTLS_ERR_CCM_AUTH_FAILED` is returned. | P | [ccm.c 3.6.7][mbed36-ccmc] |

### Hardware AES and its Kconfig options

| Fact | Label | Source |
| --- | --- | --- |
| The ESP32-S3 has AES, SHA and MPI (big-number) accelerators. It has no ECC and no ECDSA peripheral: `SOC_ECC_SUPPORTED` and `SOC_ECDSA_SUPPORTED` are absent. | P | [soc_caps.h v6.1][soc-caps-61] |
| `CONFIG_MBEDTLS_HARDWARE_AES` defaults to on. So hardware AES is used by default. | P | [Kconfig v6.1][idf-mbed-kconfig-61], [Kconfig v5.5.6][idf-mbed-kconfig-55] |
| `CONFIG_MBEDTLS_AES_USE_INTERRUPT` defaults to on. The interrupt is used only for inputs longer than 2,000 bytes; shorter ones busy-wait. | P | [esp_aes_dma_core.c v5.5.6][idf-aes-dma-55] |
| `CONFIG_MBEDTLS_AES_HW_SMALL_DATA_LEN_OPTIM` exists in v6.1 and defaults to on. It uses the peripheral's block mode for short inputs. It does not exist in v5.5.6. | P | [Kconfig v6.1][idf-mbed-kconfig-61] |
| `CONFIG_MBEDTLS_CCM_C` defaults to on in both versions. | P | Kconfig, both |
| In v6.1, hardware AES sets `MBEDTLS_PSA_ACCEL_ALG_CCM` and removes the built-in software AES (`#undef MBEDTLS_AES_C`). | P | [esp_config.h v6.1][idf-espconfig-61] |
| Exactly how a PSA CCM call reaches the AES peripheral in v6.1 was not traced end to end. | U | — |

### Does CCM work without heap allocation?

Not by default, on either version.

| Version | Where the heap is used | Label | Source |
| --- | --- | --- | --- |
| v5.5.6 | `mbedtls_ccm_setkey` calls `mbedtls_cipher_setup`, which allocates the AES context with `mbedtls_calloc`. It is freed in `mbedtls_ccm_free`. This is once per key set-up, not per packet. The heap-free `block_cipher` path is only chosen when `MBEDTLS_CIPHER_C` is off, and ESP-IDF defines it. | P | [ccm.c][mbed36-ccmc], [cipher.c][mbed36-cipherc], [config_adjust_legacy_crypto.h][mbed36-adjust], [esp_config.h v5.5.6][idf-espconfig-55] |
| v5.5.6 | With hardware AES on, every single-block AES call goes through `esp_aes_process_dma`, which allocates DMA descriptors with `heap_caps_aligned_calloc` and frees them. CCM calls AES once per 16-byte block, so each packet does several allocations. | P | [dma/esp_aes.c][idf-aes-55], [esp_aes_dma_core.c line 1145][idf-aes-dma-55] |
| v6.1 | Single-block AES uses `esp_aes_block` (no DMA, no allocation) while `CONFIG_MBEDTLS_AES_HW_SMALL_DATA_LEN_OPTIM` is on. | P | [esp_aes.c v6.1][idf-aes-61] |
| v6.1 | `psa_import_key` stores key bytes in a heap buffer unless `MBEDTLS_PSA_STATIC_KEY_SLOTS` is defined. ESP-IDF v6.1 has no Kconfig option for it. | P | [psa_crypto.c][mbed41-psac], [Kconfig v6.1][idf-mbed-kconfig-61] |
| v6.1 | The ESP AES PSA cipher driver calls `malloc(sizeof(esp_aes_context))` at set-up. | P | [psa_crypto_driver_esp_aes.c][idf-psa-aes] |
| both | Mbed TLS allocations go through `esp_mbedtls_mem_calloc`. `CONFIG_MBEDTLS_CUSTOM_MEM_ALLOC` lets the application supply its own `calloc`/`free` with `mbedtls_platform_set_calloc_free`, for example a fixed pool. | P | [esp_mem.c][idf-espmem], [Kconfig v5.5.6][idf-mbed-kconfig-55] |

Ways to keep packet handling off the heap: set up the key context once at start-up and keep it; on v5.5.6 either turn hardware AES off (software AES keeps its state in the context) or accept the per-block allocation; or give Mbed TLS a static pool. Each needs a heap-trace check on the target. **P-calc.**

### ECDSA P-256 verification

| Fact | Label | Source |
| --- | --- | --- |
| 3.6.7: `mbedtls_ecdsa_verify(grp, hash, hlen, Q, r, s)` for raw `r`,`s`; `mbedtls_ecdsa_read_signature(ctx, hash, hlen, sig, slen)` for a DER signature. | P | [ecdsa.h 3.6.7][mbed36-ecdsah] |
| 4.1: `ecdsa.h`, `ecp.h` and `bignum.h` are private. The public call is `psa_verify_hash` (or `psa_verify_message`) with `PSA_ALG_ECDSA(PSA_ALG_SHA_256)` and key type `PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1)`. | P | [fork tree 4.1.0][mbed41-tree], [crypto.h][mbed41-cryptoh] |
| PSA imports an ECC public key as a SEC1 uncompressed point: one `0x04` byte, then X, then Y. That is 65 bytes for P-256. protocol.md section 9 stores 64 bytes. The firmware must add the `0x04` byte. | P | [crypto.h][mbed41-cryptoh] |
| The raw signature layout PSA expects (`r` then `s`, 32 bytes each) was not read in this session. | U | — |
| No hardware ECDSA or ECC on the ESP32-S3. `CONFIG_MBEDTLS_HARDWARE_ECC` and `CONFIG_MBEDTLS_HARDWARE_ECDSA_VERIFY` depend on capabilities the S3 lacks. | P | [Kconfig v6.1][idf-mbed-kconfig-61], [soc_caps.h][soc-caps-61] |
| `CONFIG_MBEDTLS_HARDWARE_MPI` defaults to on. Its help text says the accelerated operations "are used by RSA". Whether it speeds up P-256 was not measured. | P / U | [Kconfig v6.1][idf-mbed-kconfig-61] |
| Mbed TLS big numbers allocate from the heap (`mbedtls_calloc` in `bignum.c`). So ECDSA verification uses the heap. | P | [bignum.c 3.6.7][mbed36-bignum] |
| A separate small P-256 implementation, `p256-m`, is in the 4.1 source tree and is built by ESP-IDF v6.1, but `MBEDTLS_PSA_P256M_DRIVER_ENABLED` is not exposed in ESP-IDF's configuration. It is generally described as not using the heap; that was not re-read here. | P / U | [fork tree 4.1.0][mbed41-tree], [esp_config.h v6.1][idf-espconfig-61] |
| ESP-IDF's own signed-app check without Secure Boot uses RSA on the S3 (`SOC_SECURE_BOOT_V2_RSA` only). A P-256 check has to be the project's own code. | P | [bootloader Kconfig][idf-boot-kconfig], [soc_caps.h][soc-caps-61] |
| Verification time on the S3 is unknown. | U | — |

### Building the same code for host tests on macOS

| Fact | Label | Source |
| --- | --- | --- |
| ESP-IDF has a preview `linux` target: `idf.py --preview set-target linux`. The FreeRTOS POSIX simulator behind it "currently also works on macOS". | P | [host apps guide][idf-host] |
| The `mbedtls` component is listed as supported on that target (simulation: yes, mock: no). Its CMake file has a branch for a Darwin host. | P | [host apps guide][idf-host], [mbedtls CMakeLists v6.1][idf-mbed-cmake] |
| The other route is to build upstream Mbed TLS at the same version with CMake and link the core against it. This was not tried. | U | — |
| A host build uses software AES. It does not exercise the hardware path or its heap behaviour. | P-calc | — |
| Code written against `mbedtls_ccm_*` builds on 3.6 and not, publicly, on 4.1. A thin wrapper in the platform layer keeps the core independent of the choice. | P-calc | — |
| Whether PSA calls are usable on ESP-IDF v5.5.6 was not established. The name `MBEDTLS_PSA_CRYPTO_C` does not appear in that version's configuration header. Do not assume one code path builds on both lines. | P / U | [esp_config.h v5.5.6][idf-espconfig-55] |

---

## 3. SX1262

All from the SX1261/2 datasheet **Rev 2.2, December 2024** ([datasheet][sx-ds]) unless another source is named. Section and table numbers are the datasheet's.

### Current

| Mode | Condition | Typical | Label | Where |
| --- | --- | --- | --- | --- |
| Receive, DC-DC | LoRa 125 kHz | 4.6 mA | P | Table 3-5 |
| Receive, DC-DC | LoRa 125 kHz, boosted gain | 5.3 mA | P | Table 3-5 |
| Receive, LDO | LoRa 125 kHz | 8.8 mA | P | Table 3-5 |
| Receive, LDO | LoRa 125 kHz, boosted gain | 10.1 mA | P | Table 3-5 |
| Transmit +22 dBm | 868/915 MHz, +22 dBm match | 118 mA | P | Table 3-6 |
| Transmit +14 dBm | 868/915 MHz, +22 dBm match | 90 mA | P | Table 3-6 |
| Transmit +14 dBm | 868/915 MHz, "+14 dBm / optimal settings" match | 45 mA | P | Table 3-6 |
| Standby | STDBY_RC | 0.6 mA | P | Table 3-5 |
| Standby | STDBY_XOSC | 0.8 mA | P | Table 3-5 |
| Sleep, cold start | all blocks off | 160 nA | P | Table 3-5 |
| Sleep, warm start | configuration retained | 600 nA | P | Table 3-5 |
| Sleep, warm start | configuration retained + RC64k | 1.2 µA | P | Table 3-5 |

- The transmit figures use DC-DC for the core; the power amplifier runs from VBAT. **P**, Table 3-6 note 3.
- The "optimal settings" for +14 dBm are `paDutyCycle` 0x02, `hpMax` 0x02, `SetTxParams` +22. They "require a dedicated matching / PA load impedance" and make nominal power "sub-optimal or unachievable". **P**, section 13.1.14.1, Table 13-21.
- Never set `paDutyCycle` above 0x04 or `hpMax` above 0x07 on the SX1262. **P**, section 13.1.14.
- Over-current protection resets to 60 mA and becomes 140 mA after `SetPaConfig` on the SX1262. It is rewritten on each `SetPaConfig`. **P**, section 5.1, Table 5-2.
- Supply range is 1.8 to 3.7 V; absolute maximum 3.9 V. A full lithium cell (4.2 V) must not feed it directly. +22 dBm needs VBAT = 3.3 V; at 2.7 V the output is +20 dBm. **P**, sections 3.2, 3.3, Table 4-4.
- Sleep is entered with `SetSleep` (0x84); bit 2 chooses warm start. The chip ignores SPI for about 500 µs afterwards. BUSY stays high in sleep. A falling edge on NSS wakes it. **P**, section 13.1.1.
- Wake to STDBY_RC takes 3.5 ms cold and 0.34 ms warm. STDBY_RC to RX 83 µs, to TX 126 µs. **P**, Table 8-2.
- Rev 2.2 removed "wake-up on RTC timeout" from the `SetSleep` description. **P**, revision history.
- Warm start keeps only the active modem's configuration. The Rx gain register (0x08AC) is not kept unless it is added to the retention list (registers 0x029F–0x02A1). **P**, sections 9.6, 13.1.1.

### Channel activity detection

| Fact | Label | Where |
| --- | --- | --- |
| Configured with `SetCadParams` (0x88): `cadSymbolNum`, `cadDetPeak`, `cadDetMin`, `cadExitMode`, `cadTimeout`. Started with `SetCAD` (0xC5). | P | 13.4.7, 13.1.8 |
| `cadSymbolNum` is a code: 0x00 = 1 symbol, 0x01 = 2, 0x02 = 4, 0x03 = 8, 0x04 = 16. | P | Table 13-72 |
| Exit mode 0x00 returns to STDBY_RC. Exit mode 0x01 stays in receive after a detection, until a packet or `cadTimeout` × 15.625 µs. | P | Table 13-73 |
| Results arrive as IRQ bit 7 `CadDone` and bit 8 `CadDetected`. | P | Table 8-4 |
| It detects preamble or data symbols. Earlier chips detected preamble only. | P | 6.1.5 |
| After the chosen symbols the radio stays in receive "for around half a symbol" to process the result. | P | 6.1.5 |
| "Choosing the right value is not easy" for the two thresholds; the datasheet points to AN1200.48. | P | 13.4.7 |

Measured duration and Semtech's best settings, 125 kHz, from [AN1200.48 Rev 2.1][sx-an48] (Table 1 and Tables 93–99). **P.**

| SF | Symbol | 2-symbol CAD | 4-symbol CAD | Best setting | Energy at best setting |
| --- | --- | --- | --- | --- | --- |
| 7 | 1.024 ms | 2.66 ms | 4.72 ms | 2 symbols, peak 22, min 10 | 2.84 nAh |
| 8 | 2.048 ms | 5.39 ms | 9.48 ms | 2 symbols, peak 22, min 10 | 5.75 nAh |
| 9 | 4.096 ms | 10.96 ms | 19.15 ms | 4 symbols, peak 23, min 10 | 20.44 nAh |
| 10 | 8.192 ms | 22.35 ms | 38.73 ms | 4 symbols, peak 24, min 10 | 41.36 nAh |
| 11 | 16.384 ms | 45.64 ms | 78.41 ms | 4 symbols, peak 25, min 10 | 134.55 nAh |
| 12 | 32.768 ms | 93.26 ms | 158.79 ms | 4 symbols, peak 28, min 10 | 169.54 nAh |

Reliability limits and advice from AN1200.48. **P.**

- One-symbol CAD "is very prone to false detection" and is "not recommended".
- A higher `cadDetPeak` cuts false detections and also cuts sensitivity. Change it in steps of 1. `cadDetMin` stays at 10.
- With the best settings at SF7, detection is 97% at −123 dBm, 74% at −125 dBm and 1% at −130 dBm. So a weak far-away sender is often not detected.
- The tests aimed for a false-detection rate below 1% with no signal present.
- The tested frames ran back to back, so detection landed on preamble or data at random. A CAD that lands late in a packet reports "busy" for a packet that is nearly over.
- Firmware workaround, section 3.1: when a receive timeout is followed straight away by a CAD, put the radio to **sleep**, not standby, between the two. It costs about 1.3 ms and 0.23 nAh each time.
- [AN1200.85][sx-an85] adds that another device may start between the check and the transmission, "which is why time randomization is always recommended". **P.**

Conflict with protocol.md: it gives "about two symbols: 2 ms at SF7, 66 ms at SF12". Two symbols really take 2.7 ms and 93 ms, and Semtech's setting for SF9–SF12 is four symbols. **P-calc.**

### Receive timeout and "stop on preamble"

| Fact | Label | Where |
| --- | --- | --- |
| `SetRx` (0x82) takes a 24-bit timeout in steps of 15.625 µs. 0x000000 = single receive, no timeout. 0xFFFFFF = continuous. Maximum 262 s. | P | 13.1.5 |
| After a packet or a timeout the chip returns to STDBY_RC (single modes). | P | 13.1.5 |
| By default the timer stops only when the LoRa **header** is detected. Until then the timeout ends reception, even mid-preamble. | P | 13.1.5 |
| `StopTimerOnPreamble` (0x9F) with 0x01 stops the timer at preamble detection. Then the radio stays in receive until a packet arrives. A false detection can hold it in receive "for an unexpected long period". | P | 13.1.6 |
| `SetLoRaSymbNumTimeout` (0xA0) sets how many symbols the modem uses to confirm a detection. 0 = lock on the first symbol. Non-zero = raise `RxTimeout` if not locked after that many symbols. Valid values: even numbers to 64, then steps of 8 to 248. | P | 13.4.9, 9.6 |
| IRQ bits: 0 TxDone, 1 RxDone, 2 PreambleDetected, 4 HeaderValid, 5 HeaderErr, 6 CrcErr, 9 Timeout. | P | Table 8-4 |
| With the default (stop on header), a listening window must stay open until the reply's header is in: 8 preamble + 4.25 sync + 8 header symbols after the reply starts. At SF9 that is about 83 ms; at SF12 about 664 ms. This assumes the header fills the first 8 payload symbols, which is common LoRa knowledge and not stated in the datasheet. protocol.md's window of "50 ms plus 8 symbols late" needs checking against whichever stop condition the firmware uses. | P-calc | 13.1.5, 6.1.3 |

### Sync word

| Fact | Label | Where |
| --- | --- | --- |
| LoRa sync word registers: 0x0740 (MSB, reset 0x14) and 0x0741 (LSB, reset 0x24). | P | Table 12-1 |
| "Set to 0x3444 for Public Network. Set to 0x1424 for Private Network." | P | Table 12-1 |
| The one-byte value 0x12 in protocol.md maps to 0x1424. Semtech's driver writes only the high nibbles (`sx126x_set_lora_sync_word`). RadioLib builds the same bytes from `syncWord` 0x12 and `controlBits` 0x44. | P | [sx126x.c][sx-drv-c], [SX126x_config.cpp][rl-config] |

### Low data rate optimisation, payload, header

| Fact | Label | Where |
| --- | --- | --- |
| LDRO "is usually recommended when a LoRa symbol time is equal or above 16.38ms". At 125 kHz that is SF11 (16.384 ms) and SF12. protocol.md agrees. | P | 6.1.1.4 |
| LDRO is `SetModulationParams` parameter 4: 0x00 off, 0x01 on. Both ends must agree. | P | Table 13-50 |
| Payload length is one byte, 0x00 to 0xFF. Maximum 255 bytes. | P | Table 13-68 |
| Preamble length is 16 bits, 1 to 65,535 symbols. The datasheet's default packet uses 12; protocol.md uses 8. | P | Table 13-66, 6.1.3 |
| Header type 0x00 = explicit, 0x01 = implicit. CRC 0x01 = on. IQ 0x00 = standard. | P | Tables 13-67, 13-69, 13-70 |
| The modem tolerates a frequency offset of ±25% of bandwidth, and at most ±200 ppm at SF10, ±100 ppm at SF11, ±50 ppm at SF12 without losing sensitivity. | P | Table 3-8 |

### RSSI

| Fact | Label | Where |
| --- | --- | --- |
| Instantaneous RSSI: `GetRssiInst` (0x15). Power in dBm = −RssiInst / 2. It is read while in receive. | P | 13.5.4 |
| Packet values: `GetPacketStatus` (0x14) gives `RssiPkt` (−x/2 dBm), `SnrPkt` (two's complement, x/4 dB) and `SignalRssiPkt` (−x/2 dBm). | P | 13.5.3 |
| RSSI depends on the board's matching network. Calibration registers default to Semtech's 868–915 MHz evaluation board. | P | 6.1.6 |
| The settling time before the first valid instantaneous RSSI is tabled for GFSK only. For LoRa it is not stated. | U | Table 13-82 |

### TCXO on DIO3, RF switch on DIO2

| Fact | Label | Where |
| --- | --- | --- |
| `SetDIO3AsTCXOCtrl` (0x97) takes a voltage code and a 24-bit delay in 15.625 µs steps. Codes: 0x00 1.6 V, 0x01 1.7 V, 0x02 1.8 V, 0x03 2.2 V, 0x04 2.4 V, 0x05 2.7 V, 0x06 3.0 V, 0x07 3.3 V. | P | 13.3.6 |
| VBAT must be at least 200 mV above the chosen TCXO voltage. | P | 4.1.4, 13.3.6 |
| The chip powers the TCXO only in STDBY_XOSC, FS, TX and RX, and waits `delay` before using it. To avoid paying the delay on every transmit or receive, go to STDBY_XOSC first. | P | 13.3.6 |
| After power-on or a cold-start wake with a TCXO fitted, `XOSC_START_ERR` is set. This is expected. Clear it with `ClearDeviceErrors`. | P | 13.3.6 |
| With a TCXO the automatic start-up calibration fails. Run a full `Calibrate` after `SetDIO3AsTCXOCtrl`. | P | 9.2.1 |
| Image calibration defaults to 902–928 MHz. For 863–870 MHz call `CalibrateImage(0xD7, 0xDB)`. | P | Table 9-2 |
| Leaving TCXO mode needs a full chip reset. | P | 4.1.4 |
| With a plain crystal, DIO3 is free and the chip uses internal trimming capacitors (registers 0x0911, 0x0912). | P | 4.1.3 |
| `SetDIO2AsRfSwitchCtrl` (0x9D) with 1: DIO2 is high in TX and low in every other mode, including sleep and receive. | P | 13.3.5 |
| A module with separate TXEN and RXEN lines still needs RXEN driven. DIO2 only signals transmit. | P-calc | 13.3.5 |

### Time on air

| Fact | Label | Source |
| --- | --- | --- |
| Datasheet Rev 2.2 no longer prints the formula. Section 6.1.4 says only: "The Time-On-Air of the LoRa packet is shown in the SX126x drivers." | P | [datasheet][sx-ds] 6.1.4 |
| The formula is `sx126x_get_lora_time_on_air_numerator` in Semtech's driver v2.5.0, shown below. | P | [sx126x.c][sx-drv-c] |
| Recomputing protocol.md's time-on-air table with this formula gives the same 24 values. | P-calc | — |

For SF7 to SF12, with payload `PL` bytes, CRC flag `CRC`, explicit-header flag `H` (1 when explicit), LDRO flag `DE`, coding rate 4/(4+`CR`) and `Npre` preamble symbols:

```
payload symbols = ceil( max(8·PL + 16·CRC − 4·SF + 8 + 20·H, 0) / (4·(SF − 2·DE)) ) · (CR + 4)
total symbols   = payload symbols + Npre + 12 + 0.25
time            = total symbols · 2^SF / BW
```

### Known limitations and workarounds (datasheet section 15)

| # | Problem | Workaround | Applies here? | Label |
| --- | --- | --- | --- | --- |
| 15.1 | Poor modulation quality at 500 kHz bandwidth. | Before each transmit, bit 2 of register 0x0889: 0 for 500 kHz, 1 otherwise. | Set to 1 (125 kHz). | P |
| 15.2 | The SX1262 clamps transmit power too eagerly on antenna mismatch, losing 5–6 dB. | Set bits 4–1 of 0x08D8 (`TxClampConfig`) to 1111. Redo after power-on reset or a cold-start wake. | Yes. Matters for the spring antenna. | P |
| 15.3 | In implicit-header receive with a timeout, the timer is not stopped on RxDone and can fire later. | After any receive with timeout: write 0x00 to 0x0902, set bit 1 of 0x0944. | Not with explicit header, but the datasheet says "after ANY Rx with Timeout". | P |
| 15.4 | Packet loss with inverted IQ on long packets. | Bit 2 of 0x0736: 0 for inverted IQ, 1 for standard. | Standard IQ: set to 1. | P |

The CAD-after-timeout workaround in AN1200.48 (above) is a fifth one, outside the datasheet. No separate errata sheet is listed on Semtech's product page. **P**, [product page][sx-page].

---

## 4. RadioLib, and Semtech's driver

### RadioLib

| Fact | Label | Source |
| --- | --- | --- |
| Current version 8.0.0, released 7 November 2026. Before it: 7.8.1 (28 September 2026). | P | [releases][rl-rel] |
| Licence: MIT. | P | [idf_component.yml][rl-idfyml] |
| 8.0.0 is a breaking release: `begin` takes one configuration struct; frequency and bandwidth are integers in Hz; TCXO voltage is an enum; `setPacketSentAction` and similar are replaced by `setIrqAction`; some error codes changed. Most examples on the web are for 7.x. | P | [8.0.0 notes][rl-rel8] |
| It is an ESP-IDF component (`idf_component.yml`, needs IDF ≥ 4.1) and has an official non-Arduino example. | P | [idf_component.yml][rl-idfyml], [ESP-IDF example][rl-example] |

Running on ESP-IDF without Arduino. **P**, [EspHal.h][rl-esphal-h], [EspHal.cpp][rl-esphal-c], [example README][rl-example].

- All hardware access goes through the abstract class `RadioLibHal` (pin mode, read, write, interrupts, delays, time, SPI transfer).
- RadioLib ships a ready ESP-IDF implementation, `EspHal`, in `src/hal/ESP-IDF/`. It is in 7.8.1 and 8.0.0. It uses the `spi_master` driver with `spi_device_polling_transmit`, and `gpio_install_isr_service`.
- Constructor: `EspHal(sck, miso, mosi, host = SPI2_HOST, clockHz = 2000000)`. Then `Module(hal, cs, irq, rst, busy)` and `SX1262(&module)`.
- `EspHal` refuses to build unless `CONFIG_FREERTOS_HZ=1000`, or `RADIOLIB_RELAX_RTOS_TICK=1` is defined.
- `EspHal::yield()` is `taskYIELD()`. Blocking RadioLib calls therefore spin at full CPU and only let equal-priority tasks run.
- Interrupt callbacks are registered with `gpio_isr_handler_add` on a service installed with `ESP_INTR_FLAG_IRAM`. The callback runs in interrupt context.
- The project can write its own `RadioLibHal` subclass instead. That is the way to fit the core's "no heap" rule and its own SPI bus sharing with the e-paper.

Heap use. **P**, [BuildOpt.h][rl-buildopt], [Module.cpp][rl-module].

- By default RadioLib allocates on the heap: `new uint8_t[...]` for every SPI stream transfer in `Module.cpp`, and for some packet buffers in `PhysicalLayer.cpp`.
- `RADIOLIB_STATIC_ONLY=1` removes all of these and uses stack arrays of `RADIOLIB_STATIC_ARRAY_SIZE` (default 256) bytes.
- The example creates `EspHal` and `Module` with `new`. They can be static objects instead.
- `EspHal` itself calls ESP-IDF drivers that allocate at set-up (`spi_bus_initialize`, `gpio_install_isr_service`). **P-calc.**

SX1262 interface in 8.0.0. **P**, [SX126x.h][rl-sx126x-h], [SX126x.cpp][rl-sx126x-c], [SX126x_commands.cpp][rl-commands], [PhysicalLayer.h][rl-phy-h].

| Need | Call | Notes |
| --- | --- | --- |
| Start | `begin(const ConfigLoRa_t&)` | Fields: `frequency` (Hz), `bandwidth` (Hz), `spreadingFactor`, `codingRate` (default 7), `syncWord` (default 0x12), `power` (default 10), `preambleLength` (default 8). Set `codingRate = 5` for 4/5. |
| TCXO | public member `tcxoVoltage`, default `Voltage1V6`; or `setTCXO(voltage, delay = 5000 µs)` | Set the member **before** `begin`. `VoltageNone` for a crystal. If configuration fails with an oscillator start error, `begin` switches to crystal mode and tries again, with only a debug print. |
| Regulator | member `useRegulatorLDO`, default false (DC-DC) | Also `setRegulatorLDO()`, `setRegulatorDCDC()`. |
| RF switch | `setDio2AsRfSwitch(bool)`, `setRfSwitchPins(rxEn, txEn)`, `setRfSwitchTable(...)` | |
| CAD, blocking | `scanChannel()`, `scanChannel(const ChannelScanConfig_t&)` | Returns `RADIOLIB_LORA_DETECTED` or `RADIOLIB_CHANNEL_FREE`. Waits on DIO1 in a loop with **no timeout**. |
| CAD, interrupt | `startChannelScan(cfg)`, then `getChannelScanResult()` | Config fields `symNum`, `detPeak`, `detMin`, `exitMode`, `rxTimeout`. `symNum` is the register code, not a count. |
| CAD defaults | 4 symbols, peak = SF + 13, min = 10, return to standby | Differs from AN1200.48 at SF7 (4 symbols, peak 20 against 2, 22) and SF12 (peak 25 against 28). |
| Receive, blocking | `receive(data, len, timeout)` | Timeout in ms; 0 means five times the airtime of `len` bytes. Polls DIO1 in a loop, with a software safety timeout. |
| Receive, interrupt | `startReceive(timeout, irqFlags, irqMask, len)`, then `readData(data, len)` | `timeout` is raw, in 15.625 µs steps. 0 = single without timeout, 0xFFFFFF = continuous. |
| Symbol timeout | `stageMode(RADIOLIB_RADIO_MODE_RX, &cfg)` then `launchMode()`, with `cfg.receive.syncSymbols` | New in 8.0.0. The direct call `setLoRaSymbNumTimeout(n)` is `protected` unless `RADIOLIB_LOW_LEVEL=1` is defined. |
| Raw commands | `setCad`, `setRx`, `setDioIrqParams`, `writeRegister`, `readRegister` | All `protected` unless `RADIOLIB_LOW_LEVEL=1`. No named call for `StopTimerOnPreamble` was found; it would be a raw SPI command. |
| Transmit | `transmit(data, len)` blocking; `startTransmit` then `finishTransmit()` | |
| Interrupts | `setDio1Action(func)`, `clearDio1Action()`, generic `setIrqAction(func)` | `getIrqFlags()`, `clearIrqFlags()` to read the cause. |
| Sync word | `setSyncWord(syncWord, controlBits = 0x44)` | |
| RSSI | `getRSSI()` last packet; `getRSSI(false)` instantaneous; `getSNR()` | |
| Sleep | `sleep()`, `sleep(bool retainConfig)`, `standby()`, `standby(mode)` | |
| Power | `setOutputPower(power)`, `setOutputPower(power, optimize)`, `setPaConfig(...)`, `setCurrentLimit(mA)` | 8.0.0 carries its own measured PA table. |
| LDRO | `autoLDRO()`, `forceLDRO(bool)` | |
| Airtime | `getTimeOnAir(len)` | Microseconds. |
| Gain | `setRxBoostedGainMode(enable, persist = true)` | `persist` adds the register to the retention list. |

Datasheet workarounds: RadioLib has `fixSensitivity` (15.1), `fixPaClamping` (15.2, called in `SX1262::begin`), `fixImplicitTimeout` (15.3, called in `finishReceive`) and `fixInvertedIQ` (15.4). **P**, [SX126x.cpp][rl-sx126x-c], [SX1262.cpp][rl-sx1262-c]. The AN1200.48 sleep-before-CAD workaround was not found in the files read. **U.**

Blocking against interrupt-driven: the blocking calls (`transmit`, `receive`, `scanChannel`) busy-poll the interrupt pin. The `start…` calls return at once; the application waits for DIO1 its own way and then calls `readData`, `finishTransmit` or `getChannelScanResult`. Only the second style lets the CPU sleep while the radio works. **P.**

### Semtech `sx126x_driver`

| Fact | Label | Source |
| --- | --- | --- |
| Current version v2.5.0, released 15 October 2025. Semtech's product page still links v2.3.2. | P | [repository][sx-drv], [product page][sx-page] |
| Licence: "The Clear BSD License" (BSD-3-Clause-Clear). | P | [LICENSE.txt][sx-drv-lic] |
| Plain C. One file of chip commands (`sx126x.c`/`.h`), register names (`sx126x_regs.h`), optional LR-FHSS and BPSK files. CMake support since 2.4.0. | P | [README][sx-drv] |
| The user writes four functions: `sx126x_hal_write`, `sx126x_hal_read`, `sx126x_hal_reset`, `sx126x_hal_wakeup`. Each takes a `const void* context`. | P | [sx126x_hal.h][sx-drv-hal] |
| No dynamic allocation in `sx126x.c`. | P | [sx126x.c][sx-drv-c] |
| It is a thin command layer: one function per chip command, such as `sx126x_set_cad_params`, `sx126x_set_rx_with_timeout_in_rtc_step`, `sx126x_stop_timer_on_preamble`, `sx126x_set_dio3_as_tcxo_ctrl`, `sx126x_get_rssi_inst`. BUSY handling, interrupts and sequencing are the user's job. | P | [sx126x.c][sx-drv-c] |
| Workarounds are separate calls the user must make: `sx126x_cfg_tx_clamp` (15.2), `sx126x_stop_rtc` (15.3), `sx126x_tx_modulation_workaround` (15.1). | P | [sx126x.c][sx-drv-c] |

---

## 5. Heltec WiFi LoRa 32 V3 and V3.2

Sources: Heltec datasheet for V3 ([Rev 1.1][ht-ds-v3]), datasheet for V3.2 ([document V1.3][ht-ds-v32]), V3.2 schematic ([PDF][ht-sch-v32]), the board definition in Espressif's Arduino core ([pins_arduino.h][ht-arduino]) and Heltec's own library ([board-config.h][ht-lib]). The V3 schematic PDF is an image and could not be read as text.

### Pin map

| Function | GPIO | Label | Source |
| --- | --- | --- | --- |
| SX1262 NSS | 8 | P | [pins_arduino.h][ht-arduino], [board-config.h][ht-lib] |
| SX1262 SCK | 9 | P | same |
| SX1262 MOSI | 10 | P | same |
| SX1262 MISO | 11 | P | same |
| SX1262 RST | 12 | P | same |
| SX1262 BUSY | 13 | P | same |
| SX1262 DIO1 | 14 | P | same (named `DIO0` in the Arduino file) |
| SX1262 DIO2 | antenna switch, not on a GPIO | S | [Meshtastic][ht-mesh] (`SX126X_DIO2_AS_RF_SWITCH`); the V3.2 schematic text has an `ANT_SW_CTRL` net beside DIO2 |
| SX1262 DIO3 | TCXO supply, not on a GPIO | S | [Meshtastic][ht-mesh]; a DIO3 net is on the [V3.2 schematic][ht-sch-v32] |
| Battery voltage sense | 1 (ADC1 channel 0) | P | [V3 datasheet][ht-ds-v3] |
| Battery sense enable (`ADC_Ctrl`) | 37 | S | [Meshtastic][ht-mesh] (`ADC_CTRL 37`). An `ADC_Ctrl` net is on the [V3.2 schematic][ht-sch-v32]; Heltec's pin table does not name it. |
| `Vext` switched 3.3 V output | 36, active low | P | [V3 datasheet][ht-ds-v3], [heltec.h][ht-lib-h] |
| LED | 35 | P | [V3 datasheet][ht-ds-v3] |
| Button "PRG" | 0 | P | [V3 datasheet][ht-ds-v3] |
| Button "RST" | CHIP_PU | P | [V3 datasheet][ht-ds-v3] |
| OLED SDA, SCL, RST | 17, 18, 21 | P | [pins_arduino.h][ht-arduino] |
| UART0 to CP2102 | TX 43, RX 44 | P | [V3 datasheet][ht-ds-v3] |
| 32.768 kHz crystal | 15, 16 (`32K_XP`, `32K_XN`) | P for V3.2 | [V3.2 schematic][ht-sch-v32] shows the part; GPIO numbers from the [S3 datasheet][s3-ds]. Whether it is fitted on delivered boards, and on V3/V3.1, was not verified. [Meshtastic][ht-mesh] sets `HAS_32768HZ` for the V3. |

Header pins. **P**, [V3 datasheet][ht-ds-v3] Tables 2.2-1 and 2.2-2.

- J2: GND, 5V, Ve, Ve, 44, 43, RST, 0, 36, 35, 34, 33, 47, 48, 26, 21, 20, 19.
- J3: GND, 3V3, 3V3, 37, 46, 45, 42, 41, 40, 39, 38, 1, 2, 3, 4, 5, 6, 7.
- GPIO8–14 (the radio's SPI bus and control lines) and GPIO15–18 are **not** on the headers.

### Other board facts

| Fact | Label | Source |
| --- | --- | --- |
| Chip: ESP32-S3FN8. 8 MB flash in the package. No PSRAM. | P | [V3 datasheet][ht-ds-v3], [V3.2 schematic][ht-sch-v32] |
| USB: a CP2102 USB-to-serial chip on a Type-C socket. Not native USB. | P | [V3 datasheet][ht-ds-v3] |
| GPIO19 and GPIO20 are on the header. "DP pin connectable to USB socket, solder R29"; "DN pin connectable to USB socket, solder R3". Both resistors are marked NC on the V3.2 schematic. | P | [V3 datasheet][ht-ds-v3], [V3.2 schematic][ht-sch-v32] |
| Radio clock: "High precision temperature compensated crystal oscillator". | P | [V3 datasheet][ht-ds-v3] |
| TCXO voltage: 1.8 V. | S | [Meshtastic variant][ht-mesh] (`SX126X_DIO3_TCXO_VOLTAGE 1.8`) |
| Heltec's library sets a TCXO wake-up time of 5 ms. | P | [board-config.h][ht-lib] |
| Battery divider: 390 kΩ over 100 kΩ, 1%. V_adc = 100 / (100 + 390) × V_bat, so 4.2 V reads 0.857 V. | P | [V3 datasheet][ht-ds-v3], [V3.2 schematic][ht-sch-v32] |
| The V3.2 datasheet prints the divider formula the wrong way round ("VBAT = 100 / (100+390) * VADC_IN1"). | P | [V3.2 datasheet][ht-ds-v32] |
| `ADC_Ctrl` polarity: V3 and V3.1 are active low (pull-up on the line). V3.2 added a transistor and is active high. | S | [RNode firmware commit][ht-rnode]; [Meshtastic][ht-mesh] has `ADC_CTRL_ENABLED LOW` for V3 |
| The V3.2 schematic text places `ADC_Ctrl` next to a transistor (Q3) and a P-channel MOSFET (Q1, AO3401). That fits "active high", but the wiring was inferred from part and net names, not traced. | P-calc | [V3.2 schematic][ht-sch-v32] |
| Regulator CE6260B33M, charger LGS4056HDA. | P | [V3.2 schematic][ht-sch-v32] |
| Maximum transmit power 21 ± 1 dBm at 867–870 MHz. | P | [V3 datasheet][ht-ds-v3] |
| Heltec's library also names a "WiFi LoRa 32 V4" with an external power amplifier on GPIO2, 5 or 46, and 7. Check which revision is delivered. | P | [board-config.h][ht-lib] |
| The V3 datasheet has no differences listed for V3.1. The V3.2 datasheet's change log only says "V3.1" and "V3.21". | P | [V3.2 datasheet][ht-ds-v32] |

### Deep-sleep current

| Fact | Label | Source |
| --- | --- | --- |
| Heltec: "< 10 µA" in the comparison table. In the power table: 15 µA on battery, 10 µA on the 3.3 V header, 2 mA on USB. | P | [V3 datasheet][ht-ds-v3] Table 3.4 |
| The bare chip: 7 µA with RTC peripherals off, 8 µA with them on. | P | [ESP32-S3 datasheet][s3-ds] Table 5-10 |
| One user measured about 800 µA with their own code, about 30 µA with Heltec's sample, and 14–16 µA after fixing the order of calls: put the radio to sleep **before** shutting down SPI. Board: Wireless Stick Lite V3, same radio wiring. | S | [RadioLib discussion 1079][ht-rl1079] |
| Why the board draws more than the chip: the radio (0.16–1.2 µA asleep), the regulator's own current, the charger and battery circuit, and the CP2102 when USB is connected (2 mA figure). The split between these parts was not found in any source. | P-calc / U | — |
| Things that keep current high if left on: `Vext` (GPIO36 low powers the OLED rail), `ADC_Ctrl` enabling the divider (8.6 µA at 4.2 V through 490 kΩ), the LED, a radio left in standby (0.6 mA). | P-calc | divider value from [V3 datasheet][ht-ds-v3]; standby from [SX1262 datasheet][sx-ds] |

### Pins for a reed switch, buzzer and relay

| Use | Good choices on the Heltec headers | Why | Label |
| --- | --- | --- | --- |
| Reed switch, tamper, extra button (must wake from deep sleep) | GPIO2, 4, 5, 6, 7 | RTC pins (0–21 are RTC-capable), free on J3. | P ([S3 datasheet][s3-ds], [V3 datasheet][ht-ds-v3]) |
| Avoid for wake inputs | GPIO3 (strapping: JTAG source), GPIO0 (strapping; it is the PRG button), GPIO1 (battery sense) | | P |
| Buzzer | GPIO47, 48, 33 or 34 | Free, not strapping, no power-up glitch listed. Not RTC pins. | P / P-calc |
| Relay or 12 V driver (siren controller, always powered) | GPIO47, 48, 33 or 34 | Same. Add an external pull-down so the output is off while the chip is in reset. | P-calc |
| Avoid for a relay | GPIO45, 46 (strapping), GPIO19, 20 (two high-level glitches of 60 µs at power-up), GPIO18 (high-level glitch), GPIO26 | | P ([S3 datasheet][s3-ds] Table 2-2) for 18–20, 45, 46; U for 26 |
| GPIO1–14, 17 show a 60 µs low-level glitch at power-up. Harmless for an active-high load. | | | P ([S3 datasheet][s3-ds] Table 2-2) |
| GPIO39–42 are the JTAG pins. Usable when pad JTAG is not selected. | | | P |

### Conflicts with the pin plan in `sensor-board.md`

| Plan | Heltec V3 | Effect | Label |
| --- | --- | --- | --- |
| LoRa on 10 (CS), 11 (MOSI), 12 (SCK), 13 (MISO), 14 (RST), 15 (BUSY), 16 (DIO1) | 8 (NSS), 10 (MOSI), 9 (SCK), 11 (MISO), 12 (RST), 13 (BUSY), 14 (DIO1) | Every LoRa pin differs. The pin map must be per-board data, not constants. | P |
| GPIO8, 9: spare I²C | LoRa NSS and SCK | Not available. | P |
| GPIO15, 16: LoRa BUSY and interrupt | 32 kHz crystal | On the own board this choice rules out a 32 kHz crystal for good. See section 6. | P |
| GPIO17: buzzer | OLED SDA | Use a header pin on the dev board. | P |
| GPIO18: status LED | OLED SCL | The board LED is GPIO35. | P |
| GPIO21: spare header, wake-capable | OLED reset | On the header, but shared. | P |
| GPIO19, 20: USB data | On the header only; the socket goes to the CP2102 | F13 ("no USB-UART chip") is not met. The device shows up as a CP210x, not with Espressif's vendor number. Native USB needs R3 and R29 fitted or a breakout on the header. | P |
| GPIO4: button | No button there; PRG is on GPIO0 | Wire a button to GPIO4, or use GPIO0 and accept it is a strapping pin. | P |
| GPIO6: USB power detect | No such net on a GPIO | Needs a divider from the 5V header pin. | P-calc |
| GPIO7: charger status | Charger status is not on a GPIO in the pin table | "Charging" flag cannot be reported without rework. | P-calc |
| GPIO1: battery sense | Same pin, but the divider must be enabled with GPIO37, and the polarity depends on the revision | Extra pin and a revision check. | P / S |
| GPIO35–37: free | LED, `Vext` control, `ADC_Ctrl` | Not free. | P |
| E-paper on the LoRa SPI bus, pins 38–41 | 38–41 are free, but the LoRa SPI lines are not on the headers | On the dev board the e-paper needs its own SPI host on other pins. | P |
| 8 MB flash, no PSRAM | Same (ESP32-S3FN8) | Matches. | P |
| "GPIO0–21 can wake"; "GPIO0, 3, 45, 46 are strapping"; "analogue inputs on GPIO1–10"; "console on 43/44"; "35–37 only free without octal PSRAM" | — | All confirmed. | P ([S3 datasheet][s3-ds], [WROOM-1 datasheet][wroom-ds], [adc_channel.h][idf-adc]) |

---

## 6. ESP32-S3 deep sleep

Sources: ESP-IDF v6.1 [sleep modes guide][idf-sleep], [esp_sleep.h][idf-sleep-h], [soc_caps.h][soc-caps-61], [ESP32-S3 datasheet v2.2][s3-ds].

### Wake sources

| Source | Call | Pins | Notes | Label |
| --- | --- | --- | --- | --- |
| Timer | `esp_sleep_enable_timer_wakeup(us)` | — | Resolution depends on the slow clock. No RTC peripherals needed. | P |
| ext0 | `esp_sleep_enable_ext0_wakeup(gpio, level)` | one RTC pin, GPIO0–21 | Keeps RTC peripherals powered. Internal pulls work. | P |
| ext1 | `esp_sleep_enable_ext1_wakeup_io(mask, mode)` | several RTC pins, GPIO0–21 | Modes: `ESP_EXT1_WAKEUP_ANY_LOW` or `ESP_EXT1_WAKEUP_ANY_HIGH`. Works with RTC peripherals off. | P |
| ext1, level per pin | — | — | **Not on the S3.** "it is not allowed to configure different wakeup levels for the IOs". `SOC_PM_SUPPORT_EXT1_WAKEUP_MODE_PER_PIN` is absent. | P |
| GPIO wake in deep sleep | `esp_sleep_enable_gpio_wakeup_on_hp_periph_powerdown(mask, mode)` | GPIO0–21 | Level low or high, stored per pin, so pins can differ. On the S3 the capability flag exists in **v6.1** and is absent in v6.0.3 and v5.5.6. It keeps RTC peripherals powered. No edge modes on the S3. Not tried on hardware. | P ([sleep_modes.c][idf-sleep-c], [soc_caps v6.0.3][soc-caps-603], [soc_caps v5.5.6][soc-caps-55]) |
| Touch, ULP | `esp_sleep_enable_touchpad_wakeup`, `esp_sleep_enable_ulp_wakeup` | — | Available; not planned. | P |
| Which pin woke | `esp_sleep_get_ext1_wakeup_status()`, `esp_sleep_get_wakeup_cause()` | | | P |

- A wake signal must last at least 3 slow-clock cycles: about 22 µs on the RC clock, 92 µs on a 32 kHz crystal. **P.**
- After an ext0 or ext1 wake the pad is still an RTC pad. Call `rtc_gpio_deinit` before normal GPIO use. **P.**
- F1 needs "wake on either edge" of the reed switch. All these sources are level-triggered on the S3. The firmware must read the door, then arm the opposite level before each sleep. With button and tamper active-low and the door either way, plain ext1 cannot cover all three; ext0 for the door plus ext1 for the rest can, and so can the v6.1 call. **P-calc.**
- Wi-Fi and Bluetooth must be stopped before sleep. **P.**
- Deep sleep always powers the flash down. **P.**

### What survives

| Fact | Label | Source |
| --- | --- | --- |
| RTC FAST memory: 8 KB. RTC SLOW memory: 8 KB. Both keep data in deep sleep. | P | [S3 datasheet][s3-ds] section 4.1 |
| A little RTC FAST memory is reserved: 24 bytes for the timer, plus the bootloader's block if enabled. A ULP program would take space in RTC SLOW. | P | [memory.ld.in][idf-ld] |
| `RTC_DATA_ATTR`: writable data placed in RTC memory, kept across deep sleep. It goes to RTC SLOW by default; `CONFIG_ESP32S3_RTCDATA_IN_FAST_MEM` moves it to FAST. What happens to it on other kinds of reset was not read. | P / U | [wake stub guide][idf-stub], [memory.ld.in][idf-ld] |
| `RTC_NOINIT_ATTR`: values "keep their value after waking from deep sleep". | P | [memory types][idf-memtypes] |
| `RTC_RODATA_ATTR`, `RTC_FAST_ATTR`, `RTC_SLOW_ATTR`, and `RTC_IRAM_ATTR` for wake-stub code. | P | [wake stub guide][idf-stub] |
| RTC memory stays powered by default when such variables exist. | P | [sleep modes guide][idf-sleep] |
| Main RAM, CPU state and normal peripherals are lost. The chip restarts through the bootloader. | P | [sleep modes guide][idf-sleep] |
| Whether RTC memory survives a brown-out or a watchdog reset was not read. | U | — |

Chip current in deep sleep: 7 µA with RTC peripherals off, 8 µA with them on. **P**, [S3 datasheet][s3-ds] Table 5-10. ext0 and the v6.1 GPIO wake keep them on; ext1 does not need them.

### Sleep clock

| Source (`CONFIG_RTC_CLK_SRC`) | Pins | What the documentation says | Label |
| --- | --- | --- | --- |
| Internal RC, about 136 kHz (default) | none | "lowest Deep-sleep current"; stability "is affected by temperature fluctuations"; drift "in the range of several seconds per day is acceptable" is its use case. | P ([system time][idf-systime], [Kconfig.rtc][idf-rtc-kconfig]) |
| External 32 kHz crystal | GPIO15 (`XTAL_32K_P`) and GPIO16 (`XTAL_32K_N`) | "better frequency stability at the expense of a slightly higher (by 1 μA) Deep-sleep current". | P ([system time][idf-systime], [S3 datasheet][s3-ds] pin table) |
| External 32 kHz oscillator | `XTAL_32K_P` pin (GPIO15) | Signal fed from outside. | P |
| Internal 17.5 MHz RC divided by 256 | none | Better stability than the 136 kHz RC, 5 µA more in deep sleep. | P |

- No accuracy in percent or ppm is given for either RC source, in the IDF documentation or the datasheet. protocol.md's "a few percent fast or slow" is unconfirmed. **U.**
- At start-up ESP-IDF measures the slow clock against the main crystal over `CONFIG_RTC_CLK_CAL_CYCLES` cycles (default 1,024 for the RC). Setting it to 0 skips this and assumes a nominal frequency. **P**, [Kconfig.rtc][idf-rtc-kconfig].
- Bluetooth LE needs a sleep clock within 500 ppm, and the documentation warns the RC source may not meet it. **P**, [system time][idf-systime]. This matters only if BLE light sleep is used.
- The pin plan uses GPIO15 and 16 for the radio, so the crystal option is closed on the own board. The Heltec V3.2 has the crystal. Results from spike S8 on the Heltec with the crystal enabled will not carry over. **P-calc.**

### Boot time from deep sleep

| Fact | Label | Source |
| --- | --- | --- |
| Espressif publishes no figure for wake-to-`app_main` time. | P | [speed guide][idf-speed], [startup_time example][idf-startup-ex] |
| Options that shorten it: `CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP` (skips image verification on wake; default off), lower `CONFIG_LOG_DEFAULT_LEVEL` and `CONFIG_BOOTLOADER_LOG_LEVEL`, `CONFIG_RTC_CLK_CAL_CYCLES=0` (costs timer accuracy), QIO flash mode. | P | [speed guide][idf-speed], [bootloader guide][idf-bootloader], [example defaults][idf-startup-ex] |
| With fast boot the bootloader stores the app address in RTC FAST memory on first boot and reuses it on wake "without any checks". | P | [bootloader guide][idf-bootloader] |
| A wake stub (`esp_wake_deep_sleep`, in RTC FAST memory, CRC-checked) runs before the bootloader. | P | [wake stub guide][idf-stub] |
| sensor-board.md assumes "awake for about 0.2 s at 40 mA" per report. Unverified. Measure it. | U | — |

### Light sleep with a GPIO interrupt from the radio

| Fact | Label | Source |
| --- | --- | --- |
| In light sleep any GPIO can wake the chip: `gpio_wakeup_enable(pin, GPIO_INTR_HIGH_LEVEL)` then `esp_sleep_enable_gpio_wakeup()`. Level-triggered. | P | [sleep modes guide][idf-sleep] |
| DIO1 is active high and stays high until the IRQ is cleared over SPI, so a high-level wake fits. | P-calc | [SX1262 datasheet][sx-ds] 8.5 |
| RAM and CPU state are kept. Execution continues after `esp_light_sleep_start()`. | P | [sleep modes guide][idf-sleep] |
| Chip current in light sleep: 240 µA typical. | P | [S3 datasheet][s3-ds] Table 5-10 |
| Flash is not powered down in light sleep by default. The guide recommends `CONFIG_ESP_SLEEP_SET_FLASH_DPD` or the leakage workaround instead. | P | [sleep modes guide][idf-sleep] |
| Any output pin that must hold a level in light sleep must not sit on a powered-down domain. | P | [sleep modes guide][idf-sleep] |
| Light-sleep wake latency was not read. | U | — |
| For a listening window of 1–3 s, light sleep on DIO1 costs about 0.24 mA for the chip plus 4.6–5.3 mA for the radio. | P-calc | above |

---

## 7. Storage, updates and USB serial

### NVS endurance for a counter

| Fact | Label | Source |
| --- | --- | --- |
| NVS is a log. An update appends a new entry and marks the old one erased. | P | [NVS guide][idf-nvs] |
| A page is one 4,096-byte flash sector. An entry is 32 bytes. An integer takes one entry. | P | [NVS guide][idf-nvs] |
| "NVS component includes flash wear levelling by design"; for one-entry values it reduces erases relative to writes "by a factor of 126". | P | [NVS guide][idf-nvs] |
| Power loss: "one should be able to power off the device at any point"; only the pair being written may be lost. | P | [NVS guide][idf-nvs] |
| On weak supplies an erase can fail silently. `CONFIG_NVS_FLASH_VERIFY_ERASE` reads back and retries. Relevant to a battery sensor. | P | [NVS guide][idf-nvs] |
| Without NVS encryption anyone with the flash chip can read the device key. | P | [NVS guide][idf-nvs] |
| A sensor saves a resume point every 64 packets. At a 3-minute heartbeat plus 20 events a day that is about 8 writes a day, about 2,850 a year, about 23 page erases a year, spread over the partition's pages. | P-calc | protocol.md section 4 |
| Flash erase endurance for the chip's own flash was not read. NOR flash is usually rated around 100,000 cycles. At a few erases per page per year, wear is not a concern. | U / P-calc | — |
| A siren saves its command counter "with each command". Commands repeat every 2–5 s for up to a minute but carry the same counter, so it is one write per new command. Check that repeats do not write. | P-calc | protocol.md section 7 |

### Two-slot updates with rollback

| Fact | Label | Source |
| --- | --- | --- |
| Needs a partition table with `otadata` and at least `ota_0` and `ota_1`. | P | [OTA guide][idf-ota] |
| Write calls: `esp_ota_get_next_update_partition`, `esp_ota_begin`, `esp_ota_write`, `esp_ota_end`, `esp_ota_set_boot_partition`. | P | [esp_ota_ops.h][idf-ota-h] |
| Rollback needs `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`. It is off by default. | P | [OTA guide][idf-ota] |
| With it on: `esp_ota_set_boot_partition` marks the image `ESP_OTA_IMG_NEW`. On the next boot the bootloader changes it to `ESP_OTA_IMG_PENDING_VERIFY`. | P | [OTA guide][idf-ota] |
| The app checks with `esp_ota_get_state_partition`. If the state is pending, it runs its self-test and calls `esp_ota_mark_app_valid_cancel_rollback()` or `esp_ota_mark_app_invalid_rollback_and_reboot()`. | P | [OTA guide][idf-ota] |
| "If … a reset occurs without calling either function then the application is rolled back." The image becomes `ESP_OTA_IMG_ABORTED`. | P | [OTA guide][idf-ota] |
| "Perform the self-test procedure as quickly as possible, to prevent rollback due to power loss." | P | [OTA guide][idf-ota] |
| A wake from deep sleep goes through the bootloader. A new image that deep-sleeps before it is marked valid would be rolled back on the next wake. Whether fast boot (`SKIP_VALIDATE_IN_DEEP_SLEEP`) changes this was not tested. | P-calc / U | — |
| Version roll-back protection is a separate option, `CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK`. It burns eFuses. | P | [OTA guide][idf-ota] |
| Built-in signature checking without Secure Boot (`CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT`) uses RSA on the S3. See section 2. | P | [bootloader Kconfig][idf-boot-kconfig] |

### USB serial on the ESP32-S3

| Fact | Label | Source |
| --- | --- | --- |
| The S3 has two USB functions on one internal transceiver at GPIO19 (D−) and GPIO20 (D+): the USB Serial/JTAG controller and USB OTG. By default the pins belong to USB Serial/JTAG. | P | [S3 datasheet][s3-ds], [usb_pins.h][idf-usbpins] |
| **USB Serial/JTAG**: fixed function, "implemented entirely in hardware". A serial port plus JTAG. Console option `CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG`. Driver in `esp_driver_usb_serial_jtag`. | P | [USB Serial/JTAG guide][idf-usj] |
| Its USB identity cannot be changed by the application. The numbers usually quoted are vendor 0x303A, product 0x1001; the Arduino board file uses that pair, but no Espressif document stating it was read. | P / U | [USB Serial/JTAG guide][idf-usj], [pins_arduino.h][ht-arduino] |
| Limits: it disappears from the host in deep sleep and reconnects on wake. In light sleep it stops answering and may not re-enumerate. If no host reads, a full buffer causes a one-time 50 ms wait. | P | [USB Serial/JTAG guide][idf-usj] |
| **TinyUSB CDC** on USB OTG: a software stack. Component `espressif/esp_tinyusb`, version 3.0.0 (20 October 2026), needs IDF ≥ 5.3. | P | [component registry][idf-tinyusb] |
| With TinyUSB the application supplies the USB descriptors, so it can choose the vendor and product numbers. Not read in this session. | U | — |
| The ROM "USB CDC console" (`CONFIG_ESP_CONSOLE_USB_CDC`) is a third option. It "is incompatible with TinyUSB stack". | P | [USB OTG console guide][idf-usbcdc] |
| TinyUSB's memory use and exact default product number were not read. | U | — |
| **Heltec V3**: neither option works through its USB socket as shipped. The socket goes to the CP2102, which talks to UART0 on GPIO43 and 44. | P | [V3 datasheet][ht-ds-v3] |
| On the Heltec, the gateway's USB link is therefore plain UART0 through the CP2102. It shares the port with boot messages and logs unless they are moved or silenced. The COBS framing in protocol.md still works. | P-calc | — |
| The CP2102's USB vendor number is Silicon Labs', not Espressif's. The number itself was not read. | U | — |

---

## 8. WebSocket client and mDNS

Both live in the [esp-protocols][espp] repository and are installed with the component manager. Neither is inside ESP-IDF v6.1 (`components/esp_websocket_client` and `components/mdns` do not exist there). **P.**

| | WebSocket client | mDNS |
| --- | --- | --- |
| Component | `espressif/esp_websocket_client` | `espressif/mdns` |
| Version | 1.8.0 (22 July 2026) | 1.15.1 (5 November 2026) |
| Needs | IDF ≥ 5.0 | IDF ≥ 5.0 |
| Licence | Apache-2.0 (LICENSE file and SPDX headers; the registry shows "Custom") | Apache-2.0 (same) |
| Label | P | P |
| Source | [registry][ws-reg], [source][ws-src] | [registry][mdns-reg], [source][mdns-src] |

### WebSocket client

| Fact | Label | Source |
| --- | --- | --- |
| It runs its own task. Defaults: stack 4,096 bytes, priority 5, no core affinity. | P | [esp_websocket_client.c][ws-c] |
| Heap: the client object, a receive buffer and a transmit buffer, each `buffer_size` bytes (default 1,024), are allocated with `calloc`. So are the task, locks, event group and copied strings. About 30 allocation sites in the file. | P | [esp_websocket_client.c][ws-c] |
| `CONFIG_ESP_WS_CLIENT_ENABLE_DYNAMIC_BUFFER` (default off) allocates the buffers only while in use. | P | [Kconfig][ws-kconfig] |
| A message larger than the buffer is delivered as several data events. Use `payload_len` and `payload_offset` to reassemble. protocol.md allows 1,024-byte packets, exactly the default buffer; set `buffer_size` above that or reassemble. | P / P-calc | [esp_websocket_client.h][ws-h] |
| Reconnect: automatic by default. After an unexpected drop it waits `reconnect_timeout_ms` (default 10,000) and reconnects. `disable_auto_reconnect` turns it off. | P | [esp_websocket_client.c][ws-c] |
| The wait is fixed, not a back-off. `esp_websocket_client_set_reconnect_timeout(client, ms)` changes it at run time. protocol.md wants 1, 2, 4, 8, 15, then 30 s; the firmware must step the value itself. | P / P-calc | [esp_websocket_client.h][ws-h] |
| After a clean close from the server it does not reconnect unless `enable_close_reconnect` is set. | P | [esp_websocket_client.h][ws-h] |
| Other defaults: network timeout 10 s, ping every 10 s, drop after 120 s without a pong, TCP keep-alive off unless enabled. | P | [esp_websocket_client.c][ws-c] |
| The hub declares a gateway offline after 60 s of silence. With the 120 s pong timeout a dead link may go unnoticed on the device side for longer. Shorten `pingpong_timeout_sec` or rely on the 30 s status packets. | P-calc | protocol.md section 7 |
| Binary send: `esp_websocket_client_send_bin(client, data, len, timeout)`. | P | [esp_websocket_client.h][ws-h] |
| Total heap in bytes while connected was not measured. | U | — |

### mDNS

| Fact | Label | Source |
| --- | --- | --- |
| It runs its own task. Defaults: stack 4,096 bytes, priority 1, pinned to core 0. | P | [Kconfig][mdns-kconfig] |
| Heap: allocated dynamically, from internal RAM by default. `CONFIG_MDNS_MEMORY_CUSTOM_IMPL` lets the application supply the allocator. | P | [Kconfig][mdns-kconfig] |
| Finding the hub: `mdns_query_ptr("_hsn-hub", "_tcp", timeout, max_results, &results)`, then read the TXT items for the identity, then `mdns_query_results_free`. `mdns_query_txt` and `mdns_query_srv` fetch one instance. Asynchronous queries exist (`mdns_query_async_*`). | P | [mdns.h][mdns-h] |
| There is no "reconnect"; a query runs once with a timeout. The firmware repeats it when the hub is not found or the address changes. | P-calc | [mdns.h][mdns-h] |
| Sensors and sirens only look up; `mdns_init` is still required. Advertising options (`CONFIG_MDNS_MAX_SERVICES` default 10) can be cut. Default build also enables a console command set (`CONFIG_MDNS_ENABLE_CONSOLE_CLI`, default on). | P | [Kconfig][mdns-kconfig] |
| Heap in bytes was not measured. | U | — |

---

## (a) Things a reviewer should check in the firmware

**Platform and crypto**

1. Which ESP-IDF tag is pinned, and that the crypto wrapper matches it: PSA calls on v6.x, or `mbedtls_ccm_*` only on v5.5.x. No include of `mbedtls/private/…`.
2. The AES key context or PSA key is created once at start-up or pairing, never per packet.
3. A heap trace around one encrypt and one decrypt on the target shows zero allocations, or the allocations are deliberate and bounded. On v5.5.6 with hardware AES there will be several per packet.
4. Nonce is 13 bytes, tag 8 bytes, and the tag check result is the only thing that releases plaintext. Nothing reads the output buffer after a failed check.
5. The 64-byte hub public key gets a `0x04` prefix before import. The signature format handed to the verifier matches what the hub produces (raw `r‖s` or DER).
6. ECDSA verification runs where heap use is acceptable (update path only), and its time is measured on the S3.
7. The host test build and the target build use the same Mbed TLS major version. The protocol test vectors pass on both.
8. The core compiles as C++17 on the host although the target toolchain defaults to gnu++26.

**Radio**

9. RadioLib version is pinned. Code is written for the 8.0.0 interface (config struct, Hz, `tcxoVoltage` member) or stays on 7.8.1 on purpose.
10. `RADIOLIB_STATIC_ONLY=1` is set, or the heap use per SPI transfer is accepted. Radio objects are not created with `new`. `RADIOLIB_LOW_LEVEL=1` is set if raw commands (`setCad`, `setRx`, `setLoRaSymbNumTimeout`, register access) are called.
11. `CONFIG_FREERTOS_HZ=1000` if RadioLib's `EspHal` is used.
12. No blocking RadioLib call (`scanChannel`, `receive`, `transmit`) on the sensor's power-critical path; `scanChannel` has no timeout at all. The interrupt-driven calls are used with the firmware's own deadline.
13. The DIO1 handler does no SPI and is safe in interrupt context.
14. TCXO voltage is set before `begin`: 1.8 V on the Heltec. The value for the own board's module comes from its datasheet. A wrong setting falls back to crystal mode silently in RadioLib; check the result explicitly.
15. DIO2 is enabled as RF switch on the Heltec. On a module with RXEN and TXEN pins, both are driven.
16. Image calibration is done for 863–870 MHz after TCXO set-up, and a full calibration follows `SetDIO3AsTCXOCtrl`.
17. CAD parameters are explicit per spreading factor, not library defaults: 2 symbols/peak 22 at SF7–8; 4 symbols/peak 23, 24, 25, 28 at SF9–12; min 10. The time budget uses the measured durations in section 3.
18. After a receive timeout that is followed by a CAD, the radio is put to sleep first (AN1200.48 workaround).
19. The receive window uses a stated stop condition: stop-on-header (window must cover preamble + header) or stop-on-preamble (needs a guard against false detection), or a symbol timeout. The window in protocol.md section 8 is checked against it.
20. Sync word registers read back as 0x14, 0x24. LDRO is on exactly for SF11 and SF12 at both ends. Header explicit, CRC on, IQ standard.
21. Sensor transmit power: the PA configuration and the resulting current are known. 90 mA at +14 dBm unless the module's matching supports the low-power settings. The battery estimate uses the real figure.
22. `paDutyCycle` ≤ 0x04 and `hpMax` ≤ 0x07 always. Over-current limit is set after `SetPaConfig`, not before.
23. The TX clamp fix (0x08D8) is re-applied after every cold start of the radio. Rx gain is re-applied after warm sleep, or added to the retention list.
24. Sleep choice is deliberate: cold (160 nA, 3.5 ms wake, full re-configuration) or warm (600 nA, 0.34 ms). No SPI for 500 µs after `SetSleep`. The radio is put to sleep **before** SPI pins are released.
25. Gateway noise readings (`GetRssiInst`) are taken in receive mode, and carry a board-specific offset.
26. Airtime accounting uses the same formula as the Semtech driver, including the 4.25 extra symbols.

**Sleep and wake**

27. Wake configuration on the S3: one level per ext1 group, or ext0 + ext1, or the v6.1 GPIO wake. The door level is re-armed from the current door state before every sleep, and the door is read again after arming to close the race.
28. Wake pins are released with `rtc_gpio_deinit` before use as normal GPIO.
29. Whether RTC peripherals stay powered in sleep is known, and the 1 µA difference is in the budget.
30. State kept across sleep is in `RTC_DATA_ATTR` or `RTC_NOINIT_ATTR` variables, fits in 8 KB, and carries its own validity check. Counters there are also saved to NVS on the 64-packet step.
31. The slow-clock source is chosen on purpose. Timing margins hold with the internal RC, because the own board cannot have the 32 kHz crystal with the current pin plan. S8 is measured with the Heltec's crystal **disabled** in configuration.
32. `CONFIG_RTC_CLK_CAL_CYCLES` is not set to 0 while heartbeat slots depend on the sleep timer.
33. Wake-to-transmit time is measured, with and without `CONFIG_BOOTLOADER_SKIP_VALIDATE_IN_DEEP_SLEEP`.
34. Wi-Fi and Bluetooth are stopped before deep sleep. `Vext` off, battery divider off, LED off, radio asleep.

**Board differences**

35. All pins come from a per-board table. Nothing assumes the plan's GPIO numbers on the Heltec.
36. Battery reading on the Heltec switches GPIO37 with the right polarity for the board revision, waits for the divider to settle, and switches it off again. Scale factor 4.9.
37. Nothing drives GPIO17, 18 or 21 as buzzer, LED or spare on the Heltec.
38. Outputs that drive a relay or sounder have a defined level during reset and are not on GPIO18–20, 45 or 46.
39. The delivered boards' revision (V3, V3.1, V3.2, or V4) is recorded.

**Storage, updates, USB, network**

40. NVS writes happen only on the resume-point step and on real changes. A repeated siren command does not write. `nvs_commit` is called and its result checked. Erase verification is considered for battery devices.
41. `CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE` is on, the partition table has `otadata`, `ota_0`, `ota_1`, and both slots fit in 8 MB with NVS.
42. A new image marks itself valid only after a real self-test (radio answers, hub reply received), and **before** its first deep sleep. A test proves that a reset in between rolls back.
43. The update's signature is checked before `esp_ota_set_boot_partition`.
44. The gateway's USB transport is an interface with two back-ends: UART0 through the CP2102 on the Heltec, native USB on the own board. Logs do not corrupt the framed link. The hub does not rely on Espressif's vendor number for dev boards.
45. With USB Serial/JTAG, sleeping while a host is attached is handled; the port vanishes in deep sleep.
46. WebSocket: buffer size above the largest packet or reassembly by `payload_offset`; reconnect delay stepped 1, 2, 4, 8, 15, 30 s by the firmware; clean server close handled; dead-link detection within the hub's 60 s rule.
47. mDNS: the result's identity TXT record is compared with the paired hub identity before connecting; results are freed; the lookup is retried on failure.
48. Heap high-water marks for the WebSocket and mDNS tasks are measured on the gateway and siren roles.

## (b) What could not be verified

| Item | Why | What to do |
| --- | --- | --- |
| Exact end-of-life dates for ESP-IDF lines | Published as an image; dates here are computed from the policy. | Read the chart if a date matters. |
| How a PSA CCM call reaches the AES peripheral in v6.1, and whether it is heap-free end to end | The dispatch was not traced past the driver files read. | Heap-trace one packet on the target. |
| Raw ECDSA signature layout expected by `psa_verify_hash` | Not read in the header. | Read `crypto_values.h` near `PSA_ALG_ECDSA`, or test with a vector. |
| ECDSA P-256 verification time on the S3; whether the MPI accelerator helps | No source; needs measurement. | Measure. |
| Building upstream Mbed TLS on macOS outside ESP-IDF | Not tried. | Try in the host-test spike. |
| Accuracy of the S3's internal slow clocks in percent or ppm | Not stated by Espressif. | Spike S8. |
| Wake-to-application time from deep sleep; light-sleep wake latency | Not stated by Espressif. | Measure with a logic analyser. |
| RTC memory after brown-out or watchdog reset | Not read. | Test; keep a validity check. |
| Interaction of rollback with deep-sleep fast boot | Reasoned from the documentation, not tested. | Test on hardware. |
| Flash endurance of the ESP32-S3FN8's internal flash and of the module chosen for the own board | Flash part datasheets not read. | Read when the module is chosen. |
| Split of the Heltec's 10–15 µA sleep current between parts; a clean independent measurement | Only Heltec's own figure and one forum report. | Measure with the power profiler. |
| Heltec V3 (not V3.2) schematic details: 32 kHz crystal fitted, R3/R29 state, `ADC_Ctrl` circuit | The V3 schematic PDF is an image. V3.2 was read. Polarity difference is from secondary sources. | Inspect the delivered boards. |
| Heltec TCXO voltage of 1.8 V | From community firmware, not from Heltec's documents. | Confirm by a start-up test with error checking. |
| CP2102 USB vendor and product numbers | Not read. | Read from a connected board. |
| Charger status and USB-power detection on the Heltec | Not on any GPIO in the pin table; schematic not fully readable as text. | Inspect; plan without them on dev boards. |
| Ebyte E22-900M22S: TCXO voltage, RXEN/TXEN wiring, sleep current, PA matching | Ebyte's page refused the request (rate limit). Search snippets disagree on sleep current (2 µA and 185 µA in different manual copies) and suggest a 1.8 V TCXO and separate RXEN/TXEN pins. All secondary. | Read the current Ebyte manual before the schematic. The 1 µA in the sleep budget is unconfirmed. |
| LoRa instantaneous RSSI settling time | Datasheet tables it for GFSK only. | Measure on the gateway. |
| RadioLib: a named call for `StopTimerOnPreamble`; the AN1200.48 workaround | Not found in the files read. | Search the 8.0.0 source, or send the raw command. |
| PSA Crypto on ESP-IDF v5.5.6 | The configuration header does not mention `MBEDTLS_PSA_CRYPTO_C`; not investigated further. | Decide the IDF line first, then write the wrapper for it. |
| RadioLib 8.0.0 in practice | Released five days before this research. Read as source only; nothing was built or run. | Build the ESP-IDF example on a Heltec before committing to 8.x. |
| TinyUSB memory use and default product number | Not read. | Read when the own board's USB is implemented. |
| Heap used by the WebSocket and mDNS components in bytes | Not published. | Measure. |
| ESP-IDF documentation pages were read at v6.1. Behaviour on v5.5.6 was checked only where a row says so. | Scope. | Re-check against the pinned version. |

## Sources

Primary sources were read at these addresses on 12 November 2026.

[idf-rel]: https://github.com/espressif/esp-idf/releases
[idf-v61]: https://github.com/espressif/esp-idf/releases/tag/v6.1
[idf-v60]: https://github.com/espressif/esp-idf/releases/tag/v6.0
[idf-stable]: https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/versions.html
[idf-support]: https://github.com/espressif/esp-idf/blob/master/SUPPORT_POLICY.md
[idf-json]: https://dl.espressif.com/dl/esp-idf/idf_versions.json
[idf-mig-sec]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/migration-guides/release-6.x/6.0/security.html
[idf-mbedtls-doc]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/protocols/mbedtls.html
[idf-host]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/host-apps.html
[idf-sleep]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/sleep_modes.html
[idf-systime]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/system_time.html
[idf-stub]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/deep-sleep-stub.html
[idf-memtypes]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/memory-types.html
[idf-speed]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/performance/speed.html
[idf-bootloader]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/bootloader.html
[idf-ota]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/ota.html
[idf-nvs]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/storage/nvs_flash.html
[idf-usj]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/usb-serial-jtag-console.html
[idf-usbcdc]: https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-guides/usb-otg-console.html
[idf-startup-ex]: https://github.com/espressif/esp-idf/tree/v6.1/examples/system/startup_time
[idf-sleep-h]: https://github.com/espressif/esp-idf/blob/v6.1/components/esp_hw_support/include/esp_sleep.h
[idf-sleep-c]: https://github.com/espressif/esp-idf/blob/v6.1/components/esp_hw_support/sleep_modes.c
[idf-ota-h]: https://github.com/espressif/esp-idf/blob/v6.1/components/app_update/include/esp_ota_ops.h
[idf-boot-kconfig]: https://github.com/espressif/esp-idf/blob/v6.1/components/bootloader/Kconfig.projbuild
[idf-rtc-kconfig]: https://github.com/espressif/esp-idf/blob/v6.1/components/esp_hw_support/port/esp32s3/Kconfig.rtc
[idf-ld]: https://github.com/espressif/esp-idf/blob/v6.1/components/esp_system/ld/esp32s3/memory.ld.in
[idf-adc]: https://github.com/espressif/esp-idf/blob/v6.1/components/soc/esp32s3/include/soc/adc_channel.h
[idf-usbpins]: https://github.com/espressif/esp-idf/blob/v6.1/components/soc/esp32s3/include/soc/usb_pins.h
[soc-caps-61]: https://github.com/espressif/esp-idf/blob/v6.1/components/soc/esp32s3/include/soc/soc_caps.h
[soc-caps-603]: https://github.com/espressif/esp-idf/blob/v6.0.3/components/soc/esp32s3/include/soc/soc_caps.h
[soc-caps-55]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/soc/esp32s3/include/soc/soc_caps.h
[idf-mbed-kconfig-61]: https://github.com/espressif/esp-idf/blob/v6.1/components/mbedtls/Kconfig
[idf-mbed-kconfig-55]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/mbedtls/Kconfig
[idf-mbed-cmake]: https://github.com/espressif/esp-idf/blob/v6.1/components/mbedtls/CMakeLists.txt
[idf-espconfig-61]: https://github.com/espressif/esp-idf/blob/v6.1/components/mbedtls/port/include/mbedtls/esp_config.h
[idf-espconfig-55]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/mbedtls/port/include/mbedtls/esp_config.h
[idf-espmem]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/mbedtls/port/esp_mem.c
[idf-aes-61]: https://github.com/espressif/esp-idf/blob/v6.1/components/mbedtls/port/aes/esp_aes.c
[idf-aes-55]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/mbedtls/port/aes/dma/esp_aes.c
[idf-aes-dma-55]: https://github.com/espressif/esp-idf/blob/v5.5.6/components/mbedtls/port/aes/dma/esp_aes_dma_core.c
[idf-psa-aes]: https://github.com/espressif/esp-idf/blob/v6.1/components/mbedtls/port/psa_driver/esp_aes/psa_crypto_driver_esp_aes.c
[idf-tinyusb]: https://components.espressif.com/components/espressif/esp_tinyusb
[mbed-fork]: https://github.com/espressif/mbedtls
[mbed41-ver]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/include/mbedtls/build_info.h
[mbed411-ver]: https://github.com/espressif/mbedtls/blob/ce3f3485a121c100f58f36d700cb35b060f6e866/include/mbedtls/build_info.h
[mbed36-ver]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/include/mbedtls/build_info.h
[mbed36-ccmh]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/include/mbedtls/ccm.h
[mbed36-ccmc]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/library/ccm.c
[mbed36-cipherc]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/library/cipher.c
[mbed36-adjust]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/include/mbedtls/config_adjust_legacy_crypto.h
[mbed36-ecdsah]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/include/mbedtls/ecdsa.h
[mbed36-bignum]: https://github.com/espressif/mbedtls/blob/2b96dd8eebe880f304c69976b3c2fa0c5100cbb6/library/bignum.c
[mbed41-tree]: https://github.com/espressif/mbedtls/tree/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto
[mbed41-cryptoh]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto/include/psa/crypto.h
[mbed41-values]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto/include/psa/crypto_values.h
[mbed41-sizes]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto/include/psa/crypto_sizes.h
[mbed41-psac]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto/core/psa_crypto.c
[mbed41-aead]: https://github.com/espressif/mbedtls/blob/a2b32072ea898afc1ed5b6caf6931e36028c91d6/tf-psa-crypto/drivers/builtin/src/psa_crypto_aead.c
[s3-ds]: https://documentation.espressif.com/esp32-s3_datasheet_en.pdf
[wroom-ds]: https://documentation.espressif.com/esp32-s3-wroom-1_wroom-1u_datasheet_en.pdf
[sx-page]: https://www.semtech.com/products/wireless-rf/lora-connect/sx1262
[sx-ds]: https://semtech.my.salesforce.com/sfc/p/E0000000JelG/a/RQ000008nKCH/hp2iKwMDKWl34g1D3LBf_zC7TGBRIo2ff5LMnS8r19s
[sx-an48]: https://semtech.my.salesforce.com/sfc/p/E0000000JelG/a/3n000000qSr3/s723KzQi7zXFhBPKqesoF11.MtwYu6B8pdEQcmInlkE
[sx-an85]: https://semtech.com/uploads/technology/LoRa/cad-ensuring-lora-packets.pdf
[sx-drv]: https://github.com/Lora-net/sx126x_driver/tree/v2.5.0
[sx-drv-c]: https://github.com/Lora-net/sx126x_driver/blob/v2.5.0/src/sx126x.c
[sx-drv-hal]: https://github.com/Lora-net/sx126x_driver/blob/v2.5.0/src/sx126x_hal.h
[sx-drv-lic]: https://github.com/Lora-net/sx126x_driver/blob/v2.5.0/LICENSE.txt
[rl-rel]: https://github.com/jgromes/RadioLib/releases
[rl-rel8]: https://github.com/jgromes/RadioLib/releases/tag/8.0.0
[rl-idfyml]: https://github.com/jgromes/RadioLib/blob/8.0.0/idf_component.yml
[rl-example]: https://github.com/jgromes/RadioLib/tree/8.0.0/examples/NonArduino/ESP-IDF
[rl-esphal-h]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/hal/ESP-IDF/EspHal.h
[rl-esphal-c]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/hal/ESP-IDF/EspHal.cpp
[rl-buildopt]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/BuildOpt.h
[rl-module]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/Module.cpp
[rl-sx126x-h]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX126x.h
[rl-sx126x-c]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX126x.cpp
[rl-sx1262-c]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX1262.cpp
[rl-config]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX126x_config.cpp
[rl-commands]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/modules/SX126x/SX126x_commands.cpp
[rl-phy-h]: https://github.com/jgromes/RadioLib/blob/8.0.0/src/protocols/PhysicalLayer/PhysicalLayer.h
[ht-ds-v3]: <https://resource.heltec.cn/download/WiFi_LoRa_32_V3/HTIT-WB32LA_V3(Rev1.1).pdf>
[ht-ds-v32]: https://resource.heltec.cn/download/WiFi_LoRa_32_V3/HTIT-WB32LA_V3.2.pdf
[ht-sch-v32]: https://resource.heltec.cn/download/WiFi_LoRa_32_V3/WiFi_LoRa_32_V3.2_Schematic_Diagram.pdf
[ht-arduino]: https://github.com/espressif/arduino-esp32/blob/master/variants/heltec_wifi_lora_32_V3/pins_arduino.h
[ht-lib]: https://github.com/HelTecAutomation/Heltec_ESP32/blob/master/src/driver/board-config.h
[ht-lib-h]: https://github.com/HelTecAutomation/Heltec_ESP32/blob/master/src/heltec.h
[ht-mesh]: https://github.com/meshtastic/firmware/blob/master/variants/esp32s3/heltec_v3/variant.h
[ht-rnode]: https://git.rns.moscow/deuxyeux/RNode_Firmware/commit/828623c70c21be0deedc7428e655c5ca37e7f814
[ht-rl1079]: https://github.com/jgromes/RadioLib/discussions/1079
[espp]: https://github.com/espressif/esp-protocols
[ws-reg]: https://components.espressif.com/components/espressif/esp_websocket_client
[ws-src]: https://github.com/espressif/esp-protocols/tree/master/components/esp_websocket_client
[ws-c]: https://github.com/espressif/esp-protocols/blob/master/components/esp_websocket_client/esp_websocket_client.c
[ws-h]: https://github.com/espressif/esp-protocols/blob/master/components/esp_websocket_client/include/esp_websocket_client.h
[ws-kconfig]: https://github.com/espressif/esp-protocols/blob/master/components/esp_websocket_client/Kconfig
[mdns-reg]: https://components.espressif.com/components/espressif/mdns
[mdns-src]: https://github.com/espressif/esp-protocols/tree/master/components/mdns
[mdns-h]: https://github.com/espressif/esp-protocols/blob/master/components/mdns/include/mdns.h
[mdns-kconfig]: https://github.com/espressif/esp-protocols/blob/master/components/mdns/Kconfig
