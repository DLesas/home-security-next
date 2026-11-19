# The peripheral, with ESP-IDF's stock protocomm transport for pairing.
idf_component_register(
  SRCS bluetooth.cpp pairing_logic.cpp pairing_srp.cpp
  INCLUDE_DIRS include
  PRIV_INCLUDE_DIRS ../components/hsn_esp/include
  REQUIRES hsn_firmware bt protocomm esp_event
  PRIV_REQUIRES esp_timer heap)

target_compile_options(${COMPONENT_LIB} PRIVATE
  -Wall -Wextra -Wshadow -Wunused-parameter -Wconversion -Wsign-conversion -Werror=extra -Werror)

# The public SRP generator omits the actual length of its minimally encoded salt.
# Protocomm restarts its advertised service on disconnect. Suppress that at our window cutoff.
target_link_libraries(${COMPONENT_LIB} INTERFACE
  "-Wl,--wrap=esp_mpi_to_bin" "-Wl,--wrap=ble_gap_adv_start")

# Keep password and session dumps out of even the verbose bring-up configuration.
idf_component_get_property(protocomm_target protocomm COMPONENT_LIB)
target_compile_definitions(${protocomm_target} PRIVATE LOG_LOCAL_LEVEL=ESP_LOG_INFO)
