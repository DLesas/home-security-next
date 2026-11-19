# hsn_psa: the packet cipher, the update crypto and the device key import on PSA Crypto. Only
# public PSA headers, so the same files build against ESP-IDF v6.1's Mbed TLS 4.1.
add_library(hsn_psa STATIC src/hub_identity.cpp src/psa_packet_cipher.cpp src/psa_keys.cpp
  src/psa_update_crypto.cpp src/fault_injection.cpp)
target_include_directories(hsn_psa PUBLIC include)
target_link_libraries(hsn_psa PUBLIC hsn_core tfpsacrypto)
# The host build can make any PSA call fail (src/psa_call.hpp); the target's build does not define
# this, and src/fault_injection.cpp is then empty.
target_compile_definitions(hsn_psa PUBLIC HSN_PSA_FAULT_INJECTION=1)
hsn_firmware_library(hsn_psa)
