# hsn_core: the portable core, protocol codec and device layer. No heap, no exceptions, no
# platform includes.
add_library(hsn_core STATIC
  src/bytes.cpp
  src/checksum.cpp
  src/counters.cpp
  src/framing.cpp
  src/messages.cpp
  src/packet.cpp
  src/radio.cpp
  src/setup.cpp
  src/transfer.cpp
  src/units.cpp
  src/device/airtime.cpp
  src/device/device.cpp
  src/device/health.cpp
  src/device/log_buffer.cpp
  src/device/radio_plan.cpp
  src/device/radio_port.cpp
  src/device/random_source.cpp
  src/device/record.cpp
  src/device/retry.cpp
  src/device/role.cpp
  src/device/runner.cpp
  src/device/secure_channel.cpp
  src/device/setup.cpp
  src/device/update.cpp
  src/device/update_session.cpp
  src/device/update_transfer.cpp)
target_include_directories(hsn_core PUBLIC include)
hsn_firmware_library(hsn_core)
