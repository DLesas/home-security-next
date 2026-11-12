add_executable(hsn_tests
  main.cpp
  support.cpp
  protocol/bytes_test.cpp
  protocol/counters_test.cpp
  protocol/framing_test.cpp
  protocol/messages_test.cpp
  protocol/packet_test.cpp
  protocol/radio_units_test.cpp
  protocol/random_test.cpp
  protocol/vectors_test.cpp
  device/device_support.cpp
  device/airtime_test.cpp
  device/device_runner_test.cpp
  device/log_record_test.cpp
  device/radio_port_test.cpp
  device/retry_random_test.cpp
  device/secure_channel_test.cpp
  device/setup_health_test.cpp
  device/time_test.cpp
  roles/skeletons_test.cpp
  host/probe_role.cpp
  host/script_sensor.cpp
  host/script_siren.cpp
  host/script_gateway.cpp
  host/medium_test.cpp
  host/simulation_test.cpp
  host/replay_window_test.cpp
  host/timeline_test.cpp
  host/test_hub_test.cpp
  host/test_hub_gateway_test.cpp
  host/readme_example_test.cpp
  host/hub_radio_test.cpp
  system/armed_door_test.cpp)
target_link_libraries(hsn_tests PRIVATE hsn_host hsn_role_sensor hsn_role_siren
  hsn_role_gateway hsn_doctest hsn_json)
target_include_directories(hsn_tests PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})
target_compile_definitions(hsn_tests PRIVATE
  HSN_VECTORS_DIR="${PROJECT_SOURCE_DIR}/../packages/protocol/vectors")
# Classes derived from device::Role must be built without RTTI, like the core that emits Role's
# vtable: with RTTI they would reference a typeinfo for Role that the core never defines.
file(GLOB hsn_sim_test_sources CONFIGURE_DEPENDS host/*.cpp system/*.cpp)
set_source_files_properties(device/device_runner_test.cpp ${hsn_sim_test_sources}
  PROPERTIES COMPILE_OPTIONS -fno-rtti)
hsn_warnings(hsn_tests)
hsn_sanitizers(hsn_tests)
add_test(NAME hsn_tests COMMAND hsn_tests)

# hsn_core must not reference the heap, exceptions or abort.
add_test(NAME core_symbols
  COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:hsn_core>
          -P ${PROJECT_SOURCE_DIR}/cmake/check_symbols.cmake)

# The same check must reject a library that allocates and throws.
add_library(hsn_symbol_probe STATIC EXCLUDE_FROM_ALL probes/symbol_probe.cpp)
add_test(NAME core_symbols_probe_build
  COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target hsn_symbol_probe)
set_tests_properties(core_symbols_probe_build PROPERTIES FIXTURES_SETUP symbol_probe)
add_test(NAME core_symbols_check_catches_violations
  COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:hsn_symbol_probe>
          -P ${PROJECT_SOURCE_DIR}/cmake/check_symbols.cmake)
# The pass condition is the expected violation report, not any failure: a broken script must
# not pass. CTest then ignores the exit code, which is non-zero by design.
set_tests_properties(core_symbols_check_catches_violations PROPERTIES
  PASS_REGULAR_EXPRESSION "references forbidden symbols:.*Znw.*cxa_throw"
  FIXTURES_REQUIRED symbol_probe)

# hsn_core sources use only allowed headers and constructs.
add_test(NAME core_sources
  COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${PROJECT_SOURCE_DIR}/core
          -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)

# Each role follows the same rules, includes only the core and itself, and references no heap,
# exception or abort symbols.
foreach(role sensor siren gateway)
  add_test(NAME role_${role}_sources
    COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${PROJECT_SOURCE_DIR}/roles/${role}
            -DOWN_PREFIX=hsn/roles/${role}/
            -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)
  add_test(NAME role_${role}_symbols
    COMMAND ${CMAKE_COMMAND} -DNM=${CMAKE_NM} -DLIBRARY=$<TARGET_FILE:hsn_role_${role}>
            -P ${PROJECT_SOURCE_DIR}/cmake/check_symbols.cmake)
endforeach()

# The role check must reject a role that includes another role, a platform header or the codec's
# private header.
add_test(NAME role_sources_check_catches_violations
  COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}/probes/role_rule_violation
          -DOWN_PREFIX=hsn/roles/sensor/
          -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)
set_tests_properties(role_sources_check_catches_violations PROPERTIES
  PASS_REGULAR_EXPRESSION
  "include \"codec.hpp\" is not allowed.*include \"hsn/psa/psa_packet_cipher.hpp\" is not allowed.*include \"hsn/roles/siren/siren_role.hpp\" is not allowed")

# The same check must reject a source that breaks the rules.
add_test(NAME core_sources_check_catches_violations
  COMMAND ${CMAKE_COMMAND} -DSOURCE_DIR=${CMAKE_CURRENT_SOURCE_DIR}/probes/core_rule_violation
          -P ${PROJECT_SOURCE_DIR}/cmake/check_core_sources.cmake)
set_tests_properties(core_sources_check_catches_violations PROPERTIES
  PASS_REGULAR_EXPRESSION "include <vector> is not allowed.*'double' is not allowed")

# A role missing one override must not compile (is_complete_role); the same role with every
# override must, so the failure has no other cause.
add_library(hsn_incomplete_role_probe STATIC EXCLUDE_FROM_ALL probes/incomplete_role/incomplete_role.cpp)
target_link_libraries(hsn_incomplete_role_probe PRIVATE hsn_core)
add_library(hsn_complete_role_probe STATIC EXCLUDE_FROM_ALL probes/incomplete_role/complete_role.cpp)
target_link_libraries(hsn_complete_role_probe PRIVATE hsn_core)
add_test(NAME role_complete_probe_builds
  COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target hsn_complete_role_probe)
add_test(NAME role_incomplete_probe_fails_to_compile
  COMMAND ${CMAKE_COMMAND} --build ${CMAKE_BINARY_DIR} --target hsn_incomplete_role_probe)
# The pass condition is the static_assert's message, not any failure; CTest then ignores the exit
# code, which is non-zero by design.
set_tests_properties(role_incomplete_probe_fails_to_compile PROPERTIES
  PASS_REGULAR_EXPRESSION "a role must override every Role method")
