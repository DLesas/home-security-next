# hsn_psa: the packet cipher on PSA Crypto. Only public PSA headers, so the same file builds
# against ESP-IDF v6.1's Mbed TLS 4.1.
add_library(hsn_psa STATIC src/hub_identity.cpp src/psa_packet_cipher.cpp)
target_include_directories(hsn_psa PUBLIC include)
target_link_libraries(hsn_psa PUBLIC hsn_core tfpsacrypto)
hsn_firmware_library(hsn_psa)
