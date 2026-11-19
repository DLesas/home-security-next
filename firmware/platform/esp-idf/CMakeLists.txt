# The ESP-IDF application for the ESP32-S3 boards (M1b): one image holding all three roles, the
# role chosen at start-up from flash (D103, firmware-design.md section 2). The core, the roles and
# the PSA crypto are the host build's own libraries, built from firmware/core, firmware/roles and
# firmware/platform/psa by their own CMake files (components/hsn_firmware); the platform layer is
# components/hsn_esp; app_main is main/.
#
#   . ~/esp/esp-idf/export.sh
#   idf.py -C firmware/platform/esp-idf -B firmware/platform/esp-idf/build build
#
# A board with the 32 kHz crystal fitted adds the crystal fragment (spike S8):
#   idf.py ... -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.crystal" build
cmake_minimum_required(VERSION 3.22)

# The firmware version, MAJOR.MINOR.PATCH with each part 0 to 255 (protocol section 3). It becomes
# the app description's version string, which the hub reads from the image (m3-updates-design.md
# section 3) and the platform parses into BuildInfo at start-up: one source for both.
set(PROJECT_VER "0.1.0")
if(NOT PROJECT_VER MATCHES "^([0-9]+)\\.([0-9]+)\\.([0-9]+)$"
   OR CMAKE_MATCH_1 GREATER 255 OR CMAKE_MATCH_2 GREATER 255 OR CMAKE_MATCH_3 GREATER 255)
  message(FATAL_ERROR "PROJECT_VER must be MAJOR.MINOR.PATCH, each 0 to 255: ${PROJECT_VER}")
endif()

# Components with folders of their own, named by the designs: update/ (FirmwareSlots,
# m3-updates-design.md step 3a) and bluetooth/ (F1's, m3-m4-plan.md; today only its seam). The
# e-paper display will be another. components/ holds the rest.
set(EXTRA_COMPONENT_DIRS "${CMAKE_CURRENT_LIST_DIR}/update" "${CMAKE_CURRENT_LIST_DIR}/bluetooth")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(hsn_firmware)
