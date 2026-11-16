# Shared test support, linked by every test executable: the doctest main (so each executable has
# exactly one), the codec helpers (support.hpp), the device-layer helpers (device_support.hpp),
# and the bench's scripted devices and probe role (sim_support.hpp).
add_library(hsn_test_support STATIC
  support/main.cpp
  support/support.cpp
  support/device_support.cpp
  support/probe_role.cpp
  support/script_sensor.cpp
  support/script_siren.cpp
  support/script_gateway.cpp)
target_include_directories(hsn_test_support PUBLIC support)
target_link_libraries(hsn_test_support PUBLIC hsn_host hsn_doctest hsn_json)
# Classes derived from device::Role must be built without RTTI, like the core that emits Role's
# vtable: with RTTI they would reference a typeinfo for Role that the core never defines.
set_source_files_properties(support/probe_role.cpp support/script_sensor.cpp
  support/script_siren.cpp support/script_gateway.cpp PROPERTIES COMPILE_OPTIONS -fno-rtti)
hsn_warnings(hsn_test_support)
hsn_sanitizers(hsn_test_support)

# A doctest executable on the support library, registered with CTest under its own name.
function(hsn_test_executable target)
  add_executable(${target} ${ARGN})
  target_link_libraries(${target} PRIVATE hsn_test_support)
  hsn_warnings(${target})
  hsn_sanitizers(${target})
  add_test(NAME ${target} COMMAND ${target})
endfunction()

# The codec, device-layer, bench and scripted system tests. No role library: a half-written role
# cannot break them.
hsn_test_executable(hsn_tests
  protocol/bytes_test.cpp
  protocol/counters_test.cpp
  protocol/framing_test.cpp
  protocol/messages_test.cpp
  protocol/packet_test.cpp
  protocol/radio_units_test.cpp
  protocol/random_test.cpp
  protocol/vectors_test.cpp
  device/airtime_test.cpp
  device/device_runner_test.cpp
  device/log_record_test.cpp
  device/radio_port_test.cpp
  device/retry_random_test.cpp
  device/secure_channel_test.cpp
  device/setup_health_test.cpp
  device/time_test.cpp
  host/fake_link_test.cpp
  host/medium_test.cpp
  host/simulation_test.cpp
  host/replay_window_test.cpp
  host/timeline_test.cpp
  host/test_hub_test.cpp
  host/test_hub_gateway_test.cpp
  host/test_hub_log_test.cpp
  host/test_hub_move_test.cpp
  host/readme_example_test.cpp
  host/hub_radio_test.cpp
  host/real_time_test.cpp
  host/pty_link_test.cpp
  host/bench_json_test.cpp
  host/bench_script_test.cpp
  host/restart_links_test.cpp
  host/wire_json_test.cpp
  system/armed_door_test.cpp)
target_compile_definitions(hsn_tests PRIVATE
  HSN_VECTORS_DIR="${PROJECT_SOURCE_DIR}/../packages/protocol/vectors")
