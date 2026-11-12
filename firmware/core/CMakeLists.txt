# hsn_core: the portable protocol core. No heap, no exceptions, no platform includes.
add_library(hsn_core STATIC
  src/bytes.cpp
  src/counters.cpp
  src/framing.cpp
  src/messages.cpp
  src/packet.cpp
  src/radio.cpp
  src/setup.cpp
  src/units.cpp)
target_include_directories(hsn_core PUBLIC include)
hsn_firmware_library(hsn_core)
