# The ESP32-S3 platform layer: every hal/ interface on the chip but FirmwareSlots (update/) and the
# Bluetooth link (bluetooth/), the role I/O, and the waiter (firmware-design.md sections 1 to 3).
# Platform code: the core's rules (no heap, no floating point) do not bind it, but the host's
# warnings do, with -Werror, except -Wpedantic, which ESP-IDF's own headers do not pass.
idf_component_register(
  SRCS
    src/basics.cpp
    src/clock.cpp
    src/event_queue.cpp
    src/indicators.cpp
    src/inputs.cpp
    src/link_slots.cpp
    src/network_link.cpp
    src/nvs_storage.cpp
    src/platform.cpp
    src/radio.cpp
    src/retained.cpp
    src/role_io.cpp
    src/sx1262.cpp
    src/usb_link.cpp
    src/waiter.cpp
    src/watchdog.cpp
    ../../display/display_label.cpp
    ../../display/epaper.cpp
    ../../display/pairing_bitmap.cpp
    ../../display/qr.cpp
  INCLUDE_DIRS include ../../display/include
  REQUIRES hsn_firmware update bluetooth esp_driver_gpio esp_driver_spi esp_driver_ledc
    esp_driver_tsens esp_driver_usb_serial_jtag esp_adc esp_timer esp_wifi esp_netif esp_event
    bootloader_support nvs_flash esp_app_format espressif__esp_websocket_client espressif__mdns)

target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall -Wextra -Wshadow -Wunused-parameter -Wconversion -Wsign-conversion -Werror=extra -Werror)
