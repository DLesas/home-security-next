# FirmwareSlots on ESP-IDF's partition and OTA calls (m3-updates-design.md section 2, "Behind the
# platform interface"; step 3a compiles it against v6.1's headers, step 3d proves it on a board).
idf_component_register(
  SRCS src/firmware_slots.cpp
  INCLUDE_DIRS include
  REQUIRES hsn_firmware app_update esp_partition bootloader_support esp_app_format
  PRIV_REQUIRES mbedtls nvs_flash)

target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall -Wextra -Wshadow -Wunused-parameter -Wconversion -Wsign-conversion -Werror=extra -Werror)