file(GLOB hsn_sim_test_sources CONFIGURE_DEPENDS host/*.cpp system/*.cpp)
set_source_files_properties(device/device_runner_test.cpp ${hsn_sim_test_sources}
  PROPERTIES COMPILE_OPTIONS -fno-rtti)

# A short real-time run of the bench executable, hsn_bench, with no hub: its own executable, since
# it spawns the program and talks to it over pseudo-terminals.
hsn_test_executable(hsn_bench_run_tests host/bench_run_test.cpp)
target_compile_definitions(hsn_bench_run_tests PRIVATE HSN_BENCH_PATH="$<TARGET_FILE:hsn_bench>")
add_dependencies(hsn_bench_run_tests hsn_bench)

# One executable per role, hsn_role_<role>_tests: every .cpp under tests/roles/<role>/, against
# that role's library only, so its owner adds files without editing this file and another role's
# state cannot break it. Every file builds a role, so all are compiled without RTTI.
foreach(role sensor siren gateway)
  file(GLOB_RECURSE hsn_role_test_sources CONFIGURE_DEPENDS
    ${CMAKE_CURRENT_SOURCE_DIR}/roles/${role}/*.cpp)
  if(NOT hsn_role_test_sources)
    message(FATAL_ERROR "tests/roles/${role}/ has no .cpp files")
  endif()
  hsn_test_executable(hsn_role_${role}_tests ${hsn_role_test_sources})
  target_link_libraries(hsn_role_${role}_tests PRIVATE hsn_role_${role} hsn_host)
  target_compile_options(hsn_role_${role}_tests PRIVATE -fno-rtti)
endforeach()

# Whole-system tests with the real roles, hsn_system_tests: every .cpp in tests/system_roles/,
# against all three role libraries. Created only once that folder has sources.
file(GLOB hsn_system_role_sources CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/system_roles/*.cpp)
if(hsn_system_role_sources)
  hsn_test_executable(hsn_system_tests ${hsn_system_role_sources})
  target_link_libraries(hsn_system_tests PRIVATE hsn_role_sensor hsn_role_siren hsn_role_gateway
    hsn_host)
  target_compile_options(hsn_system_tests PRIVATE -fno-rtti)
endif()

# Lockstep against the real hub (hub-design.md section 11, "Lockstep"): the recorded sessions
# replayed from C++, and the system tests run on the real hub. They need Bun and the hub's
# sources with their packages installed, so they are their own group (label "lockstep", run alone
# with `bun run check:firmware:lockstep` at the repository's root); without them the group is one
# test that is skipped and says why.
find_program(HSN_BUN bun)
set(HSN_HUB_MAIN ${PROJECT_SOURCE_DIR}/../hub/src/shell/main.ts)
set(HSN_LOCKSTEP_SESSIONS ${PROJECT_SOURCE_DIR}/../hub/test/lockstep)
set(hsn_lockstep_missing "")
if(NOT HSN_BUN)
  set(hsn_lockstep_missing "Bun was not found")
elseif(NOT EXISTS ${HSN_HUB_MAIN} OR NOT EXISTS ${HSN_LOCKSTEP_SESSIONS})
  set(hsn_lockstep_missing "the hub's sources are not beside the firmware (../hub)")
elseif(NOT EXISTS ${PROJECT_SOURCE_DIR}/../node_modules)
  set(hsn_lockstep_missing "the hub's packages are not installed (bun install at the root)")
endif()
if(hsn_lockstep_missing STREQUAL "")
  hsn_test_executable(hsn_lockstep_tests lockstep/session_replay_test.cpp
    lockstep/socket_test.cpp)
  target_include_directories(hsn_lockstep_tests PRIVATE lockstep)
  target_compile_definitions(hsn_lockstep_tests PRIVATE HSN_BUN="${HSN_BUN}"
    HSN_HUB_MAIN="${HSN_HUB_MAIN}" HSN_LOCKSTEP_SESSIONS="${HSN_LOCKSTEP_SESSIONS}"
    HSN_FAKE_HUB="${CMAKE_CURRENT_SOURCE_DIR}/lockstep/fake_hub.ts")
  set_tests_properties(hsn_lockstep_tests PROPERTIES LABELS lockstep)
  # The system tests section 11 lists, on the real hub: the same sources as hsn_system_tests.
  hsn_test_executable(hsn_system_lockstep_tests system_roles/chain_test.cpp
    system_roles/restarts_test.cpp system_roles/lost_path_test.cpp
    system_roles/two_gateways_test.cpp system_roles/sirens_test.cpp
    system_roles/interference_test.cpp system_roles/heartbeat_reply_test.cpp
    system_roles/load_test.cpp system_roles/site_move_test.cpp
    system_roles/group_sirens_test.cpp system_roles/schedule_arm_test.cpp
    lockstep/real_hub_test.cpp)
  target_include_directories(hsn_system_lockstep_tests PRIVATE lockstep system_roles)
  target_compile_definitions(hsn_system_lockstep_tests PRIVATE HSN_LOCKSTEP=1 HSN_BUN="${HSN_BUN}"
    HSN_HUB_MAIN="${HSN_HUB_MAIN}")
  target_link_libraries(hsn_system_lockstep_tests PRIVATE hsn_role_sensor hsn_role_siren
    hsn_role_gateway hsn_host)
  target_compile_options(hsn_system_lockstep_tests PRIVATE -fno-rtti)
  set_tests_properties(hsn_system_lockstep_tests PROPERTIES LABELS lockstep)
  # The scripted devices' scenarios section 11 lists, on the real hub.
  hsn_test_executable(hsn_lockstep_scripted_tests system/armed_door_test.cpp
    host/test_hub_gateway_test.cpp)
  target_include_directories(hsn_lockstep_scripted_tests PRIVATE lockstep)
  target_compile_definitions(hsn_lockstep_scripted_tests PRIVATE HSN_LOCKSTEP=1
    HSN_BUN="${HSN_BUN}" HSN_HUB_MAIN="${HSN_HUB_MAIN}")
  target_compile_options(hsn_lockstep_scripted_tests PRIVATE -fno-rtti)
  set_tests_properties(hsn_lockstep_scripted_tests PROPERTIES LABELS lockstep)
  # The same cases (the day-long ones aside) with the hub taking 30 ms, the budget's commit
  # time, before each frame leaves it (RemoteHub::send_delay; 10 ms otherwise).
  add_test(NAME hsn_system_lockstep_tests_30ms COMMAND hsn_system_lockstep_tests -tse=long)
  set_tests_properties(hsn_system_lockstep_tests_30ms PROPERTIES LABELS lockstep
    ENVIRONMENT HSN_HUB_DELAY_MS=30)
else()
  message(STATUS "Lockstep tests against the real hub skipped: ${hsn_lockstep_missing}")
  add_test(NAME hsn_lockstep_tests
    COMMAND ${CMAKE_COMMAND} -E echo "lockstep tests skipped: ${hsn_lockstep_missing}")
  set_tests_properties(hsn_lockstep_tests PROPERTIES LABELS lockstep
    SKIP_REGULAR_EXPRESSION "lockstep tests skipped")
endif()

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
